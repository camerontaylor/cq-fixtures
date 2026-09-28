import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compileContainerBoundary } from './container.ts';
import type { ContainerBoundarySpec } from './container.ts';

const execute = promisify(execFile);
const host = `unix://${join(homedir(), '.colima/cq-boundary-s5/docker.sock')}`;
const environment = { HOME: homedir(), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
async function docker(args: string[]) {
  const { stdout } = await execute('/usr/local/bin/docker', ['--host', host, ...args],
    { timeout: 30_000, maxBuffer: 256 * 1024, env: environment });
  return stdout.trim();
}
interface Volume { Driver: string; Options: Record<string, string> | null; Labels: Record<string, string> | null }
interface Network { Internal: boolean; EnableIPv6: boolean; IPAM: { Config: Array<{ Subnet?: string }> }; Containers: Record<string, { IPv4Address: string }> }
interface Image { Id: string; RepoDigests: string[] | null; Config: { Env: string[] } }
interface Container { State: { Running: boolean; Pid: number }; HostConfig: { Privileged: boolean; PidMode: string; CapDrop: string[]; SecurityOpt: string[]; ReadonlyRootfs: boolean }; Mounts: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }> }

/** Trusted host-side adapter. Volumes must already have been staged and labeled by
 * the native/task owner; no host directory ever enters a docker bind mount.
 * Each worker gets a fresh container. Named task volume must be exclusive per run.
 */
export function containerPreparer(specification: ContainerBoundarySpec) {
  const policy = compileContainerBoundary(specification);
  return async (args: string[], identity: string) => {
    if (identity !== policy.identity || JSON.stringify(args) !== JSON.stringify(policy.createArgs)) throw new Error('prepare recipe changed');
    const vmConfig = readFileSync(join(homedir(), '.colima/_lima/colima-cq-boundary-s5/lima.yaml'));
    if (createHash('sha256').update(vmConfig).digest('hex') !== policy.spec.vmConfigHash ||
        /\nmounts:|forwardAgent: true/.test(vmConfig.toString())) throw new Error('dedicated VM config changed or host mounts enabled');
    if (await docker(['info', '--format', '{{.ID}}']) !== policy.spec.daemonId) throw new Error('dedicated daemon changed');
    const image = JSON.parse(await docker(['image', 'inspect', policy.spec.image]))[0] as Image;
    if (policy.spec.image.startsWith('sha256:') ? image.Id !== policy.spec.image : !image.RepoDigests?.includes(policy.spec.image)) throw new Error('image content pin changed');
    if (image.Config.Env.some((pair) => /^(NODE_|LD_|DYLD_|BASH_ENV=|ENV=|DOCKER_|.*TOKEN=|.*KEY=|.*SECRET=)/.test(pair) && !pair.startsWith('NODE_VERSION='))) {
      throw new Error('image contains undeclared loader/credential environment');
    }
    for (const [name, kind] of [[policy.spec.taskVolume, 'task'], [policy.spec.contextVolume, 'context']]) {
      const volume = JSON.parse(await docker(['volume', 'inspect', name]))[0] as Volume;
      if (volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length ||
          volume.Labels?.['cq.boundary.staging'] !== policy.spec.stagingEvidence || volume.Labels?.['cq.boundary.kind'] !== kind) {
        throw new Error('volume lacks matching explicit staging receipt or uses host/device mount options');
      }
    }
    const network = JSON.parse(await docker(['network', 'inspect', policy.spec.network.name]))[0] as Network;
    const subnet = policy.spec.network.workerIP.split('.').slice(0, 3).join('.') + '.0/24';
    if (!network.Internal || network.EnableIPv6 || network.IPAM.Config.length !== 1 || network.IPAM.Config[0].Subnet !== subnet ||
        !Object.values(network.Containers).some((c) => c.IPv4Address === policy.spec.network.brokerIP + '/24')) {
      throw new Error('dedicated internal network or live broker attachment unverified');
    }
    let containerId: string | null = null;
    const dispose = async () => { if (containerId) await docker(['rm', '-f', containerId]); };
    try {
      // Explicit entrypoint overrides any image autoload/entrypoint. No task code runs
      // until namespace ACLs have been installed and read back through the VM admin.
      containerId = await docker([...args.slice(2), '--entrypoint', '/usr/local/bin/node', policy.spec.image, '-e', 'setInterval(()=>{},10000)']);
      if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('invalid fresh container ID');
      await docker(['start', containerId]);
      const container = JSON.parse(await docker(['inspect', containerId]))[0] as Container;
      if (!container.State.Running || container.State.Pid <= 1 || container.HostConfig.Privileged || container.HostConfig.PidMode ||
          !container.HostConfig.ReadonlyRootfs || !container.HostConfig.CapDrop.includes('ALL') ||
          !container.HostConfig.SecurityOpt.includes('no-new-privileges') || container.Mounts.length !== 2 ||
          container.Mounts.some((m) => m.Type !== 'volume' ||
            !((m.Name === policy.spec.taskVolume && m.Destination === '/task' && m.RW) ||
              (m.Name === policy.spec.contextVolume && m.Destination === '/context' && !m.RW)))) throw new Error('live container isolation differs from recipe');
      const script = readFileSync(fileURLToPath(new URL('./namespace-acl.sh', import.meta.url)), 'utf8');
      // execFile cannot feed stdin; the fixed script is passed as one shell argument,
      // positional values stay separately quoted by execFile/Colima's argument layer.
      const { stdout } = await execute('/usr/local/bin/colima', ['-p', 'cq-boundary-s5', 'ssh', '--', 'sudo', 'sh', '-c', script,
        'cq-acl', String(container.State.Pid), policy.spec.network.brokerIP, String(policy.spec.network.port)],
      { timeout: 30_000, maxBuffer: 128 * 1024, env: environment });
      const rules = stdout;
      const outgoing = rules.split('\n').filter((line) => line.startsWith('-A OUTPUT '));
      const incoming = rules.split('\n').filter((line) => line.startsWith('-A INPUT '));
      if ((rules.match(/:OUTPUT DROP/g) ?? []).length !== 2 || (rules.match(/:INPUT DROP/g) ?? []).length !== 2 ||
          outgoing.length !== 1 || incoming.length !== 1 || !outgoing[0].includes(`-d ${policy.spec.network.brokerIP}/32`) ||
          !outgoing[0].includes(`--dport ${policy.spec.network.port}`) || !outgoing[0].endsWith('-j ACCEPT') ||
          !incoming[0].includes(`-s ${policy.spec.network.brokerIP}/32`) || !incoming[0].includes(`--sport ${policy.spec.network.port}`)) {
        throw new Error('read-back namespace ACL mismatch');
      }
      return { containerId, identity, aclVerified: true, aclHash: createHash('sha256').update(rules).digest('hex'), dispose };
    } catch (error) { await dispose(); throw error; }
  };
}
