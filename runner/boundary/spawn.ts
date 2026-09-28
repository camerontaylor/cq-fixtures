import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { compileBoundary } from './policy.ts';
import type { BoundaryPolicy } from './policy.ts';

export interface BoundaryLaunch {
  policy: BoundaryPolicy;
  executable: string;
  args: string[];
  /** Named bindings only; never inherit process.env. Values are not persisted here. */
  bindings?: Record<string, string>;
  bindingNames?: string[];
  purpose: 'no-model-probe' | 'actual-route';
  /** Host policy is ineligible; fail closed instead of relabelling calibration. */
  heldOut?: boolean;
  /** Orchestrator must check fresh quota/blackout/budget before returning a receipt. */
  admit?: (identity: string) => Promise<{ admissionId: string }>;
}
const RESERVED = /^(HOME|TMPDIR|PATH|XDG_.*|NODE_.*|DYLD_.*|LD_.*|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|CDPATH)$/;

/** Native transports own stdin/events, timeouts/process-tree cleanup and patch capture.
 * There is deliberately no unsandboxed fallback and no shell command interpolation.
 */
export async function spawnBoundary(request: BoundaryLaunch): Promise<{
  child: ChildProcessWithoutNullStreams;
  boundaryIdentity: string;
  launchIdentity: string;
  admissionId: string | null;
  environmentNames: string[];
}> {
  if (process.platform !== 'darwin') throw new Error('host sandbox unavailable; validated container/VM required');
  // Re-resolve roots before each launch; reject symlink replacement or policy mutation.
  const policy = compileBoundary(request.policy.resolved);
  if (policy.identity !== request.policy.identity || policy.profile !== request.policy.profile) {
    throw new Error('boundary identity changed before launch');
  }
  if (request.heldOut) throw new Error('host process-argument isolation unavailable; held-out requires validated process isolation');
  const executable = realpathSync(request.executable);
  if (!policy.resolved.executables.includes(executable)) throw new Error('undeclared executable');
  const bindings = { ...request.bindings };
  const names = [...(request.bindingNames ?? [])];
  const args = [...request.args];
  if (!['actual-route', 'no-model-probe'].includes(request.purpose)) throw new Error('undeclared launch purpose');
  if (new Set(names).size !== names.length || names.length !== Object.keys(bindings).length ||
      names.some((name) => !Object.hasOwn(bindings, name) || !/^[A-Z][A-Z0-9_]*$/.test(name) || RESERVED.test(name))) {
    throw new Error('bindings require an exact safe name allowlist');
  }
  let admissionId: string | null = null;
  if (request.purpose === 'actual-route') {
    if (!policy.nativeControlsAttested) throw new Error('native extension/config controls unverified');
    if (policy.resolved.endpoints.length > 0 && !policy.resolved.networkEvidence?.trim()) throw new Error('route broker/service network controls unverified');
    if (!request.admit) throw new Error('actual-route launch requires orchestrator admission');
    if (request.heldOut !== false) throw new Error('actual-route launch requires explicit visible/probe evaluation scope');
    const receipt = await request.admit(policy.identity);
    if (!receipt.admissionId.trim()) throw new Error('missing admission receipt');
    admissionId = receipt.admissionId;
  } else if (policy.resolved.endpoints.length !== 0 || policy.resolved.authentication.length !== 0 || names.length !== 0) {
    throw new Error('no-model probes cannot receive route network/authentication/bindings');
  }
  if (compileBoundary(policy.resolved).identity !== policy.identity) throw new Error('boundary changed during admission');
  const launchIdentity = createHash('sha256').update(JSON.stringify({ boundary: policy.identity, executable, args, bindingNames: [...names].sort() })).digest('hex');
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy.profile, executable, ...args], {
    cwd: policy.resolved.task, env: { ...policy.environment, ...bindings },
    stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  return { child, boundaryIdentity: policy.identity, launchIdentity, admissionId,
    environmentNames: Object.keys({ ...policy.environment, ...bindings }).sort() };
}
