import { FINAL_BROKER_RUNTIME_IDENTITY, FINAL_BROKER_ASSET_INVENTORY, verifyLiveBrokerToolchain } from './broker-toolchain.ts';
/** Trusted parent runtime factory. No model dispatch; approval is a separate parent file. */
import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, closeSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const hash = value => createHash('sha256').update(value).digest('hex');
function privateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size > 1024 * 1024) throw new Error('private control file unavailable'); return JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
const save = (path, data) => writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
export async function createPreparedFinalG1Runtime(plan, { verify = true, preregister = async () => {} } = {}) {
  const root = resolve(plan.repoRoot), privateRoot = resolve(plan.privateRoot);
  const load = relative => import(pathToFileURL(join(root, relative)).href);
  const [{ DockerControl, teardownContainer }, profile, staging, { compileContainerBoundary }, { compileBroker }] = await Promise.all([
    load('runner/boundary/docker-control.ts'), load('runner/boundary/codex-final-profile.ts'), load('runner/boundary/task-staging.ts'), load('runner/boundary/container.ts'), load('runner/boundary/egress-broker.ts'),
  ]);
  const lifecycleEvidencePath = join(privateRoot, 'boundary-lifecycle.jsonl');
  let lifecycleRecord;
  const note = (phase, error) => { try { lifecycleRecord?.(phase, error); } catch { /* diagnostic failure cannot change disposal result */ } };
  const statePath = join(privateRoot, 'setup-state.json');
  const state = privateJson(statePath);
  if (state.authRoot !== plan.privateAuthRoot || state.network !== plan.network || state.broker.containerId !== plan.brokerContainerId) throw new Error('private infrastructure plan changed');
  const pins = JSON.parse(readFileSync(join(root, 'runner/boundary/evidence/fallback/final-profile-public-inputs.json'), 'utf8'));
  const assignmentId = 'final-profile-g1-' + plan.runId, attemptId = assignmentId + '-attempt-1';
  let invocationCleanup;
  let used = false, expected, prepareSettled = Promise.resolve(), settlePrepare;
  if (hash(JSON.stringify(plan)) !== privateJson(join(privateRoot, 'plan-hash.json')).sha256) throw new Error('private runtime plan changed');
  async function verifySources() {
    if (hash(readFileSync(plan.runtimeSource)) !== plan.runtimeSourceSha256 || hash(readFileSync(join(root, 'runner/boundary/evidence/fallback/final-profile-public-inputs.json'))) !== plan.publicInputsSha256) throw new Error('reviewed runtime/public inputs changed');
    for (const [path, digest] of Object.entries(plan.runtimeDependenciesSha256)) if (hash(readFileSync(path)) !== digest) throw new Error('reviewed runtime dependency changed');
    for (const [path, digest] of Object.entries(plan.sourcePins)) if (hash(readFileSync(join(root, path))) !== digest) throw new Error('reviewed G1 source changed');
  }
  async function verifyInfrastructure() {
    await verifySources(); const c = new DockerControl(preregister);
    try {
      if (await c.run(['info', '--format', '{{.ID}}']) !== pins.daemon.id || hash(readFileSync(pins.vm.configPath)) !== pins.vm.configHash) throw new Error('pinned daemon/VM changed');
      for (const image of [pins.workerImage, pins.brokerImage, plan.utilityImage]) if (JSON.parse(await c.run(['image', 'inspect', image]))[0].Id !== image) throw new Error('pinned image unavailable');
      const broker = JSON.parse(await c.run(['inspect', state.broker.containerId]))[0];
      if (!broker.State.Running || broker.Image !== pins.brokerImage || broker.Config.Labels?.['cq.boundary.broker'] !== pins.brokerIdentity || broker.Config.Labels?.['cq.boundary.runtime'] !== plan.runId || broker.Mounts.length !== 1 || broker.HostConfig.Privileged || broker.HostConfig.PidMode || !broker.HostConfig.ReadonlyRootfs || broker.HostConfig.PortBindings && Object.keys(broker.HostConfig.PortBindings).length) throw new Error('private broker inventory changed');
      await verifyLiveBrokerToolchain(c, state.broker.containerId, plan.brokerAssetVolume, plan.runId);
      const config = JSON.parse(await c.run(['exec', state.broker.containerId, '/usr/local/bin/node', '-e', "process.stdout.write(require('fs').readFileSync('/opt/config.json'))"]));
      if (compileBroker(config).identity !== pins.brokerIdentity) throw new Error('broker exact route identity changed');
      if (JSON.stringify(Object.keys(broker.NetworkSettings.Networks).sort()) !== JSON.stringify(['bridge', state.network].sort())) throw new Error('broker extra network attachment');
      const network = JSON.parse(await c.run(['network', 'inspect', state.network]))[0];
      if (!network.Internal || network.EnableIPv6 || network.Labels?.['cq.boundary.runtime'] !== plan.runId || network.IPAM.Config.length !== 1 || network.IPAM.Config[0].Subnet !== pins.network.internalSubnet || network.Containers[state.broker.containerId]?.IPv4Address !== pins.network.brokerIP + '/24' || Object.keys(network.Containers).some(id => id !== state.broker.containerId)) throw new Error('private namespace network changed');
      if (hash(readFileSync(join(state.authRoot, 'payload/config.toml'))) !== pins.nativeConfigHash) throw new Error('native config changed');
      profile.validateFinalCodexAuth(readFileSync(join(state.authRoot, 'payload/auth.json'), 'utf8'), 240);
    } catch (error) { note('runtime-cleanup-error', error); throw error; } finally { c.close(); }
  }
  async function cleanup({ removeRecovery = false, dispositionReceiptPath } = {}) {
    note('runtime-cleanup-start');
    const latest = privateJson(statePath), c = new DockerControl(preregister);
    const recoveryPath = join(privateRoot, 'recovery-receipt.json');
    const recovery = { version: 'assignment-recovery-v1', runId: plan.runId, resources: [], complete: false, baselineCommit: latest.stage?.baselineCommit, disposition: 'unknown', expectedResources: [latest.stage?.taskVolume,latest.stage?.contextVolume,latest.authRoot,latest.hostTaskRoot].filter(Boolean) };
    save(recoveryPath,recovery);
    if (latest.authRoot !== plan.privateAuthRoot || latest.network !== plan.network || latest.broker.containerId !== plan.brokerContainerId || latest.stage && (!/^cq-s5-task-[a-f0-9]{16}$/.test(latest.stage.taskVolume) || !/^cq-s5-context-[a-f0-9]{16}$/.test(latest.stage.contextVolume) || !/^[a-f0-9]{64}$/.test(latest.stage.receiptHash))) { c.close(); throw new Error('private setup ownership record changed'); }
    try {
      if (await c.run(['info', '--format', '{{.ID}}']) !== pins.daemon.id) throw new Error('cleanup daemon changed');
      if (latest.stage) {
        if (latest.handedOff && removeRecovery) {
          const audit = privateJson(dispositionReceiptPath);
          if (audit.approved !== true || audit.runId !== plan.runId || audit.taskVolume !== latest.stage.taskVolume || audit.contextVolume !== latest.stage.contextVolume || audit.stagingReceiptHash !== latest.stage.receiptHash || !/^[a-f0-9]{64}$/.test(audit.candidateAuditSha256)) throw new Error('explicit parent candidate disposition audit required');
        }
        const ids = (await c.run(['ps', '-aq', '--no-trunc', '--filter', 'volume=' + latest.stage.taskVolume])).split('\n').filter(Boolean);
        for (const id of ids) {
          const worker = JSON.parse(await c.run(['inspect', id]))[0];
          if (worker.Image !== pins.workerImage || worker.Config.Labels?.['cq.boundary.identity'] !== latest.boundaryIdentity || !worker.Mounts.some(m => m.Name === latest.stage.taskVolume && m.Destination === '/task')) throw new Error('cleanup worker ownership changed');
          await teardownContainer(c, id);
        }
        for (const volume of [latest.stage.taskVolume, latest.stage.contextVolume]) {
          if (!(await c.run(['volume', 'ls', '-q'])).split('\n').includes(volume)) {
            if (latest.handedOff && !removeRecovery) { latest.recoveryRetained = false; save(statePath, latest); throw new Error('handed-off recovery volume missing'); }
            continue;
          }
          const v = JSON.parse(await c.run(['volume', 'inspect', volume]))[0];
          if (v.Labels?.['cq.boundary.staging'] !== latest.stage.receiptHash || await c.run(['ps', '-aq', '--filter', 'volume=' + volume])) throw new Error('cleanup volume ownership changed');
          if (!latest.handedOff || removeRecovery) await c.run(['volume', 'rm', volume]);
        }
      }
      if (await c.run(['ps', '-aq', '--no-trunc', '--filter', 'id=' + latest.broker.containerId])) {
        const broker = JSON.parse(await c.run(['inspect', latest.broker.containerId]))[0];
        if (broker.Config.Labels?.['cq.boundary.runtime'] !== plan.runId || broker.Config.Labels?.['cq.boundary.broker'] !== pins.brokerIdentity) throw new Error('cleanup broker ownership changed');
        await teardownContainer(c, latest.broker.containerId);
      }
      if ((await c.run(['volume', 'ls', '-q'])).split('\n').includes(plan.brokerAssetVolume)) {
        const v = JSON.parse(await c.run(['volume', 'inspect', plan.brokerAssetVolume]))[0];
        if (v.Labels?.['cq.boundary.runtime'] !== plan.runId || v.Labels?.['cq.boundary.public-assets'] !== FINAL_BROKER_ASSET_INVENTORY || await c.run(['ps','-aq','--filter','volume=' + plan.brokerAssetVolume])) throw new Error('public toolchain cleanup ownership changed');
        await c.run(['volume','rm',plan.brokerAssetVolume]);
      }
      if ((await c.run(['network', 'ls', '--format', '{{.Name}}'])).split('\n').includes(latest.network)) {
        const n = JSON.parse(await c.run(['network', 'inspect', latest.network]))[0];
        if (n.Labels?.['cq.boundary.runtime'] !== plan.runId || Object.keys(n.Containers).length) throw new Error('cleanup network ownership changed');
        await c.run(['network', 'rm', latest.network]);
      }
      if (!latest.handedOff || removeRecovery) rmSync(latest.authRoot, { recursive: true, force: true });
      recovery.disposition = latest.handedOff && !removeRecovery ? 'quarantined' : 'disposed';
      if (latest.handedOff && !removeRecovery && latest.stage) {
        const receipt = { ...latest.stage };
        for (const volume of [receipt.taskVolume, receipt.contextVolume]) {
          const io = readFileSync(join(root, 'runner/boundary/volume-io.mjs'), 'utf8');
          const entries = JSON.parse(await c.utility(['--rm','--pull=never','--network','none','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount',`type=volume,source=${volume},target=/task,readonly,volume-nocopy`,'--entrypoint','/usr/local/bin/node',plan.utilityImage,'-e',io,'read'], undefined, 100 * 1024 * 1024));
          const { validateTaskEntries } = await load('runner/boundary/task-tree.ts');
          const tree = validateTaskEntries(entries, false, volume === receipt.taskVolume);
          if (volume === receipt.contextVolume && tree.inventoryHash !== receipt.contextInventoryHash) throw new Error('retained context inventory changed');
          const baseline = volume === receipt.taskVolume ? staging.verifyGitBaseline(tree, receipt.baselineCommit) : undefined;
          recovery.resources.push({ kind:'volume', id:volume, inventoryHash:tree.inventoryHash, ...(baseline ? { head:baseline.head, baselineTree:baseline.baselineTree } : {}) }); save(recoveryPath,recovery);
        }
        const { snapshotTask } = await load('runner/boundary/task-tree.ts');
        for (const path of [latest.authRoot, latest.hostTaskRoot].filter(Boolean)) recovery.resources.push({ kind:'private-tree', path, inventoryHash:snapshotTask(path, false).inventoryHash });
        const { existsSync, lstatSync } = await import('node:fs');
        const publicationPath = join(privateRoot, 'publication-recovery.json');
        if (existsSync(publicationPath)) {
          const publication = privateJson(publicationPath);
          const { dirname } = await import('node:path');
          for (const path of [publication.exported, publication.backupRoot, publication.recoveryManifest].filter(Boolean)) {
            if (dirname(path) !== dirname(latest.hostTaskRoot) || !(path.startsWith(latest.hostTaskRoot + '.cq-original-') || path.split('/').at(-1).startsWith('.cq-stopped-export-'))) throw new Error('publication recovery ownership changed');
            if (existsSync(path)) recovery.resources.push(lstatSync(path).isDirectory() ? {kind:'private-tree',path,inventoryHash:snapshotTask(path,false).inventoryHash} : {kind:'private-file',path,sha256:hash(readFileSync(path))});
          }
          recovery.resources.push({kind:'private-file',path:publicationPath,sha256:hash(readFileSync(publicationPath))});
        }
      }
      recovery.complete = true; save(join(privateRoot, 'recovery-receipt.json'), recovery);
      latest.infrastructureDisposed = true; latest.recoveryRetained = !!latest.handedOff && !removeRecovery; save(statePath, latest);
      note('runtime-cleanup-done');
      return { infrastructureDisposed: true, recoveryRetained: latest.recoveryRetained };
    } catch (error) { note('runtime-cleanup-error', error); throw error; } finally { c.close(); }
  }
  if (verify) await verifyInfrastructure();
  return {
    options: {
      runId: plan.runId, outputRoot: join(privateRoot, 'reports'), admissionLedgerRoot: join(privateRoot, 'ledger'),
      // Use native authenticated AggregateQuotaSource; never override it with null or fabricate capacity.
      async prepareInvocation(context) {
        const { privateLifecycleRecorder } = await load('runner/boundary/lifecycle-evidence.ts');
        writeFileSync(lifecycleEvidencePath, '', { mode:0o600, flag:'wx' });
        lifecycleRecord = privateLifecycleRecorder(lifecycleEvidencePath);
        if (used || context.stage !== 'final-profile-G1' || context.identity.assignmentId !== assignmentId || context.identity.stageId !== assignmentId + '-stage-1' || context.identity.attemptId !== attemptId || context.signal.aborted || context.deadlineEpochMs <= Date.now()) throw new Error('unexpected or expired single G1 invocation');
        used = true; prepareSettled = new Promise(resolve => { settlePrepare = resolve; }); let aborted = false; const started = Date.now();
        const setupCutoff = Math.min(Date.now() + 45000, context.deadlineEpochMs - 5000);
        const timer = setTimeout(() => { aborted = true; }, Math.max(1, setupCutoff - Date.now()));
        // Setup cancellation owns preparation only. After handoff, native must await
        // adapter terminate/finalize before calling cleanupInvocation.
        const onAbort = () => { note('runtime-abort'); aborted = true; };
        context.signal.addEventListener('abort', onAbort, { once: true });
        try {
          await verifyInfrastructure();
          if (aborted || context.signal.aborted || Date.now() >= setupCutoff) throw new Error('setup cutoff elapsed before staging');
          staging.validatePublicationPath(context.cwd);
          const { snapshotTask } = await load('runner/boundary/task-tree.ts');
          const tree = snapshotTask(context.cwd, true);
          const files = tree.entries.filter(e => !e.path.startsWith('.git/') && e.path !== '.git' && e.kind === 'file');
          if (files.length !== Object.keys(plan.taskFiles).length || files.some(e => !plan.taskFiles[e.path] || hash(Buffer.from(e.data, 'base64')) !== plan.taskFiles[e.path]) || tree.entries.some(e => e.kind === 'symlink' || (!e.path.startsWith('.git/') && e.path !== '.git' && ![...plan.taskDirectories, ...Object.keys(plan.taskFiles)].includes(e.path)))) throw new Error('runSuite workspace is not the independently pinned task content');
          // Read HEAD only from normalized private audit tree, never source Git config.
          const headEntry = tree.entries.find(e => e.path === '.git/HEAD'); const head = Buffer.from(headEntry.data, 'base64').toString().trim();
          const baseline = head.startsWith('ref: ') ? Buffer.from(tree.entries.find(e => e.path === '.git/' + head.slice(5)).data, 'base64').toString().trim() : head;
          staging.verifyGitBaseline(tree, baseline);
          if (aborted || context.signal.aborted || Date.now() >= setupCutoff) throw new Error('setup cutoff elapsed before volume creation');
          const receipt = await staging.stageTaskCloneOwned({ taskRoot: context.cwd, contextRoot: join(state.authRoot, 'payload'), baselineCommit: baseline, utilityImage: plan.utilityImage }, preregister);
          state.stage = { taskVolume: receipt.taskVolume, contextVolume: receipt.contextVolume, receiptHash: receipt.receiptHash, taskInventoryHash: receipt.task.inventoryHash, contextInventoryHash: receipt.context.inventoryHash, baselineCommit: receipt.baselineCommit }; save(statePath, state);
          const specification = {
            profile: 'cq-boundary-s5', daemonId: pins.daemon.id, vmConfigHash: pins.vm.configHash, image: pins.workerImage,
            taskVolume: receipt.taskVolume, contextVolume: receipt.contextVolume, stagingEvidence: receipt.receiptHash,
            authenticationFiles: ['auth.json'], nativeControlEvidence: plan.nativeControlEvidence,
            network: { name: state.network, workerIP: pins.network.workerIP, brokerIP: pins.network.brokerIP, port: pins.network.port, brokerIdentity: pins.brokerIdentity, brokerRuntimeIdentity: FINAL_BROKER_RUNTIME_IDENTITY, productionEligible: true },
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
          // No independent post-handoff timer may race the active adapter.
          // The assignment deadline is a decision cutoff, not a lifetime guarantee.
          return { specification, staging: receipt, broker: state.broker, hostTaskRoot: resolve(context.cwd), exportRoot: resolve(context.cwd), lifecycleEvidencePath };
        } catch (error) { try { await cleanup(); } catch { /* retain first failure and quarantine */ } throw error; }
        finally { clearTimeout(timer); context.signal.removeEventListener('abort', onAbort); settlePrepare(); }
      },
      async cleanupInvocation(request) {
        if (request.identity.assignmentId !== assignmentId || request.identity.attemptId !== attemptId) throw new Error('cleanup invocation identity mismatch');
        return invocationCleanup ??= (async () => {
          await prepareSettled;
          if (request.signal.aborted || Date.now() >= request.deadlineEpochMs) throw new Error('cleanup deadline elapsed; private recovery retained');
          const proof = await cleanup();
          return { status: 'stopped-and-reaped', resourceIds: [state.broker.containerId, state.network, plan.brokerAssetVolume, ...(state.stage ? [state.stage.taskVolume, state.stage.contextVolume] : [])], volumeDisposition: proof.recoveryRetained ? 'quarantined' : 'disposed' };
        })();
      },
      async approve(request) {
        try {
        await verifySources();
        if (!expected || Object.keys(expected).some(key => request[key] !== expected[key])) throw new Error('native request differs from independently prepared identities');
        const grant = privateJson(join(privateRoot, 'parent-approval.json'));
        if (plan.sourceIsProvisional || grant.sourceIsProvisional !== false || grant.repositoryHead !== plan.repositoryHead || grant.runtimeModuleSha256 !== hash(readFileSync(join(privateRoot, 'runtime.mjs'))) || grant.planSha256 !== hash(JSON.stringify(plan)) || grant.approved !== true || grant.runId !== plan.runId || grant.runtimeSourceSha256 !== plan.runtimeSourceSha256 || grant.sourcePin !== plan.sourcePin || grant.publicInputsSha256 !== plan.publicInputsSha256 || grant.assignmentId !== assignmentId || grant.attemptId !== attemptId || grant.allowVerifiedDynamicPrivateStaging !== true || grant.stage !== 'final-profile-G1' || grant.modelBudgetSeconds !== 90 || grant.heldOut !== false || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 900000) throw new Error('separate reviewed parent G1 approval unavailable');
        return { assignmentId, attemptId, sourcePin: plan.sourcePin, receipt: { admissionId: grant.admissionId, stage: expected.stage, profile: 'cq-subscription-http', boundaryIdentity: expected.boundaryIdentity, invocationIdentity: expected.invocationIdentity, expiresAt: grant.expiresAt, heldOut: false } };
        } catch (error) { try { await cleanup(); } catch { /* retain primary admission failure */ } throw error; }
      },
    }, cleanup, verifyInfrastructure,
  };
}

/** Operation for PK04's outer owner. Private descriptor contains the trusted plan;
 * only its path crosses the executor boundary. All runSuite capture/judge/finally
 * code runs inside this independently reapable executor. Live authority remains
 * the separate immutable parent approval and scheduler, never this adapter. */
export async function executePreparedFinalG1Assignment(context) {
  const descriptor = privateJson(context.privateInputPath);
  if (descriptor.preparationResultPath && !context.priorResults?.some(r => r.phase==='preparation' && r.path===descriptor.preparationResultPath && hash(readFileSync(r.path))===r.sha256)) throw Error('preparation result lacks invocation-bound accepted proof');
  const prepared = descriptor.preparationResultPath ? privateJson(descriptor.preparationResultPath) : descriptor;
  const plan = descriptor.plan ?? privateJson(prepared.planPath);
  if (prepared.planSha256 && hash(JSON.stringify(plan)) !== prepared.planSha256) throw Error('prepared plan changed');
  const assignmentId='final-profile-g1-' + plan.runId;
  if(context.identity.assignmentId!==assignmentId || context.identity.attemptId!==assignmentId+'-attempt-1') throw Error('outer assignment identity differs from native plan');
  const runtime = await createPreparedFinalG1Runtime(plan, { preregister: context.preregister });
  const native = await import(pathToFileURL(join(plan.repoRoot, 'runner/native/run-final-profile-g1.ts')).href);
  let primary;
  try { return await native.runFinalProfileG1(runtime.options); }
  catch(error) { primary=error; throw error; }
  finally { try { await runtime.cleanup(); } catch(error) { if(!primary) throw error; } }
}
