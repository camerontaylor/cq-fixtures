/** No-model synthetic real-daemon probe: SIGKILL host oracle while candidate awaits forever. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, chmodSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJudgeNamespacePlan, stableJudgeCandidateInventory, cleanupJudgeNamespace } from './judge-ownership.ts';
import { DockerControl } from './docker-control.ts';

const root = realpathSync(mkdtempSync(join(homedir(), '.tmp/cq-judge-kill-probe-'))); chmodSync(root, 0o700);
const module = 'settings/module.js', bytes = Buffer.from('export async function behavior(){await new Promise(()=>{})}');
const candidateRoot = join(root,'candidate'); mkdirSync(candidateRoot); mkdirSync(join(candidateRoot,'settings')); writeFileSync(join(candidateRoot,module), bytes, { mode: 0o600 });
const inventory = stableJudgeCandidateInventory(module,bytes);
const handle = createJudgeNamespacePlan({ privateParentRoot:root, identity:{assignmentId:'synthetic-kill',stageId:'protected-judge',attemptId:'synthetic-' + Date.now()},candidateSha256:inventory.inventoryHash,oraclePin:'a'.repeat(64),inventoryHashes:[inventory.inventoryHash] });
writeFileSync(join(root,'handle.json'),JSON.stringify(handle),{mode:0o600,flag:'wx'});
const control = new DockerControl();
const observer = spawn('/usr/local/bin/docker',[...control.prefix,'events','--filter','container='+handle.plan.slots[0].candidate,'--filter','event=start','--format','{{json .}}'],{env:control.environment,stdio:['ignore','pipe','pipe']});
observer.stderr.resume();
let child,childExit,proof,childStopped=false,eventObserved=false;
try {
  const code = `import {executeProtectedJudgeChild} from ${JSON.stringify(new URL('./judge-child.ts',import.meta.url).href)}; await executeProtectedJudgeChild(${JSON.stringify({candidateRoot,module,exportName:'behavior',requests:[[]],timeoutMs:15000})});`;
  child = spawn(process.execPath,['--experimental-transform-types','--input-type=module','-e',code],{cwd:root,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:homedir(),CQ_PROTECTED_JUDGE_PLAN:handle.planPath},detached:true,stdio:['ignore','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  const exit = once(child,'close');childExit=exit;
  let deadline;
  try {
    await Promise.race([new Promise((resolve,reject)=>{let text='';observer.stdout.on('data',b=>{text+=b.toString();if(text.length>32768)reject(new Error('event bound'));for(const line of text.split('\n').filter(Boolean)){try{const event=JSON.parse(line);if(event.Action==='start'&&event.Actor?.Attributes?.name===handle.plan.slots[0].candidate){eventObserved=true;resolve();}}catch{}}});}),exit.then(()=>{throw new Error('synthetic oracle ended before event');}),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('synthetic event deadline')),25000);})]);
  } finally {clearTimeout(deadline);}
  process.kill(-child.pid,'SIGKILL');await exit;childStopped=true;
  proof=await cleanupJudgeNamespace(handle,{hostProcessStopped:true,deadlineEpochMs:Date.now()+25000});
} finally {
  if(child&&!childStopped){try{process.kill(-child.pid,'SIGKILL')}catch{} await childExit?.catch(()=>{});childStopped=true;}
  observer.kill('SIGKILL');control.close();
  if(!proof)proof=await cleanupJudgeNamespace(handle,{hostProcessStopped:childStopped,deadlineEpochMs:Date.now()+25000});
  const receipt={synthetic:true,noModels:true,eventObserved,hostStopped:childStopped,proof,privatePlanPath:handle.planPath};
  writeFileSync(join(root,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({privateRoot:root,eventObserved,hostStopped:childStopped,cleanup:proof.cleanup,containersAbsent:proof.containersAbsent,volumeDisposition:proof.volumeDisposition,inventoryContentVerified:proof.inventoryContentVerified}));
}
if(!eventObserved||proof.cleanup!=='complete')process.exitCode=1;
