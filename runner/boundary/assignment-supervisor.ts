import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupervisedInvocationIdentity } from '../native/process.ts';

export type AssignmentPhase = 'preparation' | 'execution' | 'capture' | 'judge' | 'shutdown';
export interface AssignmentOperation {
  phase: AssignmentPhase;
  modulePath: string;
  moduleSha256: string;
  exportName: string;
  /** Private file reference only; never credentials, closures or oracle via IPC. */
  privateInputPath: string;
  deadlineEpochMs: number;
}
export interface AssignmentResource { kind: 'container' | 'volume' | 'network' | 'private-file'; id: string }
export interface AssignmentReceipt {
  version: 'assignment-supervisor-v1'; identity: SupervisedInvocationIdentity;
  terminal: 'completed' | 'timeout' | 'cancelled' | 'failed';
  primaryCause: string | null; phase: AssignmentPhase | null;
  hostProcessTree: 'stopped-and-reaped' | 'unknown';
  resourceLifetime: 'unsupported';
  registryPath: string; registrySha256: string;
  quarantine: 'not-needed' | 'retained' | 'unknown';
  results: Array<{ phase: AssignmentPhase; path: string; sha256: string }>;
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const phases: AssignmentPhase[] = ['preparation', 'execution', 'capture', 'judge', 'shutdown'];
function privateFile(path: string): void {
  const s = lstatSync(path);
  if (realpathSync(path) !== path || !s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error('private supervisor file required');
}
function save(path: string, value: unknown, exclusive = false): void {
  const fd = openSync(path, exclusive ? 'wx' : 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
function validResource(value: AssignmentResource, root: string): boolean {
  return !!value && (['container', 'volume', 'network'].includes(value.kind)
    ? /^cq-s5-[a-z0-9-]{1,90}$/.test(value.id) || (value.kind === 'container' && /^[a-f0-9]{64}$/.test(value.id))
    : value.kind === 'private-file' && resolve(value.id) === value.id && value.id.startsWith(root + '/'));
}
function alive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/** Absolute host reap bound. Detached namespaces/daemon resources require their
 * own authoritative enforcement; this receipt deliberately claims no hard cap. */
async function reap(pid: number | undefined, deadline: number): Promise<boolean> {
  if (!pid || process.platform === 'win32') return false;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* verify absence below */ }
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
  }
  return !alive(pid);
}
export async function superviseAssignment(input: {
  identity: SupervisedInvocationIdentity; privateRoot: string;
  operations: AssignmentOperation[];
  /** Trusted caller freezes allowed module/export pairs before request construction. */
  allowedOperations: Array<Pick<AssignmentOperation, 'modulePath' | 'moduleSha256' | 'exportName'>>;
  resources: AssignmentResource[];
  resourceDeadlineEpochMs: number; reapDeadlineEpochMs: number; quarantineDeadlineEpochMs: number;
  signal?: AbortSignal;
  /** Remote daemon hard lifetime is unsupported and rejected before launch. */
  requiredGuarantee?: 'host-process-group' | 'hard-resource-lifetime';
  /** Parent-only hook; observes durable registry AFTER host reap. Timeout never
   * grants namespace absence. Recovery deletion is not part of this API. */
  quarantine?: (request: { identity: SupervisedInvocationIdentity; resources: AssignmentResource[]; deadlineEpochMs: number; signal: AbortSignal }) => Promise<void>;
}): Promise<AssignmentReceipt> {
  if (input.requiredGuarantee === 'hard-resource-lifetime') throw new Error('hard resource lifetime unsupported; freeze refused');
  if (process.platform === 'win32') throw new Error('independent process-group reap unavailable');
  const root = resolve(input.privateRoot), stat = lstatSync(root);
  if (realpathSync(root) !== root || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('exclusive private supervisor root required');
  if (Object.keys(input.identity).sort().join(',') !== 'assignmentId,attemptId,invocationId,stageId' || Object.values(input.identity).some(v => typeof v !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(v))) throw new Error('exact supervisor invocation identity required');
  const limits = [input.resourceDeadlineEpochMs, input.reapDeadlineEpochMs, input.quarantineDeadlineEpochMs];
  if (limits.some(v => !Number.isFinite(v)) || limits[0] <= Date.now() || limits[1] < limits[0] || limits[2] < limits[1] || limits[2] - Date.now() > 3600_000) throw new Error('bounded absolute supervisor deadlines required');
  if (!input.operations.length || input.operations.length > 5) throw new Error('bounded phase operations required');
  let previous = -1;
  for (const op of input.operations) {
    const index = phases.indexOf(op.phase);
    if (index <= previous || !Number.isFinite(op.deadlineEpochMs) || op.deadlineEpochMs > limits[0] || op.deadlineEpochMs <= Date.now()) throw new Error('ordered bounded phase operation required');
    previous = index;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(op.exportName) || realpathSync(op.modulePath) !== op.modulePath || !/^[a-f0-9]{64}$/.test(op.moduleSha256) || hash(readFileSync(op.modulePath)) !== op.moduleSha256 ||
      !input.allowedOperations.some(a => a.modulePath === op.modulePath && a.moduleSha256 === op.moduleSha256 && a.exportName === op.exportName)) throw new Error('operation differs from independently allowed module bytes/export');
    privateFile(op.privateInputPath);
  }
  if (input.resources.length > 256 || input.resources.some(r => !validResource(r, root))) throw new Error('invalid preregistered resources');
  const identity = structuredClone(input.identity), resources = structuredClone(input.resources);
  const registryPath = join(root, `ownership-${identity.invocationId}.json`);
  const registry = { version: 'assignment-ownership-v1', identity, resources, state: 'preregistered' };
  save(registryPath, registry, true);
  const jobPath = join(root, `executor-${identity.invocationId}.json`);
  save(jobPath, { identity, operations: input.operations.map(op => ({ ...op, privateInputSha256: hash(readFileSync(op.privateInputPath)) })), privateRoot: root }, true);
  const local = new URL('./assignment-supervisor.executor.mjs', import.meta.url);
  const executor = fileURLToPath(existsSync(local) ? local : new URL('../../runner/boundary/assignment-supervisor.executor.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--experimental-transform-types', executor, jobPath, hash(readFileSync(jobPath))], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  let phase: AssignmentPhase | null = input.operations[0].phase;
  const outcome: { terminal: AssignmentReceipt['terminal']; primaryCause: string | null } = { terminal: 'failed', primaryCause: 'ExecutorExit' };
  const results: AssignmentReceipt['results'] = [];
  let done = false, timer: NodeJS.Timeout | undefined;
  let finish!: () => void;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const end = (status: AssignmentReceipt['terminal'], cause: string | null) => {
    if (done) return; done = true; outcome.terminal = status; outcome.primaryCause = cause; finish();
  };
  const arm = (deadline: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => end('timeout', 'DeadlineExceeded'), Math.max(0, Math.min(deadline, limits[0]) - Date.now()));
  };
  const cancel = () => end('cancelled', 'OperatorCancelled');
  input.signal?.addEventListener('abort', cancel, { once: true });
  child.once('error', () => end('failed', 'ExecutorSpawnFailed'));
  child.once('exit', () => end('failed', 'ExecutorExit'));
  child.on('message', raw => {
    if (done || Date.now() >= limits[0]) { end('timeout', 'DeadlineExceeded'); return; }
    if (!raw || typeof raw !== 'object') { end('failed', 'InvalidExecutorMessage'); return; }
    const m = raw as { identity?: SupervisedInvocationIdentity; type?: string; phase?: AssignmentPhase; resource?: AssignmentResource; sequence?: number; path?: string; sha256?: string };
    if (JSON.stringify(m.identity) !== JSON.stringify(identity)) { end('failed', 'ExecutorIdentityMismatch'); return; }
    if (m.type === 'register') {
      if (!m.resource || !validResource(m.resource, root) || resources.length >= 256) { end('failed', 'InvalidResourceRegistration'); return; }
      if (!resources.some(r => r.id === m.resource!.id && r.kind === m.resource!.kind)) resources.push(m.resource);
      try {
        save(registryPath, registry); // durable before ACK; child must not create before ACK
        if (child.connected) child.send({ type: 'registered', sequence: m.sequence }, error => { if (error) end('failed', 'RegistrationAckFailed'); });
      } catch { end('failed', 'OwnershipPersistenceFailed'); }
    } else if (m.type === 'result') {
      const op = input.operations[results.length];
      if (!op || m.phase !== op.phase || Date.now() >= op.deadlineEpochMs || m.path !== join(root, `result-${identity.invocationId}-${results.length}.json`)) { end('failed', 'InvalidPhaseResult'); return; }
      try { privateFile(m.path); if (hash(readFileSync(m.path)) !== m.sha256) throw new Error(); }
      catch { end('failed', 'InvalidPrivateResult'); return; }
      results.push({ phase: op.phase, path: m.path, sha256: m.sha256! });
      const next = input.operations[results.length];
      if (next) { phase = next.phase; arm(next.deadlineEpochMs); }
      else end('completed', null);
    } else if (m.type === 'failure') end('failed', 'OperationFailed');
    else end('failed', 'InvalidExecutorMessage');
  });
  arm(input.operations[0].deadlineEpochMs);
  if (input.signal?.aborted) cancel();
  await settled;
  if (timer) clearTimeout(timer);
  input.signal?.removeEventListener('abort', cancel);
  child.removeAllListeners('message');
  if (child.connected) child.disconnect();
  const stopped = await reap(child.pid, limits[1]);
  child.unref();
  const { terminal, primaryCause } = outcome;
  let quarantine: AssignmentReceipt['quarantine'] = terminal === 'completed' ? 'not-needed' : 'retained';
  registry.state = terminal === 'completed' ? 'settled' : 'quarantined'; save(registryPath, registry);
  if (terminal !== 'completed' && input.quarantine) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(0, limits[2] - Date.now()));
    try {
      await Promise.race([input.quarantine({ identity, resources: structuredClone(resources), deadlineEpochMs: limits[2], signal: controller.signal }),
        new Promise<never>((_, reject) => { if (controller.signal.aborted) reject(new Error()); else controller.signal.addEventListener('abort', () => reject(new Error()), { once: true }); })]);
    } catch { quarantine = 'unknown'; } finally { clearTimeout(t); }
  }
  // Values are detached and deeply frozen; late child/hook continuation cannot
  // change accepted proof. The durable registry always remains for recovery.
  const receipt: AssignmentReceipt = { version: 'assignment-supervisor-v1', identity, terminal, primaryCause, phase,
    hostProcessTree: stopped ? 'stopped-and-reaped' : 'unknown', resourceLifetime: 'unsupported', registryPath,
    registrySha256: hash(readFileSync(registryPath)), quarantine, results: structuredClone(results) };
  if (!stopped && terminal === 'completed') { receipt.terminal = 'failed'; receipt.primaryCause = 'HostReapUnproven'; }
  const freeze = (v: object) => { Object.freeze(v); for (const x of Object.values(v)) if (x && typeof x === 'object') freeze(x); };
  freeze(receipt); chmodSync(registryPath, 0o600);
  return receipt;
}
