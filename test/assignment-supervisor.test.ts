import { pathToFileURL } from 'node:url';
import { snapshotTask, SAFE_GIT_CONFIG } from '../runner/boundary/task-tree.ts';
import { brokerAssetTree, FINAL_BROKER_ASSET_INVENTORY, FINAL_BROKER_RUNTIME_IDENTITY } from '../runner/boundary/broker-toolchain.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { withAssignmentResourceOwner } from '../runner/boundary/assignment-supervisor-owner.ts';
import { DockerControl } from '../runner/boundary/docker-control.ts';
import { superviseAssignment } from '../runner/boundary/assignment-supervisor.ts';
import type { AssignmentPhase } from '../runner/boundary/assignment-supervisor.ts';
import { NativeSupervisorControl, runSupervised } from '../runner/native/process.ts';
import { assertG2DaemonPreregistration, G2_EXPECTED_DAEMON_ID, g2DaemonEndpoint } from '../runner/boundary/g2-daemon-contract.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive:true, force:true }); });
const identity = { invocationId:'supervisor-test', assignmentId:'assignment-test', stageId:'stage-test', attemptId:'attempt-test' };
function fixture(code: string, phase: AssignmentPhase = 'preparation', duration = 500) {
  const root=mkdtempSync(join(realpathSync(tmpdir()),'cq-supervisor-test-')); roots.push(root);
  const modulePath=join(root,'operation.mjs'), privateInputPath=join(root,'input.json');
  writeFileSync(modulePath,code,{mode:0o600}); writeFileSync(privateInputPath,'{}',{mode:0o600});
  const now=Date.now(), moduleSha256=createHash('sha256').update(code).digest('hex');
  const op={phase,modulePath,moduleSha256,exportName:'execute',privateInputPath,deadlineEpochMs:now+duration};
  return { root, input:{identity,privateRoot:root,operations:[op],allowedOperations:[op],resources:[],resourceDeadlineEpochMs:now+duration,reapDeadlineEpochMs:now+duration+500,quarantineDeadlineEpochMs:now+duration+700} };
}
describe('independently owned assignment lifetime', () => {
  it('preregisters resources durably and binds private result before successful host reap',async()=>{
    const f=fixture("export async function execute(c){await c.preregister({kind:'volume',id:'cq-s5-test-owned'});return {capture:true}}",'shutdown',1500);
    const r=await superviseAssignment(f.input);
    expect(r.terminal).toBe('completed'); expect(r.hostProcessTree).toBe('stopped-and-reaped'); expect(r.resourceLifetime).toBe('unsupported');
    expect(JSON.parse(readFileSync(r.registryPath,'utf8')).resources).toEqual([{kind:'volume',id:'cq-s5-test-owned'}]);
    expect(JSON.parse(readFileSync(r.results[0].path,'utf8'))).toEqual({capture:true});
    expect(Object.isFrozen(r.results)).toBe(true);
  });
  for (const phase of ['preparation','execution','capture','judge','shutdown'] as const) {
    it(`reaps a synchronous ${phase} stall outside the blocked executor`,async()=>{
      const f=fixture('export function execute(){while(true){}}',phase);
      const r=await superviseAssignment(f.input);
      expect(r).toMatchObject({terminal:'timeout',primaryCause:'DeadlineExceeded',phase,hostProcessTree:'stopped-and-reaped',resourceLifetime:'unsupported',quarantine:'retained'});
      expect(r.results).toEqual([]);
    });
  }
  it('retains ownership after cancellation and bounds a stalled parent quarantine hook',async()=>{
    const f=fixture("export async function execute(c){await c.preregister({kind:'volume',id:'cq-s5-retained'});await new Promise(()=>{})}",'execution',1000);
    const controller=new AbortController();
    f.input.resources.push({kind:'volume',id:'cq-s5-retained'} as never);
    const timer=setTimeout(()=>controller.abort(),300);
    const r=await superviseAssignment({...f.input,signal:controller.signal,quarantine:async()=>new Promise(()=>{})}); clearTimeout(timer);
    expect(r.terminal).toBe('cancelled'); expect(r.quarantine).toBe('unknown'); expect(r.hostProcessTree).toBe('stopped-and-reaped');
    expect(readFileSync(r.registryPath,'utf8')).toContain('cq-s5-retained');
  });
  it('rejects module/descriptor substitutions before executor launch',async()=>{
    const f=fixture('export function execute(){return true}', 'preparation',1000);
    f.input.operations[0].moduleSha256='0'.repeat(64);
    await expect(superviseAssignment(f.input)).rejects.toThrow(/allowed module/);
  });
  it('fails an executor crash with retained registry rather than claiming namespace proof',async()=>{
    const f=fixture('export function execute(){process.exit(2)}', 'preparation',4000);
    expect(await superviseAssignment(f.input)).toMatchObject({terminal:'failed',hostProcessTree:'stopped-and-reaped',resourceLifetime:'unsupported'});
  });
});
it('trusted no-spawn settles expected tree only after matching driver settlement',async()=>{
  const control=new NativeSupervisorControl();control.beginInvocation(identity);control.expectProcessTree(identity);
  control.reportProcessNotStarted(identity,'trusted pre-spawn guard');control.settleInvocation(identity);
  await expect(control.cancelInvocationAndWait({identity,cause:'cancel',deadlineEpochMs:Date.now()+100})).resolves.toMatchObject({processTree:'stopped-and-reaped'});
  const other={...identity,invocationId:'unknown'};control.beginInvocation(other);control.expectProcessTree(other);control.settleInvocation(other);
  await expect(control.cancelInvocationAndWait({identity:other,cause:'cancel',deadlineEpochMs:Date.now()+100})).rejects.toThrow(/cannot prove/);
});
it('late posthandoff finalization cannot mutate returned launch/publication proof',async()=>{
  const f=fixture('export function execute(){}');
  let release!: (value:{inventoryHash:string;head:string})=>void;
  const gate=new Promise<{inventoryHash:string;head:string}>(resolve=>{release=resolve;});
  const result=await runSupervised(process.execPath,['-e','process.exit(0)'],{
    cwd:f.root,identity,stage:'actual-route-G2',timeoutMs:100,hardDeadlineEpochMs:Date.now()+200,cleanupTimeoutMs:100,
    spawnAdapter:async(command,args)=>({child:spawn(command,[...args],{detached:true,stdio:['pipe','pipe','pipe']}),boundaryIdentity:'boundary',launchIdentity:'launch',admissionId:'admission',environmentNames:[],scope:'boundary',isolation:'unverified',heldOut:false,terminate:async()=>{},finalize:()=>gate}),
    cleanupInvocation:async()=>({status:'stopped-and-reaped',resourceIds:['worker'],volumeDisposition:'quarantined'}),
  });
  const before=JSON.stringify(result);release({inventoryHash:'a'.repeat(64),head:'b'.repeat(40)});
  await new Promise(resolve=>setTimeout(resolve,30));expect(JSON.stringify(result)).toBe(before);expect(result.launch?.taskExport).toBeUndefined();
  expect(result.processEvidence).toMatchObject({identity,status:'spawned'});expect(result.treeStopped).toBe(false);
});
it('daemon preregistration stays explicit and rejects drift',()=>{
  expect(g2DaemonEndpoint('/home/synthetic')).toBe('unix:///home/synthetic/.colima/cq-boundary-s5/docker.sock');
  expect(()=>assertG2DaemonPreregistration(G2_EXPECTED_DAEMON_ID,'rebuilt-daemon')).toThrow(/preregistration/);
  expect(()=>assertG2DaemonPreregistration('self-consistent','self-consistent')).toThrow(/preregistration/);
});

