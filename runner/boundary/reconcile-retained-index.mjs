/** Read-only stopped-volume/host reconciliation. No candidate execution or Git command. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DockerControl } from './docker-control.ts';
import { snapshotTask, validateTaskEntries } from './task-tree.ts';
const sha=value=>createHash('sha256').update(value).digest('hex');
const utility='sha256:4a14ba40f65117679e6f60d0f7f7bfa5eb44ff9be79e96137966a1ba9675f9b0';
function indexEntries(buffer){
  if(buffer.toString('ascii',0,4)!=='DIRC'||buffer.readUInt32BE(4)!==2||createHash('sha1').update(buffer.subarray(0,-20)).digest('hex')!==buffer.subarray(-20).toString('hex'))throw Error('unsupported or invalid index');
  const fields=['ctimeSeconds','ctimeNanoseconds','mtimeSeconds','mtimeNanoseconds','device','inode','mode','uid','gid','size'];let offset=12;const entries=[];
  for(let i=0;i<buffer.readUInt32BE(8);i++){
    const start=offset,stat=Object.fromEntries(fields.map((name,n)=>[name,buffer.readUInt32BE(start+n*4)]));
    const object=buffer.subarray(start+40,start+60).toString('hex'),flags=buffer.readUInt16BE(start+60);
    if(flags&0x4000)throw Error('extended index unsupported');
    const end=buffer.indexOf(0,start+62);if(end<0)throw Error('invalid index entry');
    const path=buffer.toString('utf8',start+62,end);offset=start+Math.ceil((end-start+1)/8)*8;entries.push({path,stat,object,flags});
  }
  return {entries,extension:buffer.subarray(offset,-20).toString('hex')};
}
export async function reconcileRetainedIndex(privateRoot,hostRoot){
  const state=JSON.parse(readFileSync(join(privateRoot,'setup-state.json'))),plan=JSON.parse(readFileSync(join(privateRoot,'runtime.mjs'),'utf8').split('const plan=')[1].split(';\n')[0]);
  if(sha(JSON.stringify(plan))!==JSON.parse(readFileSync(join(privateRoot,'plan-hash.json'))).sha256)throw Error('private plan hash mismatch');
  if(state.authRoot!==plan.privateAuthRoot||state.network!==plan.network||state.broker.containerId!==plan.brokerContainerId||!/^cq-s5-task-[a-f0-9]{16}$/.test(state.stage.taskVolume))throw Error('ownership mismatch');
  const c=new DockerControl();
  try{
    if(await c.run(['info','--format','{{.ID}}'])!=='e15e4bd0-8a2f-4f5b-b335-2bd18da11100')throw Error('daemon changed');
    if(await c.run(['ps','-aq','--filter','volume='+state.stage.taskVolume]))throw Error('worker absence required');
    const volume=JSON.parse(await c.run(['volume','inspect',state.stage.taskVolume]))[0];
    if(volume.Driver!=='local'||Object.keys(volume.Options??{}).length||volume.Labels?.['cq.boundary.staging']!==state.stage.receiptHash||volume.Labels?.['cq.boundary.kind']!=='task')throw Error('volume identity mismatch');
    const script=readFileSync(new URL('./volume-io.mjs',import.meta.url),'utf8');
    const entries=JSON.parse(await c.utility(['--rm','--pull=never','--network','none','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','768m','--cpus','1','--mount',`type=volume,source=${state.stage.taskVolume},target=/task,readonly,volume-nocopy`,'--entrypoint','/usr/local/bin/node',utility,'-e',script,'read'],undefined,100*1024*1024));
    const retained=validateTaskEntries(entries,false,true),host=snapshotTask(hostRoot,false);
    const byPath=new Map(host.entries.map(e=>[e.path,e]));
    const differences=retained.entries.filter(e=>JSON.stringify(e)!==JSON.stringify(byPath.get(e.path))).map(e=>e.path);
    for(const e of host.entries)if(!retained.entries.some(r=>r.path===e.path))differences.push(e.path);
    const data=tree=>Buffer.from(tree.entries.find(e=>e.path==='.git/index').data,'base64');
    const old=indexEntries(data(retained)),fresh=indexEntries(data(host));
    const statDifferences=[];let indexContentEqual=old.extension===fresh.extension&&old.entries.length===fresh.entries.length;
    old.entries.forEach((e,i)=>{const n=fresh.entries[i];if(!n||e.path!==n.path||e.object!==n.object||e.flags!==n.flags)indexContentEqual=false;else{const fields=Object.keys(e.stat).filter(k=>e.stat[k]!==n.stat[k]);if(fields.length)statDifferences.push({path:e.path,fields});if(fields.some(k=>!['ctimeSeconds','ctimeNanoseconds','mtimeSeconds','mtimeNanoseconds','device','inode'].includes(k)))indexContentEqual=false;}});
    const judgement=join(privateRoot,'run17-judgement-record/protected-judgement.json');
    const receipt={retainedInventoryHash:retained.inventoryHash,hostInventoryHash:host.inventoryHash,entryCount:retained.entries.length,differences,indexStatDifferences:statDifferences,indexContentEqual,onlyIndexStatCacheChanged:differences.length===1&&differences[0]==='.git/index'&&indexContentEqual,indexHashes:{retained:sha(data(retained)),host:sha(data(host))},taskFiles:retained.entries.filter(e=>e.kind==='file'&&!e.path.startsWith('.git/')).map(e=>({path:e.path,mode:e.mode,sha256:sha(Buffer.from(e.data,'base64')),hostMatches:JSON.stringify(e)===JSON.stringify(byPath.get(e.path))})),judgementArtifactSha256:sha(readFileSync(judgement)),workerAbsent:!(await c.run(['ps','-aq','--filter','volume='+state.stage.taskVolume])),recoveryPreserved:true,publicationVerified:false,retroactiveStopProof:false,fullTaskComplete:false};
    const output=join(privateRoot,'index-reconciliation');mkdirSync(output,{mode:0o700});
    for(const [name,value]of Object.entries({'retained-manifest.json':retained,'host-manifest.json':host,'binding-receipt.json':receipt}))writeFileSync(join(output,name),JSON.stringify(value),{mode:0o600,flag:'wx'});
    return receipt;
  }finally{c.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await reconcileRetainedIndex(process.argv[2],process.argv[3])));}catch{console.error('read-only reconciliation refused; recovery unchanged');process.exitCode=1;}}
