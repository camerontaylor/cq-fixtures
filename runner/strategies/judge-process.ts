/** Cancellable POSIX process-group supervisor for serializable host-judge work. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unknownUsage } from './index.ts';
import type { IndependentJudgeExecution, IndependentJudgeSettlementProof } from './executor.ts';
import type { JudgeProcessIdentity, ReviewLoopJudgeProcessRequest, ReviewLoopJudgeProcessResult } from './judge-protocol.ts';

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const TERM_GRACE_MS = 500;
const CHILD_ENTRYPOINT = fileURLToPath(new URL('./judge-child.ts', import.meta.url));

interface ProcessControl {
  identity: JudgeProcessIdentity;
  child: ChildProcess;
  resultPath: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  proof: Promise<IndependentJudgeSettlementProof> | null;
  outputOverflow: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stderrTail: string;
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameIdentity(left: JudgeProcessIdentity, right: JudgeProcessIdentity): boolean {
  return left.assignmentId === right.assignmentId && left.stageId === right.stageId && left.attemptId === right.attemptId;
}

function positiveDeadlineMs(epochMs: number): number {
  return Math.max(0, Math.floor(epochMs - Date.now()));
}

function groupExists(pgid: number): boolean | null {
  try { process.kill(-pgid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pgid, signal); return true; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitForExit(control: ProcessControl, deadlineEpochMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      control.exit.then(() => true),
      new Promise<boolean>((resolveWait) => { timer = setTimeout(() => resolveWait(false), positiveDeadlineMs(deadlineEpochMs)); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function waitForGroupGone(pgid: number, deadlineEpochMs: number): Promise<boolean> {
  for (;;) {
    const exists = groupExists(pgid);
    if (exists === false) return true;
    if (exists === null || Date.now() >= deadlineEpochMs) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(20, Math.max(1, deadlineEpochMs - Date.now()))));
  }
}

function stopProof(identity: JudgeProcessIdentity, stopped: boolean): IndependentJudgeSettlementProof {
  return {
    ...identity,
    processTree: stopped ? 'stopped-and-reaped' : 'running-or-unknown',
    execution: stopped ? 'settled' : 'unsettled',
    cleanup: stopped ? 'complete' : 'failed',
  };
}

function terminate(
  control: ProcessControl,
  deadlineEpochMs: number,
  groupGoneProbe: (pgid: number, deadlineEpochMs: number) => Promise<boolean> = waitForGroupGone,
): Promise<IndependentJudgeSettlementProof> {
  if (control.proof) return control.proof;
  control.proof = (async () => {
    const pgid = control.child.pid;
    if (!pgid) return stopProof(control.identity, false);
    signalGroup(pgid, 'SIGTERM');
    const termDeadline = Math.min(deadlineEpochMs, Date.now() + TERM_GRACE_MS);
    const leaderExited = await waitForExit(control, termDeadline);
    const groupGone = await groupGoneProbe(pgid, termDeadline);
    if (!leaderExited || !groupGone) {
      signalGroup(pgid, 'SIGKILL');
      const finalLeaderExit = await waitForExit(control, deadlineEpochMs);
      const finalGroupGone = await groupGoneProbe(pgid, deadlineEpochMs);
      return stopProof(control.identity, finalLeaderExit && finalGroupGone);
    }
    return stopProof(control.identity, true);
  })();
  return control.proof;
}

function privateEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  }
  return env;
}

function assertRequest(value: ReviewLoopJudgeProcessRequest): void {
  if (value.schemaVersion !== 1 || !value.identity.assignmentId || !value.identity.stageId || !value.identity.attemptId) {
    throw new Error('invalid independent judge process request');
  }
  if (value.identity.assignmentId !== value.experiment.assignmentId || value.identity.stageId !== value.experiment.stageId
    || value.identity.attemptId !== value.experiment.attemptId) throw new Error('independent judge process identity mismatch');
  if (!isAbsolute(value.s1DependencyRoot)) throw new Error('independent judge S1 dependency root must be absolute');
  if (!/^[a-f0-9]{64}$/i.test(value.candidate.sha256) || hash(value.candidate.patch) !== value.candidate.sha256) {
    throw new Error('independent judge candidate hash mismatch');
  }
}

export interface IndependentJudgeProcessSupervisorOptions {
  /** Test seam for proving cleanup failures; production callers use the default process-group probe. */
  readonly groupGone?: (pgid: number, deadlineEpochMs: number) => Promise<boolean>;
  readonly childEntrypoint?: string;
  readonly privateRoot?: string;
}

/**
 * This supervisor accepts only a frozen JSON DTO. It never accepts or invokes
 * a caller closure in the child process.
 */