it('propagates parent preregistration through legacy utility callers before creation',async()=>{
  const events:string[]=[];
  await withAssignmentResourceOwner(async r=>{events.push('register:'+r.id)},async()=>{
    const control=new DockerControl();
    control.run=async args=>{events.push(args[0]);return ''};
    try { await control.utility(['--rm','synthetic-no-launch']); } finally { control.close(); }
  });
  expect(events[0]).toMatch(/^register:cq-s5-utility-/);expect(events.slice(1)).toEqual(['run','ps']);
});
it('binds trusted early refusal and unknown factory failure without inferred stop proof',async()=>{
  const f=fixture('export function execute(){}');
  const early=await runSupervised('unused',[],{cwd:f.root,identity,timeoutMs:10,hardDeadlineEpochMs:Date.now()-1});
  expect(early.processEvidence).toMatchObject({identity,status:'trusted-no-spawn'});
  const unknown=await runSupervised('unused',[],{cwd:f.root,identity,timeoutMs:10,spawnAdapterFactory:async()=>{throw Error('factory unobserved')}});
  expect(unknown.processEvidence).toMatchObject({identity,status:'unknown'});expect(unknown.treeStopped).toBe(false);
});

it('rejects unsupported hard resource freeze before launching an executor',async()=>{
  const f=fixture('export function execute(){throw Error()}');
  await expect(superviseAssignment({...f.input,requiredGuarantee:'hard-resource-lifetime'})).rejects.toThrow(/freeze refused/);
});

