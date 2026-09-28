import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { freezeFinalProfileAdmission, type FrozenFinalProfileApproval } from '../runner/campaign/final-profile-admission.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'cq-admission-test-')); roots.push(value); return value; }
function approval(id = 'parent-final-profile-test'): FrozenFinalProfileApproval {
  return {
    receipt: { admissionId: id, stage: 'final-profile-G1', profile: 'cq-subscription-http',
      boundaryIdentity: 'a'.repeat(64), invocationIdentity: 'b'.repeat(64), expiresAt: Date.now() + 60_000, heldOut: false },
    assignmentId: 'assignment-1', attemptId: 'attempt-1', sourcePin: 'c'.repeat(64),
  };
}
it('rejects mismatched launch before spending, then persists exact single-use admission', async () => {
  const directory = await root(); const frozen = approval(); const admit = await freezeFinalProfileAdmission(directory, frozen);
  frozen.receipt.boundaryIdentity = 'd'.repeat(64);
  await expect(admit(frozen.receipt)).rejects.toThrow('independently frozen');
  const request = { stage: 'final-profile-G1' as const, boundaryIdentity: 'a'.repeat(64), invocationIdentity: 'b'.repeat(64) };
  expect(await admit(request)).toMatchObject(request);
  await expect(admit(request)).rejects.toMatchObject({ code: 'EEXIST' });
  const record = JSON.parse(await readFile(join(directory, `invocation-${request.invocationIdentity}.json`), 'utf8'));
  expect(record).toMatchObject({ state: 'spent-before-provisioning', assignmentId: 'assignment-1', attemptId: 'attempt-1', sourcePin: 'c'.repeat(64) });
});
it('rejects replay of an invocation through a separately frozen admission ID', async () => {
  const directory = await root(); const first = approval(); const second = approval('parent-final-profile-replay');
  await (await freezeFinalProfileAdmission(directory, first))(first.receipt);
  await expect((await freezeFinalProfileAdmission(directory, second))(second.receipt)).rejects.toMatchObject({ code: 'EEXIST' });
});
it('rejects an expired approval before creating a launch callback', async () => {
  const frozen = approval(); frozen.receipt.expiresAt = Date.now() - 1;
  await expect(freezeFinalProfileAdmission(await root(), frozen)).rejects.toThrow('parent admission');
});
