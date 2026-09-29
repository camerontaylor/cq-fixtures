import { mkdtemp, chmod, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeFinalProfileAdmission, verifyConsumedAdmissionRecord, type FrozenFinalProfileApproval } from '../runner/campaign/final-profile-admission.ts';

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

describe('private ledger ownership and safe readback', () => {
  const request = { stage: 'final-profile-G1' as const, boundaryIdentity: 'a'.repeat(64), invocationIdentity: 'b'.repeat(64) };
  it('requires a private self-owned final ledger directory', async () => {
    const directory = await root(); await chmod(directory, 0o750);
    await expect(freezeFinalProfileAdmission(directory, approval())).rejects.toThrow('private self-owned final directory');
    const base = await root(); const linked = await root();
    const alias = join(base, 'alias'); await symlink(linked, alias);
    await expect(freezeFinalProfileAdmission(alias, approval())).rejects.toThrow();
  });
  it('rejects consumption after the frozen approval file changed on disk', async () => {
    const directory = await root(); const frozen = approval();
    const admit = await freezeFinalProfileAdmission(directory, frozen);
    await writeFile(join(directory, `approval-${frozen.receipt.admissionId}.json`), '{"altered":true}\n', { mode: 0o600 });
    await expect(admit(request)).rejects.toThrow('parent approval changed after freeze');
  });
  it('rejects consumption when the frozen approval file lost its private mode', async () => {
    const directory = await root(); const frozen = approval();
    const admit = await freezeFinalProfileAdmission(directory, frozen);
    await chmod(join(directory, `approval-${frozen.receipt.admissionId}.json`), 0o644);
    await expect(admit(request)).rejects.toThrow('parent approval changed after freeze');
  });
  it('rejects consumption after the approval expired following freeze', async () => {
    const directory = await root(); const frozen = approval();
    frozen.receipt.expiresAt = Date.now() + 40;
    const admit = await freezeFinalProfileAdmission(directory, frozen);
    await sleep(60);
    await expect(admit(request)).rejects.toThrow('distinct final-profile parent admission required');
  });
});

describe('single-use exhaustion across adapters and provision failures', () => {
  it('denies a concurrent second adapter on the same invocation while one succeeds', async () => {
    const directory = await root();
    const first = approval('parent-final-profile-race-a');
    const second = approval('parent-final-profile-race-b');
    second.receipt.boundaryIdentity = first.receipt.boundaryIdentity;
    second.receipt.invocationIdentity = first.receipt.invocationIdentity;
    const [a, b] = await Promise.all([freezeFinalProfileAdmission(directory, first), freezeFinalProfileAdmission(directory, second)]);
    const request = { stage: 'final-profile-G1' as const, boundaryIdentity: first.receipt.boundaryIdentity, invocationIdentity: first.receipt.invocationIdentity };
    const results = await Promise.allSettled([a(request), b(request)]);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status === 'rejected' && rejected[0].reason).toMatchObject({ code: 'EEXIST' });
  });
  it('keeps a spent invocation consumed after a failed provision attempt', async () => {
    const directory = await root();
    const first = approval('parent-final-profile-spent-a');
    const second = approval('parent-final-profile-spent-b');
    second.receipt.boundaryIdentity = first.receipt.boundaryIdentity;
    second.receipt.invocationIdentity = first.receipt.invocationIdentity;
    const request = { stage: 'final-profile-G1' as const, boundaryIdentity: first.receipt.boundaryIdentity, invocationIdentity: first.receipt.invocationIdentity };
    await (await freezeFinalProfileAdmission(directory, first))(request);
    // The provision that consumed the admission then fails; the invocation stays spent.
    await expect((await freezeFinalProfileAdmission(directory, second))(request)).rejects.toMatchObject({ code: 'EEXIST' });
    const record = JSON.parse(await readFile(join(directory, `invocation-${request.invocationIdentity}.json`), 'utf8'));
    expect(record).toMatchObject({ state: 'spent-before-provisioning' });
  });
});

describe('authoritative consumed-admission ledger verifier', () => {
  async function ledger(id = 'parent-g2-consumed-join') {
    const directory = await root();
    const frozen = approval(id);
    frozen.receipt.stage = 'actual-route-G2';
    const joins = { stage: 'actual-route-G2' as const, boundaryIdentity: frozen.receipt.boundaryIdentity, invocationIdentity: frozen.receipt.invocationIdentity };
    const admit = await freezeFinalProfileAdmission(directory, frozen);
    const expected = { admissionId: frozen.receipt.admissionId, ...joins, sourcePin: frozen.sourcePin, assignmentId: frozen.assignmentId, attemptId: frozen.attemptId };
    return { directory, frozen, admit, joins, expected };
  }
  it('verifies the exact join after a real spend and refuses an unconsumed approval', async () => {
    const { directory, admit, expected } = await ledger();
    expect(await verifyConsumedAdmissionRecord(directory, expected)).toBe(false);
    await admit({ stage: 'actual-route-G2', boundaryIdentity: expected.boundaryIdentity, invocationIdentity: expected.invocationIdentity });
    expect(await verifyConsumedAdmissionRecord(directory, expected)).toBe(true);
  });
  it('refuses wrong admission/source/assignment/attempt/invocation/boundary joins', async () => {
    const { directory, admit, joins, expected } = await ledger();
    await admit(joins);
    for (const change of [
      { admissionId: 'parent-g2-other-join' },
      { sourcePin: 'd'.repeat(64) },
      { assignmentId: 'assignment-other' },
      { attemptId: 'attempt-other' },
      { invocationIdentity: 'd'.repeat(64) },
      { boundaryIdentity: 'd'.repeat(64) },
      { stage: 'final-profile-G1' as const },
    ]) {
      expect(await verifyConsumedAdmissionRecord(directory, { ...expected, ...change }), JSON.stringify(change)).toBe(false);
    }
    expect(await verifyConsumedAdmissionRecord(directory, { ...expected, sourcePin: 'short' })).toBe(false);
  });
  it('refuses fabricated consumed bytes, altered approvals and unsafe readbacks', async () => {
    const { directory, frozen, admit, joins, expected } = await ledger();
    await admit(joins);
    const consumedPath = join(directory, `consumed-${frozen.receipt.admissionId}.json`);
    const record = JSON.parse(await readFile(`${consumedPath}`, 'utf8'));
    await writeFile(consumedPath, `${JSON.stringify({ ...record, attemptId: 'attempt-forged' })}\n`, { mode: 0o600 });
    expect(await verifyConsumedAdmissionRecord(directory, expected)).toBe(false);
    const second = await ledger('parent-g2-consumed-join-2');
    await second.admit(second.joins);
    const secondPath = join(second.directory, `approval-${second.frozen.receipt.admissionId}.json`);
    const original = await readFile(`${secondPath}`, 'utf8');
    await writeFile(secondPath, original.replace('"assignment-1"', '"assignment-forged"'), { mode: 0o600 });
    expect(await verifyConsumedAdmissionRecord(second.directory, second.expected)).toBe(false);
    const third = await ledger('parent-g2-consumed-join-3');
    await third.admit(third.joins);
    await chmod(join(third.directory, `consumed-${third.frozen.receipt.admissionId}.json`), 0o644);
    expect(await verifyConsumedAdmissionRecord(third.directory, third.expected)).toBe(false);
  });
});
