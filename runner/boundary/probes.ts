import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { compileBoundary } from './policy.ts';
import type { BoundaryPolicy } from './policy.ts';
import { spawnBoundary } from './spawn.ts';

export interface ProbeEvidence {
  kind: 'no-model-executable-probes';
  observedAt: string;
  available: boolean;
  viable: boolean;
  boundaryIdentity: string | null;
  profile: string | null;
  resolved: BoundaryPolicy['resolved'] | null;
  checks: Record<string, boolean>;
  exitCode: number | null;
  signal: string | null;
  blocker: string | null;
  g2: 'not-established';
}

/** Synthetic sentinels only; output contains booleans, never file contents/env values. */
export async function probeHostBoundary(): Promise<ProbeEvidence> {
  const base: ProbeEvidence = { kind: 'no-model-executable-probes', observedAt: new Date().toISOString(),
    available: process.platform === 'darwin', viable: false, boundaryIdentity: null, profile: null,
    resolved: null, checks: {}, exitCode: null, signal: null, blocker: null, g2: 'not-established' };
  if (!base.available) return { ...base, blocker: 'macOS sandbox-exec unavailable' };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cq-boundary-probe-')));
  try {
    const bundle = join(root, 'bundle');
    const hidden = join(root, 'hidden');
    mkdirSync(bundle); mkdirSync(hidden);
    const [task, context, home, temporary] = ['task', 'context', 'home', 'tmp'].map((name) => {
      const path = join(bundle, name); mkdirSync(path); return path;
    });
    for (const name of ['judge', 'solution', 'sibling', 'ambient-config']) writeFileSync(join(hidden, name), 'synthetic-hidden-material');
    writeFileSync(join(context, 'task-context'), 'declared-context');
    writeFileSync(join(context, 'synthetic-auth'), 'synthetic-auth-only');
    writeFileSync(join(task, 'input'), 'assigned-task');
    symlinkSync(join(hidden, 'solution'), join(task, 'escape'));
    symlinkSync(join(hidden, 'ambient-config'), join(home, 'settings.json'));
    const executable = realpathSync(process.execPath);
    const policy = compileBoundary({ bundle, task, context, home, temporary, toolchain: [], authentication: [],
      executables: [executable, '/bin/sh', '/bin/bash', '/bin/cat'], forbidden: [hidden], endpoints: [],
      extensions: { mode: 'disabled', launchEvidence: null } });
    const script = join(context, 'probe.cjs');
    writeFileSync(script, `
const fs = require('node:fs');
const cp = require('node:child_process');
const net = require('node:net');
const task = ${JSON.stringify(task)}, context = ${JSON.stringify(context)}, hidden = ${JSON.stringify(hidden)};
const checks = {};
function denied(path) { try { fs.readFileSync(path); return false; } catch (e) { return e.code === 'EPERM' || e.code === 'EACCES'; } }
checks.taskRead = fs.readFileSync(task + '/input', 'utf8') === 'assigned-task';
checks.contextRead = fs.readFileSync(context + '/task-context', 'utf8') === 'declared-context';
checks.syntheticAuthRead = fs.readFileSync(context + '/synthetic-auth', 'utf8') === 'synthetic-auth-only';
fs.writeFileSync(task + '/output', 'edited'); checks.taskWrite = fs.existsSync(task + '/output');
try { fs.writeFileSync(context + '/tamper', 'bad'); checks.contextReadOnly = false; } catch(e) { checks.contextReadOnly = e.code === 'EPERM' || e.code === 'EACCES'; }
for (const name of ['judge','solution','sibling','ambient-config']) checks[name + 'Denied'] = denied(hidden + '/' + name);
checks.symlinkDenied = denied(task + '/escape');
checks.ambientConfigDenied = denied(process.env.HOME + '/settings.json');
checks.cleanEnvironment = !process.env.NODE_OPTIONS && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY;
const shellResult = cp.spawnSync('/bin/sh', ['-c', 'cat "$1" >/dev/null', 'probe', task + '/input']); checks.shellAllowed = shellResult.status === 0;
checks.shellDenied = cp.spawnSync('/bin/sh', ['-c', 'cat "$1" >/dev/null', 'probe', hidden + '/judge']).status !== 0;
checks.shellSymlinkDenied = cp.spawnSync('/bin/sh', ['-c', 'cat "$1" >/dev/null', 'probe', task + '/escape']).status !== 0;
const nativeTool = cp.spawnSync(${JSON.stringify(executable)}, ['-e', 'try { require("node:fs").readFileSync(process.argv[1]); process.exit(1); } catch(e) { process.exit(e.code === "EPERM" || e.code === "EACCES" ? 0 : 2); }', hidden + '/sibling']);
checks.nodeToolDenied = nativeTool.status === 0;
try { require(hidden + '/ambient-config'); checks.extensionLoadDenied = false; } catch(e) { checks.extensionLoadDenied = ['EPERM','EACCES','MODULE_NOT_FOUND'].includes(e.code); }
const socket = net.connect({host:'127.0.0.1',port:9});
socket.on('error', e => { checks.networkDenied = e.code === 'EPERM' || e.code === 'EACCES'; console.log(JSON.stringify(checks)); });
socket.setTimeout(1000, () => { checks.networkDenied = false; socket.destroy(); console.log(JSON.stringify(checks)); });
`);
    const launch = await spawnBoundary({ policy, executable, args: [script], purpose: 'no-model-probe' });
    let output = '';
    launch.child.stdout.on('data', (chunk: Buffer) => { if (output.length < 8192) output += chunk.toString(); });
    // No stderr publication: loader/config errors can contain sensitive locations/content.
    launch.child.stderr.resume();
    const timer = setTimeout(() => {
      try { if (launch.child.pid) process.kill(-launch.child.pid, 'SIGKILL'); } catch { /* exited */ }
    }, 30_000);
    try {
      const [code, signal] = await once(launch.child, 'close') as [number | null, string | null];
      let checks: Record<string, boolean> = {};
      try { checks = JSON.parse(output.trim()) as Record<string, boolean>; } catch { /* unavailable runtime */ }
      const viable = code === 0 && Object.keys(checks).length === 18 && Object.values(checks).every((value) => value === true);
      return { ...base, viable, boundaryIdentity: policy.identity, profile: policy.profile, resolved: policy.resolved,
        checks, exitCode: code, signal, blocker: viable ? null : 'sandbox executable/probe failed; inspect private diagnostic locally' };
    } finally { clearTimeout(timer); }
  } catch (error) {
    return { ...base, blocker: error instanceof Error ? error.message : 'host probe failed' };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Read-only runtime discovery. Executable presence is not runtime or confinement proof. */
export function discoverFallbacks(): Array<{ backend: string; state: 'available-unverified' | 'unavailable'; exitCode: number | null }> {
  return [
    { backend: 'docker', executable: 'docker', args: ['info', '--format', '{{.ServerVersion}}'] },
    { backend: 'colima', executable: 'colima', args: ['status'] },
    { backend: 'lima', executable: 'limactl', args: ['list', '--json'] },
  ].map(({ backend, executable, args }) => {
    const result = spawnSync(executable, args, { timeout: 5000, encoding: 'utf8', maxBuffer: 65536 });
    const ready = result.status === 0 && (backend !== 'lima' || /"status"\s*:\s*"Running"/i.test(result.stdout));
    return { backend, state: ready ? 'available-unverified' : 'unavailable', exitCode: result.status };
  });
}
