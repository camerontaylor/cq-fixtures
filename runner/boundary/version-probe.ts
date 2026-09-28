import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileBoundary } from './policy.ts';
import { spawnBoundary } from './spawn.ts';

/** Offline executable startup only. This cannot establish route/auth/tool conformance. */
export async function probeNativeVersion(options: {
  label: string;
  executable: string;
  script?: string;
  requiredFiles?: string[];
  requiredTrees?: string[];
}): Promise<{
  label: string; observedAt: string; viable: boolean; version: string | null;
  exitCode: number | null; signal: string | null; failureCode: string | null; timedOut: boolean;
  policy: ReturnType<typeof compileBoundary> | null;
  g2: 'not-established';
}> {
  const result = { label: options.label, observedAt: new Date().toISOString(), viable: false,
    version: null as string | null, exitCode: null as number | null, signal: null as string | null, failureCode: null as string | null, timedOut: false,
    policy: null as ReturnType<typeof compileBoundary> | null, g2: 'not-established' as const };
  if (process.platform !== 'darwin') return result;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cq-boundary-version-')));
  try {
    const dirs = Object.fromEntries(['task', 'context', 'home', 'tmp', 'hidden'].map((name) => {
      const path = join(root, name); mkdirSync(path); return [name, path];
    }));
    const policy = compileBoundary({ bundle: root, task: dirs.task, context: dirs.context, home: dirs.home,
      temporary: dirs.tmp, toolchain: [
        ...[...(options.requiredFiles ?? []), ...(options.script ? [options.script] : [])]
          .map((path) => ({ path, kind: 'file' as const, reason: 'offline --version startup dependency' })),
        ...(options.requiredTrees ?? []).map((path) => ({ path, kind: 'tree' as const, reason: 'offline --version runtime code distribution' })),
      ],
      authentication: [], executables: [options.executable], forbidden: [dirs.hidden], endpoints: [],
      extensions: { mode: 'disabled', launchEvidence: null } });
    result.policy = policy;
    const launch = await spawnBoundary({ policy, executable: options.executable,
      args: [...(options.script ? [realpathSync(options.script)] : []), '--version'], purpose: 'no-model-probe' });
    let stdout = '';
    launch.child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString(); });
    let failureCode: string | null = null;
    launch.child.stderr.on('data', (chunk: Buffer) => {
      const match = chunk.toString().match(/\b(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|EACCES|EPERM)\b/);
      if (match) failureCode = match[1];
    });
    launch.child.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (launch.child.pid) { try { process.kill(-launch.child.pid, 'SIGKILL'); } catch { /* exited */ } }
    }, 15_000);
    try {
      const [code, signal] = await once(launch.child, 'close') as [number | null, string | null];
      // Retain only a numeric version, never arbitrary output from configuration/extension loaders.
      const version = stdout.trim().match(/^(?:codex-cli\s+|v)?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/)?.[1] ?? null;
      return { ...result, viable: code === 0 && version !== null, version, exitCode: code, signal, failureCode, timedOut };
    } finally { clearTimeout(timer); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
