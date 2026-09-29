import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
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