it('binds ordered preparation and shutdown private results to one outer identity',async()=>{
  const f=fixture("export function execute(c){return {prior:c.priorResults.length}}",'preparation',4000);
  const first=f.input.operations[0];
  f.input.operations=[{...first,deadlineEpochMs:Date.now()+2500},{...first,phase:'shutdown',deadlineEpochMs:f.input.resourceDeadlineEpochMs}];
  const receipt=await superviseAssignment(f.input);
  expect(receipt.terminal).toBe('completed');expect(receipt.results.map(r=>r.phase)).toEqual(['preparation','shutdown']);
  expect(JSON.parse(readFileSync(receipt.results[1].path,'utf8'))).toEqual({prior:1});
});

function recoveryFactoryFixture() {
  const f=fixture('export function execute(){}'); const root=f.root, repoRoot=join(root,'repo'), privateRoot=join(root,'private');
  const authRoot=join(root,'auth'),taskRoot=join(root,'task');
  for(const path of [privateRoot,join(authRoot,'payload'),taskRoot,join(repoRoot,'runner/boundary/evidence/fallback')]) mkdirSync(path,{recursive:true,mode:0o700});
  writeFileSync(join(authRoot,'payload/config.toml'),'synthetic-config',{mode:0o600});writeFileSync(join(authRoot,'payload/auth.json'),'synthetic-no-secret-auth',{mode:0o600});
  execFileSync('/usr/bin/git',['init','-q',taskRoot]);writeFileSync(join(taskRoot,'candidate'),'retained candidate');
  execFileSync('/usr/bin/git',['add','.'],{cwd:taskRoot});execFileSync('/usr/bin/git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture'],{cwd:taskRoot});
  const baseline=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:taskRoot,encoding:'utf8'}).trim();
  writeFileSync(join(taskRoot,'.git/config'),SAFE_GIT_CONFIG);
  const task=snapshotTask(taskRoot),context=snapshotTask(join(authRoot,'payload'),false,false);
  const state={authRoot,network:'cq-s5-test-network',broker:{containerId:'a'.repeat(64)},handedOff:true,hostTaskRoot:taskRoot,boundaryIdentity:'boundary',stage:{taskVolume:'cq-s5-task-'+'b'.repeat(16),contextVolume:'cq-s5-context-'+'c'.repeat(16),receiptHash:'d'.repeat(64),baselineCommit:baseline,contextInventoryHash:context.inventoryHash}};
  const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');const vmPath=join(root,'vm');writeFileSync(vmPath,'vm');
  const pins={daemon:{id:G2_EXPECTED_DAEMON_ID},vm:{configPath:vmPath,configHash:sha('vm')},workerImage:'sha256:'+'e'.repeat(64),brokerImage:'sha256:a0af04214c67a25e4c5ab01b20f6e6deea98fc664b65ae5532576949234adfe3',brokerIdentity:'broker',network:{internalSubnet:'subnet',brokerIP:'1.2.3.4'},nativeConfigHash:sha('synthetic-config')};
  const brokerAssetVolume='cq-s5-broker-assets-'+'f'.repeat(16),runId='recovery-test';
  const broker={State:{Running:true},Image:pins.brokerImage,Config:{User:'1000:1000',Entrypoint:['/usr/local/bin/node'],Cmd:['/opt/broker.mjs','/opt/config.json'],Labels:{'cq.boundary.runtime':runId,'cq.boundary.broker':'broker','cq.boundary.broker-runtime':FINAL_BROKER_RUNTIME_IDENTITY}},HostConfig:{ReadonlyRootfs:true,Privileged:false,PidMode:'',CapDrop:['ALL'],CapAdd:null,Binds:null,PortBindings:{}},Mounts:[{Type:'volume',Name:brokerAssetVolume,Destination:'/opt',RW:false}],NetworkSettings:{Networks:{bridge:{},[state.network]:{}}}};
  const data={state,pins,broker,brokerAssetVolume,runId,task:task.entries,context:context.entries,assets:brokerAssetTree().entries,assetHash:FINAL_BROKER_ASSET_INVENTORY};
  const dataPath=join(root,'mock-docker.json'),callsPath=join(root,'docker-calls.jsonl');writeFileSync(dataPath,JSON.stringify(data));
  const code=String.raw`import {readFileSync,appendFileSync} from 'node:fs';const d=JSON.parse(readFileSync(${JSON.stringify(dataPath)},'utf8'));export class DockerControl {async run(a){appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(a)+'\n');if(a[0]==='info')return d.observedDaemon??d.pins.daemon.id;if(a[0]==='image')return JSON.stringify([{Id:a[2]}]);if(a[0]==='inspect')return JSON.stringify([d.broker]);if(a[0]==='ps')return a.at(-1)==='volume='+d.brokerAssetVolume?d.state.broker.containerId:'';if(a[0]==='volume'&&a[1]==='ls')return d.state.stage.taskVolume+'\n'+d.state.stage.contextVolume;if(a[0]==='volume'&&a[1]==='inspect')return JSON.stringify([{Driver:'local',Options:{},Labels:a[2]===d.brokerAssetVolume?{'cq.boundary.runtime':d.runId,'cq.boundary.public-assets':d.assetHash}:{'cq.boundary.staging':d.state.stage.receiptHash}}]);if(a[0]==='network'&&a[1]==='ls')return '';if(a[0]==='network')return JSON.stringify([{Internal:true,EnableIPv6:false,Labels:{'cq.boundary.runtime':d.runId},IPAM:{Config:[{Subnet:d.pins.network.internalSubnet}]},Containers:{[d.state.broker.containerId]:{IPv4Address:d.pins.network.brokerIP+'/24'}}}]);if(a[0]==='exec')return a.at(-1).includes('readdirSync')?JSON.stringify(d.assets):'{}';throw Error('unexpected mock operation '+a[0])}async utility(a){return JSON.stringify(a.some(x=>x.includes('source='+d.state.stage.taskVolume))?d.task:d.context)}close(){appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(['close'])+'\n')}}export async function teardownContainer(){throw Error('unexpected teardown')}`;
  const files:Record<string,string>={'docker-control.ts':code,'codex-final-profile.ts':'export function validateFinalCodexAuth(){}','container.ts':'export function compileContainerBoundary(){}','egress-broker.ts':"export function compileBroker(){return {identity:'broker'}}",'task-staging.ts':`export {verifyGitBaseline} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'runner/boundary/task-staging.ts')).href)}`,'task-tree.ts':`export * from ${JSON.stringify(pathToFileURL(join(process.cwd(),'runner/boundary/task-tree.ts')).href)}`,'volume-io.mjs':'synthetic mocked volume read'};
  for(const [name,bytes] of Object.entries(files))writeFileSync(join(repoRoot,'runner/boundary',name),bytes);
  const pinsPath=join(repoRoot,'runner/boundary/evidence/fallback/final-profile-public-inputs.json');writeFileSync(pinsPath,JSON.stringify(pins));
  const plan={repoRoot,privateRoot,privateAuthRoot:authRoot,network:state.network,brokerContainerId:state.broker.containerId,runId,brokerAssetVolume,utilityImage:'sha256:'+'1'.repeat(64),runtimeSource:join(root,'operation.mjs'),runtimeSourceSha256:sha(readFileSync(join(root,'operation.mjs'))),publicInputsSha256:sha(readFileSync(pinsPath)),runtimeDependenciesSha256:{},sourcePins:{}};
  writeFileSync(join(privateRoot,'setup-state.json'),JSON.stringify(state),{mode:0o600});writeFileSync(join(privateRoot,'plan-hash.json'),JSON.stringify({sha256:sha(JSON.stringify(plan))}),{mode:0o600});
  return {plan,privateRoot,authRoot,taskRoot,callsPath,dataPath};
}
it('real recovery factory retains non-Git auth and requires Git candidate inventory',async()=>{
  const f=recoveryFactoryFixture();const runtime=await import(new URL('../runner/boundary/final-g1-runtime.mjs',import.meta.url).href);
  const owner=await runtime.createPreparedFinalG1Runtime(f.plan,{verify:false});await owner.cleanup();
  const receipt=JSON.parse(readFileSync(join(f.privateRoot,'recovery-receipt.json'),'utf8'));
  expect(receipt.complete).toBe(true);expect(receipt.resources).toContainEqual({kind:'private-tree',path:f.authRoot,inventoryHash:snapshotTask(f.authRoot,false,false).inventoryHash});
  expect(receipt.resources).toContainEqual({kind:'private-tree',path:f.taskRoot,inventoryHash:snapshotTask(f.taskRoot).inventoryHash});
  rmSync(join(f.taskRoot,'.git'),{recursive:true});await expect(owner.cleanup()).rejects.toThrow('task Git baseline required');
  expect(JSON.parse(readFileSync(join(f.privateRoot,'recovery-receipt.json'),'utf8')).complete).toBe(false);
},30000);
it('real prepared entrypoint awaits cleanup on native module load failure and preserves that cause',async()=>{
  const f=recoveryFactoryFixture();const privateInputPath=join(f.privateRoot,'input.json');writeFileSync(privateInputPath,JSON.stringify({plan:f.plan}),{mode:0o600});
  const runtime=await import(new URL('../runner/boundary/final-g1-runtime.mjs',import.meta.url).href);const assignmentId='final-profile-g1-'+f.plan.runId;
  await expect(runtime.executePreparedFinalG1Assignment({privateInputPath,identity:{...identity,assignmentId,attemptId:assignmentId+'-attempt-1'},preregister:async()=>{}})).rejects.toThrow(/run-final-profile-g1/);
  const receipt=JSON.parse(readFileSync(join(f.privateRoot,'recovery-receipt.json'),'utf8'));expect(receipt.complete).toBe(true);
  expect(readFileSync(f.callsPath,'utf8').split('\n').filter(x=>x==='["close"]').length).toBeGreaterThanOrEqual(2);
  rmSync(join(f.taskRoot,'.git'),{recursive:true});
  await expect(runtime.executePreparedFinalG1Assignment({privateInputPath,identity:{...identity,assignmentId,attemptId:assignmentId+'-attempt-1'},preregister:async()=>{}})).rejects.toThrow(/run-final-profile-g1/);
  expect(JSON.parse(readFileSync(join(f.privateRoot,'recovery-receipt.json'),'utf8')).complete).toBe(false);
},30000);

it('real recovery factory reports safe preregistration drift and retains incomplete recovery',async()=>{
  const f=recoveryFactoryFixture();const data=JSON.parse(readFileSync(f.dataPath,'utf8'));data.observedDaemon='rebuilt-daemon';writeFileSync(f.dataPath,JSON.stringify(data));
  const runtime=await import(new URL('../runner/boundary/final-g1-runtime.mjs',import.meta.url).href);
  const owner=await runtime.createPreparedFinalG1Runtime(f.plan,{verify:false});
  await expect(owner.cleanup()).rejects.toMatchObject({name:'DaemonPreregistrationMismatch'});
  expect(JSON.parse(readFileSync(join(f.privateRoot,'recovery-receipt.json'),'utf8')).complete).toBe(false);
  expect(readFileSync(f.callsPath,'utf8')).toContain('["close"]');
},30000);
