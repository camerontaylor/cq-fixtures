import { compileBroker } from './egress-broker.ts';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerControl, teardownContainer } from './docker-control.ts';
import { verifyStageVolumes } from './task-staging.ts';
import type { TaskStageReceipt } from './task-staging.ts';
import { promisify } from 'node:util';
import { compileContainerBoundary } from './container.ts';
import type { ContainerBoundarySpec } from './container.ts';

const execute = promisify(execFile);
const environment = { HOME: homedir(), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
interface Network { Internal: boolean; EnableIPv6: boolean; IPAM: { Config: Array<{ Subnet?: string }> }; Containers: Record<string, { IPv4Address: string }> }
interface Image { Id: string; RepoDigests: string[] | null; Config: { Env: string[] } }
interface Container { State: { Running: boolean; Pid: number }; HostConfig: { Privileged: boolean; PidMode: string; CapDrop: string[]; SecurityOpt: string[]; ReadonlyRootfs: boolean }; Mounts: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }> }

/** Trusted host-side adapter. Volumes must already have been staged and labeled by
 * the native/task owner; no host directory ever enters a docker bind mount.
 * Each worker gets a fresh container. Named task volume must be exclusive per run.
 */
export function containerPreparer(specification: ContainerBoundarySpec, stagingInput?: TaskStageReceipt,
  brokerInput?: { containerId: string; imageId: string; configPath: string }) {
  const policy = compileContainerBoundary(specification);
  const staging = structuredClone(stagingInput);
  const broker = structuredClone(brokerInput);
  return async (args: string[], identity: string) => {
    if (!staging || !broker) throw new Error('private staging inventory and live broker receipt required');
    if (staging.receiptHash !== policy.spec.stagingEvidence || staging.taskVolume !== policy.spec.taskVolume || staging.contextVolume !== policy.spec.contextVolume || staging.daemonId !== policy.spec.daemonId) throw new Error('intended task identity mismatch');
    const control = new DockerControl();
    const docker = (args: string[]) => control.run(args);
    try {
      if (identity !== policy.identity || JSON.stringify(args) !== JSON.stringify(policy.createArgs)) throw new Error('prepare recipe changed');
      const vmConfig = readFileSync(join(homedir(), '.colima/_lima/colima-cq-boundary-s5/lima.yaml'));
      if (createHash('sha256').update(vmConfig).digest('hex') !== policy.spec.vmConfigHash ||
          /\nmounts:|forwardAgent: true/.test(vmConfig.toString())) throw new Error('dedicated VM config changed or host mounts enabled');
      if (await docker(['info', '--format', '{{.ID}}']) !== policy.spec.daemonId) throw new Error('dedicated daemon changed');
      const image = JSON.parse(await docker(['image', 'inspect', policy.spec.image]))[0] as Image;
      if (policy.spec.image.startsWith('sha256:') ? image.Id !== policy.spec.image : !image.RepoDigests?.includes(policy.spec.image)) throw new Error('image content pin changed');
      if (image.Config.Env.some((pair) => !['PATH', 'NODE_VERSION', 'YARN_VERSION', 'LANG'].includes(pair.split('=')[0]))) {
        throw new Error('image contains undeclared loader/credential environment');
      }
      await verifyStageVolumes(control, staging);
      if (!/^[a-f0-9]{64}$/.test(broker.containerId) || !/^sha256:[a-f0-9]{64}$/.test(broker.imageId) || broker.configPath !== '/opt/config.json') throw new Error('fixed broker content receipt required');
      const liveBroker = JSON.parse(await docker(['inspect', broker.containerId]))[0];
      if (!liveBroker.State.Running || liveBroker.Image !== broker.imageId || liveBroker.Config.Labels?.['cq.boundary.broker'] !== policy.spec.network.brokerIdentity) throw new Error('live broker image or identity mismatch');
      const brokerConfig = JSON.parse(await docker(['exec', broker.containerId, '/usr/local/bin/node', '-e', "process.stdout.write(require('node:fs').readFileSync('/opt/config.json'))"]));
      if (compileBroker(brokerConfig).identity !== policy.spec.network.brokerIdentity) throw new Error('live broker config identity mismatch');
      const network = JSON.parse(await docker(['network', 'inspect', policy.spec.network.name]))[0] as Network;
      const subnet = policy.spec.network.workerIP.split('.').slice(0, 3).join('.') + '.0/24';
      if (!network.Internal || network.EnableIPv6 || network.IPAM.Config.length !== 1 || network.IPAM.Config[0].Subnet !== subnet ||
          network.Containers[broker.containerId]?.IPv4Address !== policy.spec.network.brokerIP + '/24') {
        throw new Error('dedicated internal network or live broker attachment unverified');
      }
      let containerId: string | null = null;
      let disposition: Promise<void> | undefined;
      const dispose = () => disposition ??= (async () => { if (containerId) await teardownContainer(control, containerId); control.close(); })();
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
        const canonical = rules.split('\n').filter((line) => line.startsWith(':') || line.startsWith('-A ')).map((line) => line.replace(/ \[\d+:\d+\]$/, ''));
        const expected = [':INPUT DROP', ':FORWARD DROP', ':OUTPUT DROP',
          `-A INPUT -s ${policy.spec.network.brokerIP}/32 -p tcp -m tcp --sport ${policy.spec.network.port} -m conntrack --ctstate ESTABLISHED -j ACCEPT`,
          `-A OUTPUT -d ${policy.spec.network.brokerIP}/32 -p tcp -m tcp --dport ${policy.spec.network.port} -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT`,
          ':INPUT DROP', ':FORWARD DROP', ':OUTPUT DROP'];
        if (JSON.stringify(canonical) !== JSON.stringify(expected)) throw new Error('read-back complete namespace ACL mismatch');
        return { containerId, identity, aclVerified: true, aclHash: createHash('sha256').update(rules).digest('hex'), dispose };
      } catch (error) { await dispose(); throw error; }
    } catch (error) { control.close(); throw error; }
  };
}
