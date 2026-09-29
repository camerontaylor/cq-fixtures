/** No-dispatch operator: creates dedicated infrastructure, fresh access-only private context and disabled approval template. */
import { mkdtempSync, chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { DockerControl, teardownContainer } from './docker-control.ts';
import { prepareFinalCodexContext } from './codex-final-profile.ts';
const hash = b => createHash('sha256').update(b).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
export async function preparePrivateRuntime(repoRoot, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,95}$/.test(runId)) throw new Error('safe unique parent runId required');
  const root = resolve(repoRoot), load = p => import(pathToFileURL(join(root, p)).href);
  const native = await load('runner/native/run-final-profile-g1.ts');
  const { createReviewLoopRepairTask } = await load('campaigns/cq-settings/corpus/review-loop-task.ts');
  const { pins: sourcePins, sourcePin } = await native.finalProfileG1SourcePins();
  const publicInputsPath = join(root, 'runner/boundary/evidence/fallback/final-profile-public-inputs.json');
  const publicInputsSha256 = hash(readFileSync(publicInputsPath)), pins = JSON.parse(readFileSync(publicInputsPath));
  const runtimeSource = fileURLToPath(new URL('./final-g1-runtime.mjs', import.meta.url));
  const runtimeSourceSha256 = hash(readFileSync(runtimeSource));
  const privateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cq-s5-final-g1-private-'))); chmodSync(privateRoot, 0o700);
  const task = await createReviewLoopRepairTask({ provider: 'codex', model: 'gpt-6-sol' });
  let taskFiles;
  try { taskFiles = Object.fromEntries(['package.json','src/settings.mjs','src/display.mjs','test/public-settings.test.mjs'].map(p => [p, hash(readFileSync(join(task.worktreePath, p)))])); }
  finally { await task.cleanup(); }
  const c = new DockerControl(), network = 'cq-s5-final-g1-' + randomBytes(8).toString('hex');
  let brokerId, networkCreated = false, auth;
  const utilityImage = 'sha256:4a14ba40f65117679e6f60d0f7f7bfa5eb44ff9be79e96137966a1ba9675f9b0';
  try {
    if (await c.run(['info', '--format', '{{.ID}}']) !== pins.daemon.id || hash(readFileSync(pins.vm.configPath)) !== pins.vm.configHash) throw new Error('dedicated daemon/VM identity differs');
    for (const image of [pins.workerImage, pins.brokerImage, utilityImage]) if (JSON.parse(await c.run(['image', 'inspect', image]))[0].Id !== image) throw new Error('immutable image unavailable');
    const networks = (await c.run(['network','ls','-q'])).split('\n').filter(Boolean);
    for (const id of networks) { const n = JSON.parse(await c.run(['network','inspect',id]))[0]; if (n.IPAM.Config.some(cfg => cfg.Subnet === pins.network.internalSubnet)) throw new Error('final subnet already owned; do not mutate existing network'); }
    auth = prepareFinalCodexContext('/Users/ctaylor/.tmp/cq-s5-frozen-profile-3AQYGq/config.toml');
    await c.run(['network','create','--internal','--subnet',pins.network.internalSubnet,'--label','cq.boundary.runtime=' + runId,network]); networkCreated = true;
    brokerId = await c.run(['create','--pull=never','--name',network + '-broker','--label','cq.boundary.runtime=' + runId,'--label','cq.boundary.broker=' + pins.brokerIdentity,'--network','bridge','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','256m','--memory-swap','256m','--cpus','0.5','--ipc','private','--cgroupns','private','--no-healthcheck','--entrypoint','/usr/local/bin/node',pins.brokerImage,'/opt/broker.js','/opt/config.json']);
    await c.run(['network','connect','--ip',pins.network.brokerIP,network,brokerId]); await c.run(['start',brokerId]);
    const config = JSON.parse(await c.run(['exec',brokerId,'/usr/local/bin/node','-e',"process.stdout.write(require('fs').readFileSync('/opt/config.json'))"]));
    const { compileBroker } = await load('runner/boundary/egress-broker.ts'); if (compileBroker(config).identity !== pins.brokerIdentity) throw new Error('exact live broker configuration differs');
    const report = '/Volumes/offload/neptune/repos/toolkit-research-cq-settings/research/research-20260929-cq-settings-execution/visible-g1-runs/codex/de7971b1-827b-4da2-a7df-a821c525e2e2/visible-g1-report.json';
    const plan = { repoRoot:root, privateRoot, privateAuthRoot:auth.privateRoot, network, brokerContainerId:brokerId, runId, runtimeSource, runtimeSourceSha256, sourcePins, sourcePin, publicInputsSha256, utilityImage, taskFiles, nativeControlEvidence:'accepted-host-visible-G1-report-sha256:' + hash(readFileSync(report)) + ';final-container-G1-unqualified;extension-lifetime-unverified' };
    save(join(privateRoot,'setup-state.json'), { network, broker:{containerId:brokerId,imageId:pins.brokerImage,configPath:'/opt/config.json'}, authRoot:auth.privateRoot, handedOff:false });
    const planSha256 = hash(JSON.stringify(plan)); save(join(privateRoot,'plan-hash.json'),{sha256:planSha256});
    const wrapper = `import { createPreparedFinalG1Runtime } from ${JSON.stringify(pathToFileURL(runtimeSource).href)};\nconst plan=${JSON.stringify(plan)};\nexport async function createFinalProfileG1Runtime(){return (await createPreparedFinalG1Runtime(plan)).options}\nexport async function cleanupFinalProfileG1Runtime(options={}){return (await createPreparedFinalG1Runtime(plan,{verify:false})).cleanup(options)}\nexport async function verifyFinalProfileG1Runtime(){await (await createPreparedFinalG1Runtime(plan)).verifyInfrastructure();return {verified:true,modelCalls:0}}\n`;
    writeFileSync(join(privateRoot,'runtime.mjs'),wrapper,{mode:0o600,flag:'wx'});
    const approval = { approved:false, stage:'final-profile-G1', runId, assignmentId:'final-profile-g1-' + runId, attemptId:'final-profile-g1-' + runId + '-attempt-1', sourcePin, publicInputsSha256, runtimeSourceSha256, runtimeModuleSha256:hash(wrapper), planSha256, allowVerifiedDynamicPrivateStaging:true, modelBudgetSeconds:90, heldOut:false, admissionId:'PARENT-MUST-CHOOSE-UNIQUE-ID', expiresAt:0 };
    save(join(privateRoot,'parent-approval.template.json'),approval); mkdirSync(join(privateRoot,'reports'),{mode:0o700});
    const { createPreparedFinalG1Runtime } = await import(pathToFileURL(runtimeSource).href); await (await createPreparedFinalG1Runtime(plan)).verifyInfrastructure();
    return { privateModule:join(privateRoot,'runtime.mjs'), approvalTemplate:join(privateRoot,'parent-approval.template.json'), modelCalls:0, approvalEnabled:false, ...approval, taskFiles, lifetime:{setup:'runtime-self-cutoff-before-native-60s;Docker-operations-bounded-but-not-interruptible',runtime:'native-90s-assignment-240s',latePreparation:'self-clean-on-return',recovery:'retained-after-handoff-until-parent-disposition'} };
  } catch {
    if (brokerId) await teardownContainer(c,brokerId); if (networkCreated) await c.run(['network','rm',network]);
    // Private auth inventory retained for explicit parent recovery, never printed.
    throw new Error('private runtime preparation unavailable; created infrastructure disposed, private recovery retained');
  } finally { c.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await preparePrivateRuntime(process.argv[2],process.argv[3]),null,2)); }
  catch { console.error('bounded private runtime preparation failed; no credential details disclosed'); process.exitCode=1; }
}
