/** Synthetic actual-factory handoff/abort reproduction. No auth, endpoints or models. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
// Trusted sibling integration implementation; this synthetic entrypoint never dispatches.
const { runSupervised } = await import(pathToFileURL(resolve(new URL('../../', import.meta.url).pathname, '../cq-settings-integration/runner/native/process.ts')).href);
import { createPreparedFinalG1Runtime } from './final-g1-runtime.mjs';
import { DockerControl } from './docker-control.ts';
import { publishStoppedTask, exportStoppedTask } from './task-staging.ts';
import { containerTaskSession } from './task-session.ts';
import { finalContainerLifecycle } from './codex-final-profile.ts';
import { brokerAssetTree, FINAL_BROKER_RUNTIME_IDENTITY, FINAL_BROKER_ASSET_INVENTORY } from './broker-toolchain.ts';
const sha = value => createHash('sha256').update(value).digest('hex');
const utility = 'sha256:4a14ba40f65117679e6f60d0f7f7bfa5eb44ff9be79e96137966a1ba9675f9b0';
export async function probeRuntimeAbort(mode = 'abort') {
  if (!['accepted','rejected-baseline','rejected-export'].includes(mode)) throw Error('synthetic mode required');
  const root = mkdtempSync(join(tmpdir(),'cq-s5-factory-abort-')); chmodSync(root,0o700);
  const repo = join(root,'fixture'), dir = join(repo,'runner/boundary'); mkdirSync(dir,{recursive:true});
  const source = resolve(new URL('.',import.meta.url).pathname), brokerId = 'b'.repeat(64), runId = 'synthetic-'+root.split('-').at(-1);
  const fixture = globalThis.__cqAbortFixture = { events:[], worker:null, cleanupStarted:false, cleanupDone:false };
  fixture.removed = new Promise(r => { fixture.resolveRemoved = r; });
  const emit = event => fixture.events.push(event);
  const pins = JSON.parse(readFileSync(join(source,'evidence/fallback/final-profile-public-inputs.json')));
  const auth = join(root,'synthetic-context'); mkdirSync(join(auth,'payload'),{recursive:true});
  // Deliberately inert synthetic files. The fixture's auth validator is mocked; no credential is read.
  writeFileSync(join(auth,'payload/auth.json'),'{}'); writeFileSync(join(auth,'payload/config.toml'),'synthetic-no-auth');
  pins.nativeConfigHash = sha('synthetic-no-auth');
  mkdirSync(join(dir,'evidence/fallback'),{recursive:true});
  const publicPath=join(dir,'evidence/fallback/final-profile-public-inputs.json'); writeFileSync(publicPath,JSON.stringify(pins));
  const brokerVolume='cq-s5-broker-assets-'+sha(root).slice(0,16), network='cq-s5-synthetic-'+sha(root).slice(0,16);
  const broker={State:{Running:true},Image:pins.brokerImage,Config:{User:'1000:1000',Entrypoint:['/usr/local/bin/node'],Cmd:['/opt/broker.mjs','/opt/config.json'],Labels:{'cq.boundary.runtime':runId,'cq.boundary.broker':pins.brokerIdentity,'cq.boundary.broker-runtime':FINAL_BROKER_RUNTIME_IDENTITY}},HostConfig:{ReadonlyRootfs:true,Privileged:false,PidMode:'',CapDrop:['ALL'],CapAdd:null,Binds:null,PortBindings:null},Mounts:[{Type:'volume',Name:brokerVolume,Destination:'/opt',RW:false}],NetworkSettings:{Networks:{bridge:{},[network]:{}}}};
  const mock={broker,brokerId,brokerVolume,network,runId,pins,entries:brokerAssetTree().entries,inventory:FINAL_BROKER_ASSET_INVENTORY,config:JSON.parse(readFileSync(join(source,'broker-public-assets/config.json')))};
  fixture.mock=mock;
  const url = file => pathToFileURL(join(source,file)).href;
  // Only broker/auth declarations are mocked. Worker staging, daemon operations,
  // namespace teardown and stopped export use the real implementation.
  writeFileSync(join(dir,'docker-control.ts'),`import {DockerControl as Real,teardownContainer} from ${JSON.stringify(url('docker-control.ts'))};
export {teardownContainer};export class DockerControl extends Real {async run(a,i,m){const f=globalThis.__cqAbortFixture,x=f.mock;
if(a[0]==='inspect'&&a[1]===x.brokerId)return JSON.stringify([x.broker]);
if(a[0]==='image')return JSON.stringify([{Id:a[2]}]);
if(a[0]==='exec'&&a[1]===x.brokerId)return JSON.stringify(a.at(-1).includes('readdirSync')?x.entries:x.config);
if(a[0]==='volume'&&a[1]==='inspect'&&a[2]===x.brokerVolume)return JSON.stringify([{Driver:'local',Options:null,Labels:{'cq.boundary.runtime':x.runId,'cq.boundary.public-assets':x.inventory}}]);
if(a[0]==='network'&&a[1]==='inspect'&&a[2]===x.network)return JSON.stringify([{Internal:true,EnableIPv6:false,Labels:{'cq.boundary.runtime':x.runId},IPAM:{Config:[{Subnet:x.pins.network.internalSubnet}]},Containers:{[x.brokerId]:{IPv4Address:x.pins.network.brokerIP+'/24'}}}]);
if(a[0]==='ps'&&a.at(-1)==='volume='+x.brokerVolume)return x.brokerId;
if(a[0]==='ps'&&a.at(-1)==='id='+x.brokerId)return '';
if(a[0]==='ps'&&a.at(-1)==='volume='+f.taskVolume){f.cleanupStarted=true;f.events.push('runtime-worker-lookup');}
const r=await super.run(a,i,m);if(a[0]==='rm'&&a.includes(f.worker)){f.cleanupDone=true;f.events.push('runtime-worker-removed');f.resolveRemoved();}return r;}}
`);
  for(const file of ['task-tree.ts','container.ts','egress-broker.ts','lifecycle-evidence.ts']) writeFileSync(join(dir,file),`export * from ${JSON.stringify(url(file))};`);
  writeFileSync(join(dir,'task-staging.ts'),`export * from ${JSON.stringify(url('task-staging.ts'))};import {stageTaskClone as stage} from ${JSON.stringify(url('task-staging.ts'))};export async function stageTaskClone(input){const result=await stage(input);globalThis.__cqAbortFixture.abortDuringSetup?.();return result;}`);
  writeFileSync(join(dir,'codex-final-profile.ts'),'export function validateFinalCodexAuth(){ /* synthetic no-auth fixture */ }');
  const task=join(root,'task');mkdirSync(task);writeFileSync(join(task,'tracked'),'synthetic baseline\n');
  const git=args=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:task,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',timeout:10000}).trim();
  git(['init','-q']);git(['add','tracked']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','baseline']);
  const plan={repoRoot:repo,privateRoot:root,privateAuthRoot:auth,network,brokerContainerId:brokerId,runId,brokerAssetVolume:brokerVolume,utilityImage:utility,runtimeSource:join(source,'final-g1-runtime.mjs'),runtimeSourceSha256:sha(readFileSync(join(source,'final-g1-runtime.mjs'))),publicInputsSha256:sha(readFileSync(publicPath)),runtimeDependenciesSha256:{},sourcePins:{},taskFiles:{tracked:sha('synthetic baseline\n')},taskDirectories:[],nativeControlEvidence:'synthetic-only',sourcePin:'synthetic-not-admission'};
  const save=(name,data)=>writeFileSync(join(root,name),JSON.stringify(data),{mode:0o600});
  save('setup-state.json',{authRoot:auth,network,broker:{containerId:brokerId}});save('plan-hash.json',{sha256:sha(JSON.stringify(plan))});
  const runtime=await createPreparedFinalG1Runtime(plan,{verify:false});const abort=new AbortController();
  const assignmentId='final-profile-g1-'+runId, identity={assignmentId,stageId:assignmentId+'-stage-1',attemptId:assignmentId+'-attempt-1'};
  if(mode==='setup-abort')fixture.abortDuringSetup=()=>abort.abort();
  let setup;try{setup=await runtime.options.prepareInvocation({stage:'final-profile-G1',identity,cwd:task,signal:abort.signal,deadlineEpochMs:Date.now()+240000});}catch(error){if(mode!=='setup-abort')throw error;const state=JSON.parse(readFileSync(join(root,'setup-state.json')));const proof={provenance:'synthetic-actual-factory-no-auth-no-model',mode,setupRejected:true,cleanupAwaited:state.infrastructureDisposed===true,handedOff:state.handedOff===true,recoveryPreserved:false,modelCalls:0,actualRouteQualified:false,privateEvidenceRoot:root};save('proof.json',proof);return proof;}
  emit('factory-handed-off');fixture.taskVolume=setup.staging.taskVolume;
  const c=new DockerControl();let session;const original=DockerControl.prototype.run;
  const {compileContainerBoundary}=await import('./container.ts');
  try {
    fixture.worker=await c.run(['create','--pull=never','--label','cq.boundary.identity='+compileContainerBoundary(setup.specification).identity,'--network','none','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','256m','--memory-swap','256m','--cpus','0.5','--ipc','private','--cgroupns','private','--mount',`type=volume,source=${setup.staging.taskVolume},target=/task,volume-nocopy`,'--entrypoint','/usr/local/bin/node',pins.workerImage,'-e',"require('fs').writeFileSync('/task/tracked','synthetic partial');setInterval(()=>{},1000)"]);
    await c.run(['start',fixture.worker]);session=containerTaskSession(setup.staging,fixture.worker);
    // Force the admissible TOCTOU ordering: adapter observes worker, then runtime
    // abort cleanup removes it before adapter inspect. A bounded barrier avoids polling.
    DockerControl.prototype.run=async function(a,i,m){const result=await original.call(this,a,i,m);if(mode==='abort'&&this.constructor===DockerControl&&a[0]==='ps'&&a.at(-1)==='id='+fixture.worker&&result&&!fixture.adapterObserved){fixture.adapterObserved=true;emit('adapter-observed-worker');abort.abort();emit('setup-signal-aborted');if(readFileSync(setup.lifecycleEvidencePath,'utf8').includes('runtime-cleanup-start'))await Promise.race([fixture.removed,new Promise((_,reject)=>setTimeout(()=>reject(Error('synthetic barrier cutoff')),10000))]);}return result;};
    const exportRoot=mkdtempSync(join(root,'.cq-stopped-export-'));chmodSync(exportRoot,0o700);
    let cleanupPromise;
    const cleanupInvocation=request=>cleanupPromise??=(async()=>{return runtime.options.cleanupInvocation(request);})();
    const result=await runSupervised('/synthetic/no-model',[],{cwd:task,identity:{...identity,invocationId:'synthetic-native-invocation'},stage:'final-profile-G1',expectedTaskBaselineCommit:mode==='rejected-baseline'?'0'.repeat(40):setup.staging.baselineCommit,timeoutMs:90,hardDeadlineEpochMs:Date.now()+240000,killGraceMs:300,cleanupInvocation,
      spawnAdapter:async()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['pipe','pipe','pipe'],detached:true});
        const life=finalContainerLifecycle({child,budgetSeconds:90/1000,terminate:()=>session.terminate(),exportTask:async()=>{if(mode==='rejected-export')throw Error('synthetic export rejection');const exported=await session.finalize(exportRoot);const publication=publishStoppedTask(setup.staging,exportRoot,task,{...exported,namespaceAbsent:true});return {...exported,publication};},cleanup:async()=>{},closeControl:()=>{session.closeControl();fixture.controlClosed=true;},record:phase=>emit(phase)});
        return {child,boundaryIdentity:'synthetic-only',launchIdentity:'synthetic-only',admissionId:'synthetic-no-model',environmentNames:[],scope:'boundary',isolation:'unverified',heldOut:false,terminate:life.terminate,finalize:life.finalize};}});
    DockerControl.prototype.run=original;
    const cleanup=result.lifecycle?.invocationCleanup?.proof, failed=result.lifecycle?.error!==undefined;
    const second=await cleanupInvocation({identity,signal:new AbortController().signal,deadlineEpochMs:Date.now()+30000,preserveRecovery:true});
    // Simulate suite disposal of the published host candidate. Recovery must not depend on it.
    rmSync(task,{recursive:true,force:true});
    const recovered=mkdtempSync(join(root,'retained-candidate-'));
    const inventory=await exportStoppedTask(c,setup.staging,recovered);
    let unauditedDispositionRefused=false;
    try { await runtime.cleanup({removeRecovery:true}); } catch { unauditedDispositionRefused=true; }
    const fullCandidateSurvives=readFileSync(join(recovered,'tracked'),'utf8')==='synthetic partial';
    // Only this fresh synthetic, inert context is removed to exercise honest missing-recovery state.
    await c.run(['volume','rm',setup.staging.contextVolume]);
    let missingRecoveryFailsClosed=false;
    try { await runtime.cleanup(); } catch { missingRecoveryFailsClosed=JSON.parse(readFileSync(join(root,'setup-state.json'))).recoveryRetained===false; }
    const proof={provenance:'synthetic-actual-factory-native-no-auth-no-model',mode,nativeAccepted:result.lifecycle?.finalized===true,nativeRejected:failed,cleanupStatus:cleanup?.status,resourceIdsArray:Array.isArray(cleanup?.resourceIds),volumeDisposition:cleanup?.volumeDisposition,memoizedSameProof:second===cleanup,namespaceAbsent:!(await c.run(['ps','-aq','--filter','id='+fixture.worker])),controlClosed:fixture.controlClosed===true,hostWorkspaceAbsent:true,missingRecoveryFailsClosed,unauditedDispositionRefused,fullCandidateSurvives,retainedInventoryHash:inventory.inventoryHash,modelCalls:0,actualRouteQualified:false,privateEvidenceRoot:root};
    save('proof.json',proof);return proof;
  }finally{DockerControl.prototype.run=original;await session?.terminate().catch(()=>{});session?.closeControl();c.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const proof=await probeRuntimeAbort(process.argv[2]??'accepted');console.log(JSON.stringify(proof));if(!proof.missingRecoveryFailsClosed||!proof.unauditedDispositionRefused||!proof.fullCandidateSurvives||!proof.namespaceAbsent||!proof.controlClosed||proof.cleanupStatus!=='stopped-and-reaped'||proof.volumeDisposition!=='quarantined'||!proof.memoizedSameProof||(proof.mode==='accepted'?!proof.nativeAccepted:!proof.nativeRejected))process.exitCode=1;}catch{console.error('synthetic retention probe failed; private recovery retained');process.exitCode=1;}}
