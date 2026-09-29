/** Synthetic only: real pinned namespace + native supervisor + stopped export/publication.
 * No Codex/auth/broker/model. Never uses or deletes another run's recovery.
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { DockerControl } from './docker-control.ts';
import { stageTaskClone, publishStoppedTask } from './task-staging.ts';
import { containerTaskSession } from './task-session.ts';
import { finalContainerLifecycle, FINAL_NATIVE_IMAGE } from './codex-final-profile.ts';
import { snapshotTask } from './task-tree.ts';
const utilityImage = 'sha256:4a14ba40f65117679e6f60d0f7f7bfa5eb44ff9be79e96137966a1ba9675f9b0';
export async function probeFinalLifecycle(repoRoot) {
  const { runSupervised } = await import(pathToFileURL(join(resolve(repoRoot), 'runner/native/process.ts')));
  const root = mkdtempSync(join(tmpdir(), 'cq-s5-synthetic-lifecycle-')); chmodSync(root, 0o700);
  const source = join(root, 'task'), context = join(root, 'empty-context'); mkdirSync(source); mkdirSync(context, { mode: 0o700 });
  writeFileSync(join(source, 'tracked'), 'synthetic baseline\n');
  const git = args => execFileSync('/usr/bin/git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args], {
    cwd: source, env: { PATH:'/usr/bin:/bin', HOME:root, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1', GIT_OPTIONAL_LOCKS:'0' }, encoding:'utf8', timeout:10000,
  }).trim();
  git(['init','-q']); git(['add','tracked']); git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','baseline']);
  const baseline = git(['rev-parse','HEAD']); const receipt = await stageTaskClone({ taskRoot:source, contextRoot:context, baselineCommit:baseline, utilityImage });
  const c = new DockerControl(); let session; const events = []; let id;
  try {
    if (await c.run(['info','--format','{{.ID}}']) !== receipt.daemonId) throw new Error('synthetic daemon changed');
    id = await c.run(['create','--pull=never','--label','cq.boundary.synthetic='+receipt.receiptHash,'--network','none','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','256m','--memory-swap','256m','--cpus','0.5','--ipc','private','--cgroupns','private','--mount',`type=volume,source=${receipt.taskVolume},target=/task,volume-nocopy`,'--entrypoint','/usr/local/bin/node',FINAL_NATIVE_IMAGE,'-e',"require('fs').writeFileSync('/task/tracked','synthetic partial candidate\\n');require('fs').writeFileSync('/task/untracked','partial',{mode:448});require('child_process').spawn('/usr/local/bin/node',['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"]);
    session = containerTaskSession(receipt, id); await c.run(['start', id]);
    // Trusted positive control proves the fixture wrote before the timeout starts.
    await c.run(['exec',id,'/usr/local/bin/node','-e',"if(require('fs').readFileSync('/task/tracked','utf8')!=='synthetic partial candidate\\n')process.exit(1)"]);
    const result = await runSupervised('/synthetic/no-model', [], {
      cwd:source, identity:{assignmentId:'synthetic-lifecycle',stageId:'synthetic-stage',attemptId:'synthetic-attempt',invocationId:'synthetic-invocation'},
      stage:'final-profile-G1', expectedTaskBaselineCommit:baseline, timeoutMs:1000, hardDeadlineEpochMs:Date.now()+90000, killGraceMs:300,
      spawnAdapter:async () => {
        const child = spawn('/usr/local/bin/docker',[...c.prefix,'exec','-i',id,'/usr/local/bin/node','-e','setInterval(()=>{},1000)'],{env:c.environment,stdio:['pipe','pipe','pipe'],detached:true});
        const life = finalContainerLifecycle({child,budgetSeconds:20,
          terminate:async()=>{events.push('terminate-start');await session.terminate();events.push('namespace-absent');},
          exportTask:async()=>{events.push('export-start');const fresh=mkdtempSync(join(root,'.cq-stopped-export-'));chmodSync(fresh,0o700);const exported=await session.finalize(fresh);const publication=publishStoppedTask(receipt,fresh,source,{...exported,namespaceAbsent:true});events.push('publication-verified');return {...exported,publication};},
          cleanup:async()=>{await session.cleanup();events.push('synthetic-volumes-disposed');},closeControl:()=>{session.closeControl();events.push('control-closed');},
        });
        return {child,boundaryIdentity:'synthetic-only',launchIdentity:'synthetic-only',admissionId:'synthetic-only-no-model',environmentNames:[],scope:'boundary',isolation:'unverified',heldOut:false,terminate:life.terminate,finalize:life.finalize};
      },
    });
    const published = snapshotTask(source,false), proof = {
      provenance:'synthetic-no-model', terminal:result.terminal, processTreeStopped:result.treeStopped,
      terminated:result.lifecycle?.terminated===true, finalized:result.lifecycle?.finalized===true,
      lifecycleError:!!result.lifecycle?.error, publicationVerified:result.launch?.taskExport?.publication?.captureEligible===true,
      publishedInventoryMatches:result.launch?.taskExport?.inventoryHash===published.inventoryHash,
      namespaceAbsent:!(await c.run(['ps','-aq','--filter','id='+id])),
      partialCandidatePreserved:readFileSync(join(source,'tracked'),'utf8')==='synthetic partial candidate\n' && readFileSync(join(source,'untracked'),'utf8')==='partial',
      untrackedModePreserved:published.entries.find(e=>e.path==='untracked')?.mode===0o700,
      inventoryHash:published.inventoryHash, head:result.launch?.taskExport?.head??null, events,
      modelCalls:0, actualRouteQualified:false,
    };
    writeFileSync(join(root,'proof.json'),JSON.stringify(proof,null,2),{mode:0o600});
    return {privateEvidenceRoot:root,...proof};
  } finally {
    // Reap only this synthetic namespace on failure; retain its volumes for inspection.
    try { await session?.terminate(); } finally { session?.closeControl(); c.close(); }
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const proof=await probeFinalLifecycle(process.argv[2]);console.log(JSON.stringify(proof));if(!proof.terminated||!proof.finalized||!proof.namespaceAbsent||!proof.publicationVerified||!proof.partialCandidatePreserved||!proof.processTreeStopped)process.exitCode=1;}
  catch{console.error('synthetic lifecycle failed; private fixture recovery preserved');process.exitCode=1;}
}
