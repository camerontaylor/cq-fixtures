import { SessionStore, type OpInvocation } from '@camerontaylor/cq-toolkit';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Must match the runner and ACP driver's default session store. */
export const RUNNER_SESSION_DIRECTORY = join(tmpdir(), 'cq-harness', 'sessions');

export interface ResolvedNativeSession {
  cwd: string;
  sessionRef: string | undefined;
  status: 'runner-workspace-resolved' | 'fresh-ephemeral';
}

/** Resolve the runner's sessionRef as a workspace binding, never as a CLI resume token. */
export async function resolveNativeSession(
  invocation: OpInvocation,
  workspaceForInvocation: ((invocation: OpInvocation) => string) | undefined,
  store = new SessionStore(RUNNER_SESSION_DIRECTORY),
): Promise<ResolvedNativeSession> {
  if (invocation.sessionRef) {
    const record = await store.load(invocation.sessionRef);
    if (!record) throw new Error(`native bridge: unknown runner sessionRef '${invocation.sessionRef}'`);
    const cwd = resolve(record.workspace);
    const requestedCwd = workspaceForInvocation ? resolve(workspaceForInvocation(invocation)) : cwd;
    if (requestedCwd !== cwd) {
      throw new Error('native bridge workspace resolver disagrees with the runner session workspace');
    }
    return { cwd, sessionRef: invocation.sessionRef, status: 'runner-workspace-resolved' };
  }
  return { cwd: resolve(workspaceForInvocation?.(invocation) ?? process.cwd()), sessionRef: undefined, status: 'fresh-ephemeral' };
}