export class IndependentJudgeProcessSupervisor {
  private readonly active = new Map<string, ProcessControl>();
  private readonly completed = new Map<string, IndependentJudgeSettlementProof>();
  private readonly childEntrypoint: string;
  private readonly groupGone: (pgid: number, deadlineEpochMs: number) => Promise<boolean>;
  private readonly privateRoot: string;

  constructor(options: IndependentJudgeProcessSupervisorOptions = {}) {
    if (process.platform === 'win32') throw new Error('independent judge process groups require POSIX detached process semantics');
    this.childEntrypoint = resolve(options.childEntrypoint ?? CHILD_ENTRYPOINT);
    this.groupGone = options.groupGone ?? waitForGroupGone;
    this.privateRoot = resolve(options.privateRoot ?? tmpdir());
    mkdirSync(this.privateRoot, { recursive: true, mode: 0o700 });
  }

  async run(request: ReviewLoopJudgeProcessRequest, signal: AbortSignal): Promise<IndependentJudgeExecution> {
    assertRequest(request);
    if (signal.aborted) throw signal.reason ?? new Error('independent judge cancelled before process launch');
    if (Date.now() >= request.deadlineEpochMs) throw new Error('independent judge deadline elapsed before process launch');
    if (this.active.has(request.identity.attemptId)) throw new Error('independent judge attempt already has an active process');

    const processRoot = mkdtempSync(join(this.privateRoot, `s4-judge-${randomUUID()}-`));
    const requestPath = join(processRoot, 'request.json');
    const resultPath = join(processRoot, 'result.json');
    const artifactRoot = join(processRoot, 'artifacts');
    mkdirSync(join(processRoot, 'home'), { mode: 0o700 });
    mkdirSync(join(processRoot, 'tmp'), { mode: 0o700 });
    // S1's pinned protected-oracle client resolves this one fixed local socket
    // beneath HOME. Expose only the socket through a private-home symlink;
    // do not pass through the caller's HOME or provider credentials.
    const protectedOracleSocket = join(homedir(), '.colima', 'cq-boundary-s5', 'docker.sock');
    const privateOracleSocket = join(processRoot, 'home', '.colima', 'cq-boundary-s5', 'docker.sock');
    mkdirSync(dirname(privateOracleSocket), { recursive: true, mode: 0o700 });
    symlinkSync(protectedOracleSocket, privateOracleSocket);
    const childRequest = { ...request, processRoot, artifactRoot };
    const requestBytes = Buffer.from(`${JSON.stringify(childRequest)}\n`);
    const requestSha256 = hash(requestBytes);
    writeFileSync(requestPath, requestBytes, { flag: 'wx', mode: 0o600 });
    const startedAt = performance.now();
    const child = spawn(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--experimental-strip-types', this.childEntrypoint,
      requestPath, resultPath, requestSha256,
    ], {
      cwd: processRoot,
      env: privateEnvironment(processRoot),
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const control: ProcessControl = {
      identity: request.identity, child, resultPath,
      exit: new Promise((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', (code, signalName) => resolveExit({ code, signal: signalName }));
      }),
      proof: null, outputOverflow: false, stdoutBytes: 0, stderrBytes: 0,
      stderrTail: '',
    };
    this.active.set(request.identity.attemptId, control);
    const overflowController = new AbortController();
    const collect = (stream: NodeJS.ReadableStream | null, which: 'stdout' | 'stderr'): void => {
      stream?.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const totalKey = which === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
        control[totalKey] += bytes.byteLength;
        if (which === 'stderr') {
          control.stderrTail = `${control.stderrTail}${bytes.toString('utf8')}`.slice(-8_192);
        }
        if (control[totalKey] > (which === 'stdout' ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES)) {
          control.outputOverflow = true;
          overflowController.abort();
          return;
        }
      });
    };
    collect(child.stdout, 'stdout');
    collect(child.stderr, 'stderr');

    let stopCause: unknown;
    let stopPromise: Promise<IndependentJudgeSettlementProof> | null = null;
    let signalStop!: (value: void) => void;
    const stoppedSignal = new Promise<void>((resolveStop) => { signalStop = resolveStop; });
    const requestStop = (cause: unknown): void => {
      if (stopPromise) return;
      stopCause = cause;
      stopPromise = terminate(control, request.shutdownDeadlineEpochMs, this.groupGone);
      signalStop();
    };
    const stopForOverflow = () => requestStop(new Error('independent judge exceeded bounded stdout/stderr allowance'));
    overflowController.signal.addEventListener('abort', stopForOverflow, { once: true });
    if (control.outputOverflow) stopForOverflow();
    const abortListener = () => requestStop(signal.reason ?? new Error('independent judge cancelled'));
    signal.addEventListener('abort', abortListener, { once: true });
    const timer = setTimeout(() => requestStop(new Error('independent judge decision deadline exceeded')), positiveDeadlineMs(request.deadlineEpochMs));

