import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
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
  const finalStat = await lstat(absolute);
  if (!finalStat.isDirectory() || finalStat.isSymbolicLink() || finalStat.uid !== process.getuid?.() || (finalStat.mode & 0o077)) {
    throw new Error('admission ledger requires a private self-owned final directory');
  }
}

async function exclusive(directory: string, name: string, bytes: string): Promise<void> {
  const handle = await open(join(directory, name), 'wx', 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync();
    const written = await handle.stat();
    if (written.uid !== process.getuid?.() || (written.mode & 0o077)) throw new Error('admission ledger record ownership unavailable');
  } finally { await handle.close(); }
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
        digest(await readFile(join(directory, planName), 'utf8')) !== approvalHash) {
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

export interface ConsumedAdmissionJoin {
  admissionId: string;
  stage: FinalProfileAdmission['stage'];
  boundaryIdentity: string;
  invocationIdentity: string;
  sourcePin: string;
  assignmentId: string;
  attemptId: string;
}

async function privateLedgerBytes(path: string, maxBytes = 1024 * 1024): Promise<string | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) return null;
    return await handle.readFile('utf8');
  } catch { return null; } finally { await handle.close().catch(() => { /* unreadable record stays unverified */ }); }
}

/** Authoritative consumed-ledger lookup with exact source/assignment/stage/attempt/
 * invocation/boundary/admission joins, safe private readback of both the consumed
 * record and the frozen approval bytes it hashes. Missing, fabricated, replayed,
 * altered or unconsumed evidence returns false; it never throws and never echoes.
 */
export async function verifyConsumedAdmissionRecord(root: string, expected: ConsumedAdmissionJoin): Promise<boolean> {
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(expected.admissionId) ||
        !/^[a-f0-9]{64}$/u.test(expected.sourcePin) || !/^[a-f0-9]{64}$/u.test(expected.boundaryIdentity) ||
        !/^[a-f0-9]{64}$/u.test(expected.invocationIdentity) || !expected.assignmentId.trim() || !expected.attemptId.trim()) return false;
    const directory = resolve(root);
    const consumedBytes = await privateLedgerBytes(join(directory, `consumed-${expected.admissionId}.json`));
    if (consumedBytes === null) return false;
    let record: FrozenFinalProfileApproval & { approvalHash: string; consumedAt: string; state: string };
    try { record = JSON.parse(consumedBytes); } catch { return false; }
    if (record.state !== 'spent-before-provisioning' || typeof record.approvalHash !== 'string' || !/^[a-f0-9]{64}$/u.test(record.approvalHash) ||
        typeof record.consumedAt !== 'string' || !Number.isFinite(Date.parse(record.consumedAt))) return false;
    if (record.assignmentId !== expected.assignmentId || record.attemptId !== expected.attemptId || record.sourcePin !== expected.sourcePin) return false;
    const receipt = record.receipt;
    if (!receipt || receipt.admissionId !== expected.admissionId || receipt.stage !== expected.stage ||
        receipt.profile !== 'cq-subscription-http' || receipt.heldOut !== false ||
        receipt.boundaryIdentity !== expected.boundaryIdentity || receipt.invocationIdentity !== expected.invocationIdentity ||
        !Number.isFinite(receipt.expiresAt)) return false;
    const approvalBytes = await privateLedgerBytes(join(directory, `approval-${expected.admissionId}.json`));
    if (approvalBytes === null || digest(approvalBytes) !== record.approvalHash) return false;
    return true;
  } catch { return false; }
}
