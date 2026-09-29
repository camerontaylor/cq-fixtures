/** Protected semantic judge child: only untrusted candidate code goes into VM.
 * Hidden judge/reference remain parent-side and never enter candidate input/image.
 * Returned stdout is PRIVATE/untrusted; never reintroduce it to model context.
 */
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { snapshotTask } from './task-tree.ts';
import { DockerControl, teardownContainer } from './docker-control.ts';
import { claimJudgeNamespaceSlot, stableJudgeCandidateInventory } from './judge-ownership.ts';
import { FINAL_NATIVE_IMAGE } from './codex-final-profile.ts';
import { G2_EXPECTED_DAEMON_ID, assertG2DaemonPreregistration } from './g2-daemon-contract.ts';

export const JUDGE_CHILD_BOOTSTRAP = `let s='';process.stdin.on('data',b=>{s+=b;if(s.length>65536)process.exit(125)});process.stdin.on('end',async()=>{try{const r=JSON.parse(s);const m=await import('file:///task/'+r.module);const f=m[r.exportName];if(typeof f!=='function')throw Error();const out=[];for(const args of r.requests)out.push(await f(...args));process.stdout.write(JSON.stringify(out))}catch{process.exit(125)}})`;
export interface JudgeChildRequest { candidateRoot: string; module: string; exportName: string; requests: unknown[][]; timeoutMs: number; }
export interface PrivateJudgeChildResult { stdout: Buffer; exitCode: number; timedOut: boolean; containerAbsentVerified: boolean; scope: 'protected-candidate-execution'; }
export function validateJudgeChildRequest(request: JudgeChildRequest): string {
  if (!/^[A-Za-z0-9_.\/-]+\.(?:js|mjs|cjs|ts)$/.test(request.module) || request.module.startsWith('/') || request.module.split('/').some(p => !p || p === '.' || p === '..') || !/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(request.exportName) || !Array.isArray(request.requests) || !request.requests.length || request.requests.length > 128 || request.requests.some(args => !Array.isArray(args) || args.length > 32) || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 15000) throw new Error('bounded behavioral candidate request required');
  const payload = JSON.stringify({ module: request.module, exportName: request.exportName, requests: request.requests });
  if (Buffer.byteLength(payload) > 65536) throw new Error('behavioral request exceeds limit'); return payload;
}
export async function executeProtectedJudgeChild(request: JudgeChildRequest): Promise<PrivateJudgeChildResult> {
  const payload = validateJudgeChildRequest(request);
  const snapshot = snapshotTask(request.candidateRoot, false, false);
  const moduleEntry = snapshot.entries.find(e => e.path === request.module && e.kind === 'file');
  if (!moduleEntry) throw new Error('plain candidate module required');
  const tree = stableJudgeCandidateInventory(request.module, Buffer.from(moduleEntry.data!, 'base64'));
  const planPath = process.env.CQ_PROTECTED_JUDGE_PLAN;
  const owned = planPath ? claimJudgeNamespaceSlot(planPath, tree.inventoryHash) : undefined;
  const control = new DockerControl(); const nonce = randomBytes(8).toString('hex'); const volume = owned?.slot.volume ?? 'cq-s5-judge-' + nonce;
  const identity = createHash('sha256').update(tree.inventoryHash + nonce).digest('hex');
  const labels = owned?.labels ?? { 'cq.boundary.judge': identity };
  const labelArgs = Object.entries(labels).flatMap(([key,value]) => ['--label', key + '=' + value]);
  let created = false; let container: string | undefined; let phase = 'daemon';
  try {
    assertG2DaemonPreregistration(G2_EXPECTED_DAEMON_ID, await control.run(['info', '--format', '{{.ID}}']));
    if ((await control.run(['volume', 'ls', '-q', '--filter', 'name=^' + volume + '$'])).split('\n').includes(volume)) throw new Error('judge private volume exists');
    if (owned) for (const name of [owned.slot.writer, owned.slot.candidate]) if (await control.run(['ps','-aq','--filter',`name=^/${name}$`])) throw new Error('judge preregistered container collision');
    phase = 'volume';
    await control.run(['volume', 'create', ...labelArgs, volume]); created = true;
    const stagedVolume = JSON.parse(await control.run(['volume','inspect',volume]))[0];
    if (stagedVolume.Name !== volume || stagedVolume.Driver !== 'local' || Object.keys(stagedVolume.Options ?? {}).length || Object.entries(labels).some(([k,v]) => stagedVolume.Labels?.[k] !== v) || await control.run(['ps','-aq','--filter','volume=' + volume])) throw new Error('judge new volume ownership changed');
    const writer = readFileSync(new URL('./volume-io.mjs', import.meta.url), 'utf8');
    phase = 'staging';
    const writerArgs = ['--rm', ...(owned ? ['--name', owned.slot.writer, ...labelArgs] : []), '-i', '--pull=never', '--network', 'none', '--user', '0:0', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '768m', '--cpus', '0.5', '--mount', `type=volume,source=${volume},target=/task,volume-nocopy`, '--entrypoint', '/usr/local/bin/node', FINAL_NATIVE_IMAGE, '--input-type=module', '-e', writer, 'write'];
    if (owned) await control.run(['run', ...writerArgs], JSON.stringify(tree.entries));
    else await control.utility(writerArgs, JSON.stringify(tree.entries));
    phase = 'container';
    container = await control.run(['create', ...(owned ? ['--name', owned.slot.candidate] : []), '-i', '--pull=never', ...labelArgs, '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--ipc', 'private', '--cgroupns', 'private', '--workdir', '/task', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=1000,gid=1000,size=8m', '--mount', `type=volume,source=${volume},target=/task,readonly`, '--env', 'HOME=/tmp/empty-home', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--entrypoint', '/usr/local/bin/node', FINAL_NATIVE_IMAGE, '-e', JUDGE_CHILD_BOOTSTRAP]);
    phase = 'execution';
    let timedOut = false;
    // Kill namespace/init, not just Docker client. Trusted teardown occurs even on stdout overflow/error.
    let disposal: Promise<void> | undefined;
    const dispose = () => disposal ??= teardownContainer(control, container!);
    const deadline = setTimeout(() => { timedOut = true; void dispose().catch(() => { /* awaited below */ }); }, request.timeoutMs);
    let stdout = Buffer.alloc(0); let exitCode = 125;
    try { stdout = Buffer.from(await control.run(['start', '-ai', container], payload, 256 * 1024)); exitCode = 0; }
    catch { /* bounded untrusted failure output deliberately not surfaced */ }
    finally { clearTimeout(deadline); await dispose(); }
    return { stdout, exitCode, timedOut, containerAbsentVerified: true, scope: 'protected-candidate-execution' };
  } catch { throw new Error('protected judge unavailable at ' + phase); } finally {
    try {
      if (container) await teardownContainer(control, container);
      if (created && !owned) { const v = JSON.parse(await control.run(['volume', 'inspect', volume]))[0]; if (v.Labels?.['cq.boundary.judge'] !== identity || await control.run(['ps', '-aq', '--filter', 'volume=' + volume])) throw new Error('judge recovery ownership changed'); await control.run(['volume', 'rm', volume]); }
    } finally { control.close(); }
  }
}