    try {
      const first = await Promise.race([
        control.exit.then((exit) => ({ kind: 'exit' as const, exit })),
        stoppedSignal.then(() => ({ kind: 'stop' as const })),
      ]);
      if (first.kind === 'stop') {
        const proof = await stopPromise!;
        this.completed.set(request.identity.attemptId, proof);
        if (proof.cleanup !== 'complete') throw new Error('independent judge process group did not stop within the bounded cleanup window');
        throw stopCause instanceof Error ? stopCause : new Error(String(stopCause));
      }
      if (Date.now() >= request.deadlineEpochMs || signal.aborted) {
        requestStop(signal.reason ?? new Error('independent judge result arrived after its decision deadline'));
        const proof = await stopPromise!;
        this.completed.set(request.identity.attemptId, proof);
        if (proof.cleanup !== 'complete') throw new Error('late judge process cleanup could not be proven');
        throw new Error('independent judge result arrived after its decision deadline');
      }

      const naturalExitProof = await terminate(control, Math.min(request.shutdownDeadlineEpochMs, Date.now() + 5_000), this.groupGone);
      this.completed.set(request.identity.attemptId, naturalExitProof);
      if (naturalExitProof.cleanup !== 'complete') throw new Error('independent judge child left an unreaped process group');
      if (first.exit.code !== 0) throw new Error(`independent judge child exited with status ${String(first.exit.code)} / ${String(first.exit.signal)}: ${control.stderrTail.trim() || '(no stderr)'}`);
      if (control.outputOverflow) throw new Error('independent judge child exceeded the bounded stdout/stderr allowance');
      const stat = lstatSync(resultPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESULT_BYTES) throw new Error('independent judge child result is missing or outside its size bound');
      const bytes = readFileSync(resultPath);
      const envelope = JSON.parse(bytes.toString('utf8')) as ReviewLoopJudgeProcessResult;
      const canonicalPayload = Buffer.from(JSON.stringify(envelope.payload));
      if (envelope.schemaVersion !== 1 || envelope.requestSha256 !== requestSha256
        || envelope.payload?.requestSha256 !== requestSha256 || envelope.payloadSha256 !== hash(canonicalPayload)
        || !sameIdentity(envelope.payload.identity, request.identity)
        || envelope.payload.selection.candidateSha256 !== request.candidate.sha256
        || envelope.payload.selection.judgePin !== request.oraclePin) {
        throw new Error('independent judge child result identity or content hash mismatch');
      }
      const row = envelope.payload.rows.find((item) => item.case === request.caseId);
      const outcome = row?.taskOutcome;
      const selected = outcome?.judgements.find((item) => item.judgementId === envelope.payload.selection.judgementId
        && item.version === envelope.payload.selection.version && item.candidateSha256 === request.candidate.sha256
        && item.judgePin === request.oraclePin);
      if (!outcome || !selected || outcome.judgements.filter((item) => item.judgementId === selected.judgementId
        && item.version === selected.version).length !== 1) throw new Error('independent judge child output does not contain the exact frozen judgement');
      const serviceTimeMs = Math.max(0, performance.now() - startedAt);
      const evidence = {
        rows: envelope.payload.rows, tables: envelope.payload.tables, diagnostics: envelope.payload.diagnostics,
        selection: envelope.payload.selection, requestSha256, payloadSha256: envelope.payloadSha256,
        artifactRoot, processRoot,
      };
      return {
        result: {
          status: 'completed', usage: unknownUsage(), serviceTimeMs, launched: false,
          judgement: {
            status: outcome.candidateCorrectness === null ? 'unavailable' : 'valid',
            correctness: outcome.candidateCorrectness,
            detail: 'S1 child runSuite host oracle; deterministic candidate injection is not model usage.',
          },
        }, evidence,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortListener);
      overflowController.signal.removeEventListener('abort', stopForOverflow);
      if (control.proof) this.completed.set(request.identity.attemptId, await control.proof);
      this.active.delete(request.identity.attemptId);
    }
  }

  async cancelAndWait(input: {
    identity: JudgeProcessIdentity;
    cause: unknown;
    deadlineEpochMs: number;
  }): Promise<IndependentJudgeSettlementProof> {
    const control = this.active.get(input.identity.attemptId);
    if (control) {
      if (!sameIdentity(control.identity, input.identity)) return stopProof(input.identity, false);
      const proof = await terminate(control, input.deadlineEpochMs, this.groupGone);
      this.completed.set(input.identity.attemptId, proof);
      return proof;
    }
    const proof = this.completed.get(input.identity.attemptId);
    return proof && sameIdentity(proof, input.identity) ? proof : stopProof(input.identity, false);
  }
}

export function createIndependentJudgeProcessSupervisor(options?: IndependentJudgeProcessSupervisorOptions): IndependentJudgeProcessSupervisor {
  return new IndependentJudgeProcessSupervisor(options);
}
