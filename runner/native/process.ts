import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { spawnBoundary } from '../boundary/spawn.ts';
import type { BoundaryLaunch } from '../boundary/spawn.ts';

export type ProcessTerminal = 'exit' | 'timeout' | 'cancelled' | 'spawn-error';

export interface SupervisedProcessResult {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  terminal: ProcessTerminal;
  startedAt: string;
  endedAt: string;
  launch?: NativeLaunchEvidence;
  error?: { name: string; message: string };
}

export interface NativeLaunchEvidence {
  boundaryIdentity: string;
  launchIdentity: string;
  admissionId: string;
  environmentNames: string[];
}

export interface NativeSpawnReceipt {
  child: ChildProcess;
  boundaryIdentity: string;
  launchIdentity: string;
  admissionId: string;
  environmentNames: string[];
}
export type NativeSpawnAdapter = (command: string, args: readonly string[], options: { cwd: string }) => Promise<NativeSpawnReceipt>;

export interface SupervisedProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  boundary?: Omit<BoundaryLaunch, 'executable' | 'args'>;
  spawnAdapter?: NativeSpawnAdapter;
  /** Explicitly for fake executables in tests; production launches fail closed without a boundary adapter. */
  allowUnconfinedTestProcess?: boolean;
}

const DEFAULT_KILL_GRACE_MS = 300;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Run one native CLI in its own process group and bound its complete lifetime. */
export async function runSupervised(
  command: string,
  args: readonly string[],
  options: SupervisedProcessOptions,
): Promise<SupervisedProcessResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  const startedAt = new Date().toISOString();
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminal: ProcessTerminal = 'exit';
  let spawnError: Error | undefined;
  let child: ChildProcess;
  let launch: SupervisedProcessResult['launch'];

  try {
    if (options.boundary) {
      if (options.boundary.purpose !== 'actual-route' || options.boundary.heldOut !== false) {
        throw new Error('native transport requires an explicitly admitted visible actual-route boundary');
      }
      if (resolve(options.boundary.policy.resolved.task) !== resolve(options.cwd)) {
        throw new Error('boundary task directory must match the invocation workspace');
      }
      const receipt = await spawnBoundary({ ...options.boundary, executable: command, args: [...args] });
      child = receipt.child;
      launch = {
        boundaryIdentity: receipt.boundaryIdentity, launchIdentity: receipt.launchIdentity,
        admissionId: receipt.admissionId ?? '', environmentNames: receipt.environmentNames,
      };
    } else if (options.spawnAdapter) {
      const receipt = await options.spawnAdapter(command, args, { cwd: options.cwd });
      child = receipt.child;
      launch = {
        boundaryIdentity: receipt.boundaryIdentity, launchIdentity: receipt.launchIdentity,
        admissionId: receipt.admissionId, environmentNames: receipt.environmentNames,
      };
    } else if (options.allowUnconfinedTestProcess) {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } else {
      throw new Error('native route launch requires boundary isolation and orchestrator admission');
    }
  } catch (error) {
    return spawnFailure(command, args, options.cwd, startedAt, error);
  }

  const collect = (target: string[], current: number, chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const remaining = Math.max(0, maxBytes - current);
    if (remaining > 0) target.push(chunk.subarray(0, remaining).toString('utf8'));
    if (stream === 'stdout') {
      stdoutBytes = current + chunk.length;
      options.onStdout?.(chunk.toString('utf8'));
    } else stderrBytes = current + chunk.length;
  };
  child.stdout?.on('data', (chunk: Buffer) => collect(stdoutParts, stdoutBytes, chunk, 'stdout'));
  child.stderr?.on('data', (chunk: Buffer) => collect(stderrParts, stderrBytes, chunk, 'stderr'));
  if (options.input !== undefined) child.stdin?.end(options.input);
  else child.stdin?.end();

  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  const snapshot = (code: number | null, signal: NodeJS.Signals | null): SupervisedProcessResult => ({
    command, args: [...args], cwd: options.cwd,
    stdout: stdoutParts.join(''), stderr: stderrParts.join(''), code, signal,
    terminal: spawnError ? 'spawn-error' : timedOut ? 'timeout' : cancelled ? 'cancelled' : terminal,
    startedAt, endedAt: new Date().toISOString(),
    ...(launch ? { launch } : {}),
    ...(spawnError ? { error: { name: spawnError.name, message: spawnError.message } } : {}),
  });
  let fallbackTimer: NodeJS.Timeout | undefined;
  const result = new Promise<SupervisedProcessResult>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      terminal = 'spawn-error';
    });
    child.once('close', (code, signal) => {
      // A leader can exit while a detached descendant remains in its process
      // group. Once stdout/stderr have drained, no group member is required by
      // this invocation; reap anything left even after a nominal completion.
      killTree(child, 'SIGTERM');
      resolve(snapshot(code, signal));
    });
  });

  const forceTimers: NodeJS.Timeout[] = [];
  const scheduleForceKill = () => {
    forceTimers.push(setTimeout(() => killTree(child, 'SIGKILL'), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
  };
  const onAbort = () => { cancelled = true; terminateTree(child); scheduleForceKill(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; terminateTree(child); scheduleForceKill(); }, options.timeoutMs);
  if (cancelled) onAbort();

  // The hard fallback bounds even a child that closes its leader early but
  // leaves a descendant holding an inherited pipe open.
  const forceResolveMs = options.timeoutMs + (options.killGraceMs ?? DEFAULT_KILL_GRACE_MS) + 2000;
  const forced = new Promise<SupervisedProcessResult>((resolve) => {
    fallbackTimer = setTimeout(() => {
      killTree(child, 'SIGKILL');
      resolve(snapshot(null, 'SIGKILL'));
    }, forceResolveMs);
  });
  try {
    return await Promise.race([result, forced]);
  } finally {
    clearTimeout(timer);
    for (const forceTimer of forceTimers) clearTimeout(forceTimer);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function terminateTree(child: ChildProcess): void {
  killTree(child, 'SIGTERM');
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function spawnFailure(
  command: string,
  args: readonly string[],
  cwd: string,
  startedAt: string,
  value: unknown,
): SupervisedProcessResult {
  const error = value instanceof Error ? value : new Error(String(value));
  return {
    command, args: [...args], cwd, stdout: '', stderr: '', code: null,
    signal: null, terminal: 'spawn-error', startedAt,
    endedAt: new Date().toISOString(),
    error: { name: error.name, message: error.message },
  };
}
