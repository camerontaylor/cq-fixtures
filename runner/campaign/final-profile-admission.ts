import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, parse, resolve, join } from 'node:path';
import { validateFinalAdmission, type FinalProfileAdmission } from '../boundary/codex-final-profile.ts';

export interface FrozenFinalProfileApproval {
  receipt: FinalProfileAdmission;
  assignmentId: string;
  attemptId: string;
  sourcePin: string;
}

type Request = Pick<FinalProfileAdmission, 'stage' | 'boundaryIdentity' | 'invocationIdentity'>;
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

async function privateDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory);
  const parents: string[] = [];
  for (let cursor = absolute; cursor !== parse(cursor).root; cursor = dirname(cursor)) parents.unshift(cursor);
  for (const parent of parents) {
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('admission ledger requires ordinary parent directories');
  }
}

async function exclusive(directory: string, name: string, bytes: string): Promise<void> {
  const handle = await open(join(directory, name), 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

/** Parent freezes independently derived identities BEFORE constructing the spawn
 * callback. Never register an approval from the callback's incoming request.
 * A partial/crashed consume stays spent and needs a new attempt/admission.
 */
export async function freezeFinalProfileAdmission(
  root: string, approval: FrozenFinalProfileApproval, now = Date.now(),
): Promise<(request: Request) => Promise<FinalProfileAdmission>> {
  const frozen = structuredClone(approval);
  if (!/^[a-f0-9]{64}$/u.test(frozen.sourcePin) ||
      !/^[a-f0-9]{64}$/u.test(frozen.receipt.boundaryIdentity) ||
      !/^[a-f0-9]{64}$/u.test(frozen.receipt.invocationIdentity) ||
      !frozen.assignmentId.trim() || !frozen.attemptId.trim()) throw new Error('frozen source, boundary, invocation and attempt pins required');
  validateFinalAdmission(frozen.receipt, frozen.receipt, now);
  const directory = resolve(root);
  await privateDirectory(directory);
  const approvalBytes = `${JSON.stringify(frozen)}\n`;
  const approvalHash = digest(approvalBytes);
  const planName = `approval-${frozen.receipt.admissionId}.json`;
  await exclusive(directory, planName, approvalBytes);
  return async (request) => {
    if (request.stage !== frozen.receipt.stage || request.boundaryIdentity !== frozen.receipt.boundaryIdentity ||
        request.invocationIdentity !== frozen.receipt.invocationIdentity) throw new Error('request differs from independently frozen parent approval');
    const stat = await lstat(join(directory, planName));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || digest(await readFile(join(directory, planName), 'utf8')) !== approvalHash) {
      throw new Error('parent approval changed after freeze');
    }
    validateFinalAdmission(frozen.receipt, request);
    const record = `${JSON.stringify({ ...frozen, approvalHash, consumedAt: new Date().toISOString(), state: 'spent-before-provisioning' })}\n`;
    // Global invocation identity prevents replay through another adapter or a
    // second admission ID. ID index prevents the same receipt being re-used.
    await exclusive(directory, `invocation-${request.invocationIdentity}.json`, record);
    await exclusive(directory, `consumed-${frozen.receipt.admissionId}.json`, record);
    return structuredClone(frozen.receipt);
  };
}
