/** Trusted parent runtime factory. No model dispatch; approval is a separate parent file. */
import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, closeSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const hash = value => createHash('sha256').update(value).digest('hex');
function privateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) || s.size > 1024 * 1024) throw new Error('private control file unavailable'); return JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
const save = (path, data) => writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
export async function createPreparedFinalG1Runtime(plan, { verify = true } = {}) {
  const root = resolve(plan.repoRoot), privateRoot = resolve(plan.privateRoot);
  const load = relative => import(pathToFileURL(join(root, relative)).href);
  const [{ DockerControl, teardownContainer }, profile, staging, { compileContainerBoundary }, { compileBroker }] = await Promise.all([
    load('runner/boundary/docker-control.ts'), load('runner/boundary/codex-final-profile.ts'), load('runner/boundary/task-staging.ts'), load('runner/boundary/container.ts'), load('runner/boundary/egress-broker.ts'),
  ]);
  const statePath = join(privateRoot, 'setup-state.json');
  const state = privateJson(statePath);
  if (state.authRoot !== plan.privateAuthRoot || state.network !== plan.network || state.broker.containerId !== plan.brokerContainerId) throw new Error('private infrastructure plan changed');
  const pins = JSON.parse(readFileSync(join(root, 'runner/boundary/evidence/fallback/final-profile-public-inputs.json'), 'utf8'));
  const assignmentId = 'final-profile-g1-' + plan.runId, attemptId = assignmentId + '-attempt-1';
  let used = false, expected;
  if (hash(JSON.stringify(plan)) !== privateJson(join(privateRoot, 'plan-hash.json')).sha256) throw new Error('private runtime plan changed');
  async function verifySources() {
    if (hash(readFileSync(plan.runtimeSource)) !== plan.runtimeSourceSha256 || hash(readFileSync(join(root, 'runner/boundary/evidence/fallback/final-profile-public-inputs.json'))) !== plan.publicInputsSha256) throw new Error('reviewed runtime/public inputs changed');
    for (const [path, digest] of Object.entries(plan.sourcePins)) if (hash(readFileSync(join(root, path))) !== digest) throw new Error('reviewed G1 source changed');
  }
  async function verifyInfrastructure() {
    await verifySources(); const c = new DockerControl();
    try {
      if (await c.run(['info', '--format', '{{.ID}}']) !== pins.daemon.id || hash(readFileSync(pins.vm.configPath)) !== pins.vm.configHash) throw new Error('pinned daemon/VM changed');
      for (const image of [pins.workerImage, pins.brokerImage, plan.utilityImage]) if (JSON.parse(await c.run(['image', 'inspect', image]))[0].Id !== image) throw new Error('pinned image unavailable');
      const broker = JSON.parse(await c.run(['inspect', state.broker.containerId]))[0];
      if (!broker.State.Running || broker.Image !== pins.brokerImage || broker.Config.Labels?.['cq.boundary.broker'] !== pins.brokerIdentity || broker.Config.Labels?.['cq.boundary.runtime'] !== plan.runId || broker.Mounts.length || broker.HostConfig.Privileged || broker.HostConfig.PidMode || !broker.HostConfig.ReadonlyRootfs || broker.HostConfig.PortBindings && Object.keys(broker.HostConfig.PortBindings).length) throw new Error('private broker inventory changed');
      const config = JSON.parse(await c.run(['exec', state.broker.containerId, '/usr/local/bin/node', '-e', "process.stdout.write(require('fs').readFileSync('/opt/config.json'))"]));
      if (compileBroker(config).identity !== pins.brokerIdentity) throw new Error('broker exact route identity changed');
      const network = JSON.parse(await c.run(['network', 'inspect', state.network]))[0];
      if (!network.Internal || network.EnableIPv6 || network.Labels?.['cq.boundary.runtime'] !== plan.runId || network.IPAM.Config.length !== 1 || network.IPAM.Config[0].Subnet !== pins.network.internalSubnet || network.Containers[state.broker.containerId]?.IPv4Address !== pins.network.brokerIP + '/24' || Object.keys(network.Containers).some(id => id !== state.broker.containerId)) throw new Error('private namespace network changed');
      if (hash(readFileSync(join(state.authRoot, 'payload/config.toml'))) !== pins.nativeConfigHash) throw new Error('native config changed');
      profile.validateFinalCodexAuth(readFileSync(join(state.authRoot, 'payload/auth.json'), 'utf8'), 240);
    } finally { c.close(); }
  }
  async function cleanup({ removeRecovery = false } = {}) {
    const latest = privateJson(statePath), c = new DockerControl();
    if (latest.authRoot !== plan.privateAuthRoot || latest.network !== plan.network || latest.broker.containerId !== plan.brokerContainerId || latest.stage && (!/^cq-s5-task-[a-f0-9]{16}$/.test(latest.stage.taskVolume) || !/^cq-s5-context-[a-f0-9]{16}$/.test(latest.stage.contextVolume) || !/^[a-f0-9]{64}$/.test(latest.stage.receiptHash))) { c.close(); throw new Error('private setup ownership record changed'); }
    try {
      if (await c.run(['info', '--format', '{{.ID}}']) !== pins.daemon.id) throw new Error('cleanup daemon changed');
      if (latest.stage) {
        const ids = (await c.run(['ps', '-aq', '--no-trunc', '--filter', 'volume=' + latest.stage.taskVolume])).split('\n').filter(Boolean);
        for (const id of ids) {
          const worker = JSON.parse(await c.run(['inspect', id]))[0];
          if (worker.Image !== pins.workerImage || worker.Config.Labels?.['cq.boundary.identity'] !== latest.boundaryIdentity || !worker.Mounts.some(m => m.Name === latest.stage.taskVolume && m.Destination === '/task')) throw new Error('cleanup worker ownership changed');
          await teardownContainer(c, id);
        }
        if (!latest.handedOff || removeRecovery) for (const volume of [latest.stage.taskVolume, latest.stage.contextVolume]) {
          if (!(await c.run(['volume', 'ls', '-q'])).split('\n').includes(volume)) continue;
          const v = JSON.parse(await c.run(['volume', 'inspect', volume]))[0];
          if (v.Labels?.['cq.boundary.staging'] !== latest.stage.receiptHash || await c.run(['ps', '-aq', '--filter', 'volume=' + volume])) throw new Error('cleanup volume ownership changed');
          await c.run(['volume', 'rm', volume]);
        }
      }
      if (await c.run(['ps', '-aq', '--no-trunc', '--filter', 'id=' + latest.broker.containerId])) {
        const broker = JSON.parse(await c.run(['inspect', latest.broker.containerId]))[0];
        if (broker.Config.Labels?.['cq.boundary.runtime'] !== plan.runId || broker.Config.Labels?.['cq.boundary.broker'] !== pins.brokerIdentity) throw new Error('cleanup broker ownership changed');
        await teardownContainer(c, latest.broker.containerId);
      }
      if ((await c.run(['network', 'ls', '--format', '{{.Name}}'])).split('\n').includes(latest.network)) {
        const n = JSON.parse(await c.run(['network', 'inspect', latest.network]))[0];
        if (n.Labels?.['cq.boundary.runtime'] !== plan.runId || Object.keys(n.Containers).length) throw new Error('cleanup network ownership changed');
        await c.run(['network', 'rm', latest.network]);
      }
      if (!latest.handedOff || removeRecovery) rmSync(latest.authRoot, { recursive: true, force: true });
      latest.infrastructureDisposed = true; latest.recoveryRetained = !!latest.handedOff && !removeRecovery; save(statePath, latest);
      return { infrastructureDisposed: true, recoveryRetained: latest.recoveryRetained };
    } finally { c.close(); }
  }
  if (verify) await verifyInfrastructure();
  return {
    options: {
      runId: plan.runId, outputRoot: join(privateRoot, 'reports'), admissionLedgerRoot: join(privateRoot, 'ledger'),
      // Unknown quota, no host app-server/auth refresh subprocess. Native scheduler admits one explicit diagnostic.
      quotaSource: { refresh: async () => null },
      async prepareInvocation(context) {
        if (used || context.stage !== 'final-profile-G1' || context.identity.assignmentId !== assignmentId || context.identity.stageId !== assignmentId + '-stage-1' || context.identity.attemptId !== attemptId || context.signal.aborted || context.deadlineEpochMs <= Date.now()) throw new Error('unexpected or expired single G1 invocation');
        used = true; let aborted = false; const started = Date.now();
        const setupCutoff = Math.min(Date.now() + 45000, context.deadlineEpochMs - 185000);
        const timer = setTimeout(() => { aborted = true; }, Math.max(1, setupCutoff - Date.now()));
        const onAbort = () => { aborted = true; if (state.handedOff) void cleanup().catch(() => {}); };
        context.signal.addEventListener('abort', onAbort, { once: true });
        try {
          await verifyInfrastructure();
          if (aborted || context.signal.aborted || Date.now() >= setupCutoff) throw new Error('setup cutoff elapsed before staging');
          staging.validatePublicationPath(context.cwd);
          const { snapshotTask } = await load('runner/boundary/task-tree.ts');
          const tree = snapshotTask(context.cwd, true);
          const files = tree.entries.filter(e => !e.path.startsWith('.git/') && e.path !== '.git' && e.kind === 'file');
          if (files.length !== Object.keys(plan.taskFiles).length || files.some(e => !plan.taskFiles[e.path] || hash(Buffer.from(e.data, 'base64')) !== plan.taskFiles[e.path]) || tree.entries.some(e => e.kind === 'symlink' || (!e.path.startsWith('.git/') && e.path !== '.git' && !['src', 'test', ...Object.keys(plan.taskFiles)].includes(e.path)))) throw new Error('runSuite workspace is not the independently pinned task content');
          // Read HEAD only from normalized private audit tree, never source Git config.
          const headEntry = tree.entries.find(e => e.path === '.git/HEAD'); const head = Buffer.from(headEntry.data, 'base64').toString().trim();
          const baseline = head.startsWith('ref: ') ? Buffer.from(tree.entries.find(e => e.path === '.git/' + head.slice(5)).data, 'base64').toString().trim() : head;
          staging.verifyGitBaseline(tree, baseline);
          if (aborted || context.signal.aborted || Date.now() >= setupCutoff) throw new Error('setup cutoff elapsed before volume creation');
          const receipt = await staging.stageTaskClone({ taskRoot: context.cwd, contextRoot: join(state.authRoot, 'payload'), baselineCommit: baseline, utilityImage: plan.utilityImage });
          state.stage = { taskVolume: receipt.taskVolume, contextVolume: receipt.contextVolume, receiptHash: receipt.receiptHash }; save(statePath, state);
          const specification = {
            profile: 'cq-boundary-s5', daemonId: pins.daemon.id, vmConfigHash: pins.vm.configHash, image: pins.workerImage,
            taskVolume: receipt.taskVolume, contextVolume: receipt.contextVolume, stagingEvidence: receipt.receiptHash,
            authenticationFiles: ['auth.json'], nativeControlEvidence: plan.nativeControlEvidence,
            network: { name: state.network, workerIP: pins.network.workerIP, brokerIP: pins.network.brokerIP, port: pins.network.port, brokerIdentity: pins.brokerIdentity, productionEligible: true },
            namespaceEvidence: 'namespace-acl.sh:' + pins.sourceAssets['namespace-acl.sh'],
          };
          const boundaryIdentity = compileContainerBoundary(specification).identity;
          // Derive from reviewed public args/bootstrap/budget independently of incoming approve request/native identity function.
          const invocationIdentity = hash(JSON.stringify({ boundaryIdentity, stage: 'final-profile-G1', executable: '/usr/local/bin/codex', args: pins.finalArguments, bootstrap: pins.bootstrapHash, budget: 90 }));
          expected = Object.freeze({ stage: 'final-profile-G1', assignmentId, attemptId, sourcePin: plan.sourcePin, boundaryIdentity, invocationIdentity });
          state.hostTaskRoot = resolve(context.cwd); state.boundaryIdentity = boundaryIdentity; save(statePath, state); save(join(privateRoot, 'expected-private.json'), expected);
          await verifySources();
          if (aborted || context.signal.aborted || Date.now() >= setupCutoff || Date.now() - started >= 45000) throw new Error('late G1 preparation refused');
          state.handedOff = true; save(statePath, state);
          const lease = setTimeout(() => { void cleanup().catch(() => {}); }, Math.max(1, context.deadlineEpochMs - Date.now())); lease.unref();
          return { specification, staging: receipt, broker: state.broker, hostTaskRoot: resolve(context.cwd), exportRoot: resolve(context.cwd) };
        } catch { await cleanup(); throw new Error('private G1 preparation unavailable; setup disposed or private recovery retained'); }
        finally { clearTimeout(timer); }
      },
      async approve(request) {
        try {
        await verifySources();
        if (!expected || Object.keys(expected).some(key => request[key] !== expected[key])) throw new Error('native request differs from independently prepared identities');
        const grant = privateJson(join(privateRoot, 'parent-approval.json'));
        if (grant.runtimeModuleSha256 !== hash(readFileSync(join(privateRoot, 'runtime.mjs'))) || grant.planSha256 !== hash(JSON.stringify(plan)) || grant.approved !== true || grant.runId !== plan.runId || grant.runtimeSourceSha256 !== plan.runtimeSourceSha256 || grant.sourcePin !== plan.sourcePin || grant.publicInputsSha256 !== plan.publicInputsSha256 || grant.assignmentId !== assignmentId || grant.attemptId !== attemptId || grant.allowVerifiedDynamicPrivateStaging !== true || grant.stage !== 'final-profile-G1' || grant.modelBudgetSeconds !== 90 || grant.heldOut !== false || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 900000) throw new Error('separate reviewed parent G1 approval unavailable');
        return { assignmentId, attemptId, sourcePin: plan.sourcePin, receipt: { admissionId: grant.admissionId, stage: expected.stage, profile: 'cq-subscription-http', boundaryIdentity: expected.boundaryIdentity, invocationIdentity: expected.invocationIdentity, expiresAt: grant.expiresAt, heldOut: false } };
        } catch { await cleanup(); throw new Error('parent approval refused; private recovery retained'); }
      },
    }, cleanup, verifyInfrastructure,
  };
}
