import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ContainerBoundarySpec {
  profile: 'cq-boundary-s5';
  daemonId: string;
  vmConfigHash: string;
  /** Content-pinned Linux toolchain image, with no baked credentials or hidden data. */
  image: string;
  taskVolume: string;
  contextVolume: string;
  stagingEvidence: string;
  /** Relative exact files in /context; native owner stages later, no home grants. */
  authenticationFiles: string[];
  nativeControlEvidence: string | null;
  network: { name: string; workerIP: string; brokerIP: string; port: number; brokerIdentity: string; productionEligible: boolean };
  namespaceEvidence: string;
}
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^cq-s5-[a-z0-9-]{1,50}$/;
function privateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 && parts[3] > 1 && parts[3] < 255;
}

export function compileContainerBoundary(input: ContainerBoundarySpec) {
  const spec = structuredClone(input);
  if (spec.profile !== 'cq-boundary-s5' || !spec.daemonId.trim() || !HASH.test(spec.vmConfigHash) ||
      !/^(?:[a-z0-9./_-]+@)?sha256:[a-f0-9]{64}$/.test(spec.image) || !NAME.test(spec.taskVolume) ||
      !NAME.test(spec.contextVolume) || spec.taskVolume === spec.contextVolume || !spec.stagingEvidence.trim() ||
      !spec.namespaceEvidence.trim() || !NAME.test(spec.network.name) || !privateIP(spec.network.workerIP) ||
      !privateIP(spec.network.brokerIP) || spec.network.workerIP === spec.network.brokerIP ||
      spec.network.workerIP.split('.').slice(0, 3).join('.') !== spec.network.brokerIP.split('.').slice(0, 3).join('.') ||
      !Number.isInteger(spec.network.port) || spec.network.port < 1024 || spec.network.port > 65535 ||
      !HASH.test(spec.network.brokerIdentity) || typeof spec.network.productionEligible !== 'boolean' ||
      new Set(spec.authenticationFiles).size !== spec.authenticationFiles.length ||
      spec.authenticationFiles.some((file) => !/^[a-zA-Z0-9._/-]+$/.test(file) || file.startsWith('/') || file.split('/').some((p) => !p || p === '..' || p === '.'))) {
    throw new Error('dedicated content-pinned namespace, staging and broker inventory required');
  }
  const identity = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  const createArgs = ['--host', `unix://${join(homedir(), '.colima/cq-boundary-s5/docker.sock')}`, 'create', '--label', `cq.boundary.identity=${identity}`,
    '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--memory', '768m', '--memory-swap', '768m', '--cpus', '1',
    '--cgroupns', 'private', '--ipc', 'private', '--network', spec.network.name, '--ip', spec.network.workerIP,
    '--dns', '127.0.0.1', '--no-healthcheck', '--workdir', '/task',
    '--mount', `type=volume,source=${spec.taskVolume},target=/task`,
    '--mount', `type=volume,source=${spec.contextVolume},target=/context,readonly`,
    '--tmpfs', '/home/worker:rw,nosuid,nodev,noexec,uid=1000,gid=1000,size=32m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,uid=1000,gid=1000,size=128m',
    '--env', 'HOME=/home/worker', '--env', 'XDG_CONFIG_HOME=/home/worker/.config',
    '--env', 'XDG_DATA_HOME=/home/worker/.local/share', '--env', 'TMPDIR=/tmp',
    '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'LANG=C.UTF-8'];
  return { spec, identity, createArgs, heldOutEligible: false as const };
}

export interface ContainerLaunch {
  boundary: ReturnType<typeof compileContainerBoundary>;
  /** Absolute executable inside the content-pinned image, native owner must inventory/hash it. */
  executable: string;
  args: string[];
  purpose: 'no-model-probe' | 'actual-route';
  heldOut: boolean;
  admit?: (identity: string) => Promise<{ admissionId: string }>;
  /** Trusted VM supervisor creates dormant container, installs/reads back namespace ACLs,
   * checks live daemon/image/volume inventories, then starts its harmless gate process.
   * Receipt must bind this specific container ID and boundary identity. */
  prepare: (createArgs: string[], identity: string) => Promise<{ containerId: string; identity: string; aclVerified: boolean; dispose: () => Promise<void> }>;
}

/** Spawn seam only. Native owner retains transport/protocol/events and bounded cleanup.
 * This candidate never claims G2 or permits held-out work from synthetic evidence.
 */
export async function spawnContainerBoundary(request: ContainerLaunch): Promise<{
  child: ChildProcessWithoutNullStreams; containerId: string; boundaryIdentity: string; admissionId: string | null;
  launchIdentity: string; dispose: () => Promise<void>;
}> {
  const policy = compileContainerBoundary(request.boundary.spec);
  if (policy.identity !== request.boundary.identity) throw new Error('container identity changed');
  if (request.heldOut) throw new Error('actual-route G2 and native auth/tool controls remain unverified');
  if (!/^\/(?:usr\/local\/bin|usr\/bin|bin)\/[a-zA-Z0-9._-]+$/.test(request.executable)) throw new Error('absolute inventoried image executable required');
  const args = [...request.args];
  const executable = request.executable;
  const prepare = request.prepare;
  if (!['no-model-probe', 'actual-route'].includes(request.purpose)) throw new Error('undeclared purpose');
  let admissionId: string | null = null;
  if (request.purpose === 'actual-route') {
    if (!policy.spec.nativeControlEvidence?.trim() || !request.admit) throw new Error('native controls and orchestrator admission required');
    if (!policy.spec.network.productionEligible) throw new Error('synthetic broker cannot admit actual routes');
    const receipt = await request.admit(policy.identity);
    if (!receipt.admissionId.trim()) throw new Error('empty admission receipt');
    admissionId = receipt.admissionId;
  } else if (policy.spec.authenticationFiles.length || policy.spec.network.productionEligible) {
    throw new Error('no-model probes require absent auth and synthetic-only broker');
  }
  const prepared = await prepare([...policy.createArgs], policy.identity);
  if (!/^[a-f0-9]{64}$/.test(prepared.containerId) || prepared.identity !== policy.identity || !prepared.aclVerified) {
    await prepared.dispose();
    throw new Error('specific live container namespace ACL receipt required');
  }
  const launchIdentity = createHash('sha256').update(JSON.stringify({ boundary: policy.identity, container: prepared.containerId, executable, args })).digest('hex');
  const child = spawn('/usr/local/bin/docker', ['--host', `unix://${join(homedir(), '.colima/cq-boundary-s5/docker.sock')}`, 'exec', '-i', '--user', '1000:1000',
    '--workdir', '/task', prepared.containerId, executable, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    // Do not inherit Docker endpoint, plugin or telemetry overrides. The host daemon
    // socket is used by the trusted supervisor only, and never mounted in workers.
    env: { HOME: homedir(), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  return { child, containerId: prepared.containerId, boundaryIdentity: policy.identity, launchIdentity, admissionId, dispose: prepared.dispose };
}
