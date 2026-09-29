import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createG2Fixture, disposeG2Fixture, evaluateG2, normalizeG2NativeReceipt, provisionG2Guardian, runG2Harness } from '../runner/boundary/g2-harness.ts';
import type { G2CanonicalNativeReceipt, G2NativeResult, G2VerifiedExport } from '../runner/boundary/g2-harness.ts';
import { freezeFinalProfileAdmission, type FrozenFinalProfileApproval } from '../runner/campaign/final-profile-admission.ts';
import { FINAL_BROKER_IMAGE, FINAL_BROKER_IDENTITY, FINAL_CODEX_CONFIG_HASH, FINAL_NATIVE_IMAGE } from '../runner/boundary/codex-final-profile.ts';
import { FINAL_BROKER_RUNTIME_IDENTITY } from '../runner/boundary/broker-toolchain.ts';
import { G2_EXPECTED_DAEMON_ID } from '../runner/boundary/g2-daemon-contract.ts';
import { snapshotTask } from '../runner/boundary/task-tree.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const boundary = 'b'.repeat(64), invocation = 'c'.repeat(64), sourcePin = 'a'.repeat(64);
const ADMISSION = 'parent-g2-qualification-1';

function approval(): FrozenFinalProfileApproval {
  return { receipt: { admissionId: ADMISSION, stage: 'actual-route-G2', profile: 'cq-subscription-http',
    boundaryIdentity: boundary, invocationIdentity: invocation, expiresAt: Date.now() + 600_000, heldOut: false },
    assignmentId: 'assignment-g2', attemptId: 'attempt-g2', sourcePin };
}

function git(root: string, args: string[]): string {
  const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 15000 });
  if (result.status !== 0) throw new Error('synthetic Git fixture failed');
  return result.stdout.trim();
}

/** Host-only synthetic qualification sample: private fixture, consumed single-use
 * ledger admission and an exactly audited stopped export. No daemon/model contact. */
async function qualifiedSample() {
  const fixture = createG2Fixture(); roots.push(fixture.privateRoot);
  const exportRoot = mkdtempSync(join(tmpdir(), 'cq-g2-export-')); roots.push(exportRoot);
  writeFileSync(join(exportRoot, '.g2-partial'), 'CQ_G2_PUBLIC_TASK_CONTROL', { mode: 0o700 });
  git(exportRoot, ['init', '-q']);
  git(exportRoot, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'add', '.']);
  git(exportRoot, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'baseline']);
  const baselineCommit = git(exportRoot, ['rev-parse', 'HEAD']);
  const normalized = snapshotTask(exportRoot, true);
  writeFileSync(join(exportRoot, '.git/config'), Buffer.from(normalized.entries.find(e => e.path === '.git/config')!.data!, 'base64'));
  const trusted = { inventoryHash: snapshotTask(exportRoot, false).inventoryHash, head: baselineCommit, baselineCommit };
  const traces = fixture.probes.map(probe => ({ invocationId: 'synthetic-invocation', probeId: probe.id, channel: probe.channel,
    target: probe.target, requestedCommand: probe.command, attempted: true,
    disposition: probe.expected === 'deny' ? 'denied' as const : 'success' as const,
    denialKind: (probe.channel === 'native-config' ? 'config-inventory-verified' : ['process-argv', 'process-env'].includes(probe.channel) ? 'guardian-not-visible' : ['shell-network', 'native-network'].includes(probe.channel) ? 'broker-403' : 'not-found') as G2NativeTraceDenial,
    exitCode: 0, httpStatus: 403, toolErrorCode: 'ENOENT' as const,
    controlProof: { kind: (probe.channel === 'native-config' ? 'native-inventory-verified' : 'guardian-namespace-absent') as 'native-inventory-verified' | 'guardian-namespace-absent', verified: true as const },
    output: Buffer.from(probe.expected === 'deny' ? 'synthetic denial' : 'CQ_G2_PUBLIC_TASK_CONTROL'), complete: true }));
  const result: G2NativeResult = { invocationId: 'synthetic-invocation', boundaryIdentity: boundary, launchIdentity: 'synthetic-launch',
    provenance: 'actual-native', admissionId: ADMISSION, stage: 'actual-route-G2', profile: 'cq-subscription-http',
    workerImage: FINAL_NATIVE_IMAGE, brokerImage: FINAL_BROKER_IMAGE, brokerIdentity: FINAL_BROKER_IDENTITY, configHash: FINAL_CODEX_CONFIG_HASH,
    effectiveBrokerIdentity: FINAL_BROKER_RUNTIME_IDENTITY, traces, rawOutputs: [], workerAbsentVerified: true, teardownAwaited: true,
    baselineVerified: true, exportRoot, timedOutOrCancelled: true, childTreeStopped: true, actualResponsesStreamObserved: true,
    nativeInventoryComplete: true, postExportCandidateExecutionProtected: true, oracleCallerAdapted: true,
    receiptExport: { inventoryHash: trusted.inventoryHash, head: trusted.head } };
  fixture.guardian = { containerId: 'f'.repeat(64), volume: 'cq-s5-g2-' + fixture.nonce, daemonId: G2_EXPECTED_DAEMON_ID, image: FINAL_NATIVE_IMAGE };
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'cq-g2-ledger-')); roots.push(ledgerRoot);
  const frozen = approval();
  const admit = await freezeFinalProfileAdmission(ledgerRoot, frozen);
  await admit({ stage: 'actual-route-G2', boundaryIdentity: boundary, invocationIdentity: invocation });
  const expectedAdmission = { ledgerRoot, sourcePin, assignmentId: 'assignment-g2', attemptId: 'attempt-g2', boundaryIdentity: boundary, invocationIdentity: invocation };
  const strictTrusted: G2VerifiedExport = { ...trusted, invocationId: 'synthetic-invocation', stopReceiptVerified: true, cleanupVerified: true, protectedJudgeReceiptVerified: true };
  const input = { finalG1EvidenceAccepted: true, admissionId: ADMISSION, timeoutMs: 10000, execute: async () => result, stop: async () => {},
    verifyConsumedAdmission: async () => true, verifyStoppedExport: async () => strictTrusted, expectedAdmission };
  return { fixture, result, input, trusted, strictTrusted };
}
type G2NativeTraceDenial = G2NativeResult['traces'][number]['denialKind'];

describe('consumed single-use admission joins G2 qualification', () => {
  it('qualifies only through the independently consumed ledger with exact joins', async () => {
    const { fixture, input } = await qualifiedSample();
    const report = await runG2Harness(fixture, input);
    expect(report.admissionVerified).toBe(true);
    expect(report.exportIdentityVerified).toBe(true);
    expect(report.teardownExportVerified).toBe(true);
    expect(report.qualified).toBe(true);
  }, 30000);
  it('never qualifies when the admission was frozen but never consumed', async () => {
    const { fixture, input } = await qualifiedSample();
    const unconsumed = mkdtempSync(join(tmpdir(), 'cq-g2-ledger-')); roots.push(unconsumed);
    await freezeFinalProfileAdmission(unconsumed, approval());
    await expect(runG2Harness(fixture, { ...input, expectedAdmission: { ...input.expectedAdmission!, ledgerRoot: unconsumed } })).rejects.toThrow(/unavailable/);
  }, 30000);
  it('refuses an echoing verifier without the authoritative ledger record', async () => {
    const { fixture, result, input } = await qualifiedSample();
    const replayId = 'parent-g2-replay-1';
    await expect(runG2Harness(fixture, { ...input, admissionId: replayId, execute: async () => ({ ...result, admissionId: replayId }) })).rejects.toThrow(/unavailable/);
  }, 30000);
  it('rejects wrong source/assignment/attempt/invocation/boundary ledger joins', async () => {
    const { fixture, input } = await qualifiedSample();
    for (const change of [{ sourcePin: 'd'.repeat(64) }, { assignmentId: 'assignment-other' }, { attemptId: 'attempt-other' },
      { invocationIdentity: 'd'.repeat(64) }, { boundaryIdentity: 'd'.repeat(64) }]) {
      await expect(runG2Harness(fixture, { ...input, expectedAdmission: { ...input.expectedAdmission!, ...change } }), JSON.stringify(change)).rejects.toThrow(/unavailable/);
    }
  }, 30000);
  it('binds the receipt launch boundary to the frozen admission identity', async () => {
    const { fixture, result, input } = await qualifiedSample();
    const altered = { ...result, boundaryIdentity: 'd'.repeat(64) };
    await expect(runG2Harness(fixture, { ...input, execute: async () => altered })).rejects.toThrow(/unavailable/);
  }, 30000);
  it('refuses malformed expected-admission pins before any dispatch', async () => {
    const { fixture, input } = await qualifiedSample();
    await expect(runG2Harness(fixture, { ...input, expectedAdmission: { ...input.expectedAdmission!, sourcePin: 'short' } })).rejects.toThrow(/final G1/);
    await expect(runG2Harness(fixture, { ...input, expectedAdmission: { ...input.expectedAdmission!, ledgerRoot: 'relative/ledger' } })).rejects.toThrow(/final G1/);
  });
  it('keeps offline diagnostic evaluation forced-unqualified', async () => {
    const { fixture, result } = await qualifiedSample();
    const report = evaluateG2(fixture, result);
    expect(report.qualified).toBe(false);
    expect(report.workerQualified).toBe(false);
    expect(report.admissionVerified).toBe(false);
  }, 30000);
});

describe('invocation-specific stop/export/cleanup/protected-judge joins', () => {
  it('strict production path requires every independently verified receipt', async () => {
    const { fixture, input, strictTrusted } = await qualifiedSample();
    for (const change of [
      { invocationId: 'other-invocation' }, { invocationId: undefined },
      { stopReceiptVerified: false }, { cleanupVerified: false }, { protectedJudgeReceiptVerified: false },
    ]) {
      const report = await runG2Harness(fixture, { ...input, verifyStoppedExport: async () => ({ ...strictTrusted, ...change } as G2VerifiedExport) });
      expect(report.qualified, JSON.stringify(change)).toBe(false);
    }
  }, 60000);
  it('wrong or malformed export identity never verifies against the audited snapshot', async () => {
    const { fixture, result, input, strictTrusted } = await qualifiedSample();
    result.receiptExport = { inventoryHash: '0'.repeat(64), head: strictTrusted.head };
    expect((await runG2Harness(fixture, input)).exportIdentityVerified).toBe(false);
    result.receiptExport = { inventoryHash: strictTrusted.inventoryHash, head: strictTrusted.head };
    const malformed = await runG2Harness(fixture, { ...input, verifyStoppedExport: async () => ({ ...strictTrusted, head: 'not-a-commit' }) });
    expect(malformed.exportIdentityVerified).toBe(false);
    const wrongBaseline = await runG2Harness(fixture, { ...input, verifyStoppedExport: async () => ({ ...strictTrusted, baselineCommit: '0'.repeat(40) }) });
    expect(wrongBaseline.qualified).toBe(false);
  }, 60000);
  it('keeps the audited development path for legacy callers without expectedAdmission', async () => {
    const { fixture, input, trusted } = await qualifiedSample();
    const legacy = { finalG1EvidenceAccepted: input.finalG1EvidenceAccepted, admissionId: input.admissionId, timeoutMs: input.timeoutMs,
      execute: input.execute, stop: input.stop, verifyConsumedAdmission: input.verifyConsumedAdmission, verifyStoppedExport: async () => trusted };
    const report = await runG2Harness(fixture, legacy);
    expect(report.qualified).toBe(true);
  }, 30000);
  it('a verifier resolving past the deadline keeps the stop hook and sanitized private failure', async () => {
    const { fixture } = await qualifiedSample();
    let stopped = false;
    await expect(runG2Harness(fixture, { finalG1EvidenceAccepted: true, admissionId: 'parent-g2-late-1', timeoutMs: 1000,
      execute: (async () => ({ admissionId: 'parent-g2-late-1' })) as unknown as Parameters<typeof runG2Harness>[1]['execute'],
      stop: async () => { stopped = true; },
      verifyConsumedAdmission: async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); return true; },
      verifyStoppedExport: async () => { throw new Error('no export'); } })).rejects.toThrow('G2 execution/evidence unavailable');
    expect(stopped).toBe(true);
    const failures = (await import('node:fs')).readdirSync(fixture.privateRoot).filter((path) => path.startsWith('failure-'));
    expect(failures.length).toBe(1);
  }, 30000);
});

describe('invocation-bound stop proof in the canonical normalizer', () => {
  const base = (): G2CanonicalNativeReceipt => ({ identity: { assignmentId: 'a', stageId: 's', attemptId: 't', invocationId: 'inv-1' },
    launch: { boundaryIdentity: 'b', launchIdentity: 'l', admissionId: 'ad' }, terminal: { state: 'timeout' },
    toolPhase: { state: 'complete', itemCount: 0 }, decoderFailures: [], toolTrace: [] });
  const fixture = { probes: [] } as unknown as Parameters<typeof normalizeG2NativeReceipt>[0];
  const context = {} as Parameters<typeof normalizeG2NativeReceipt>[2];
  const teardown = { processTree: 'stopped-and-reaped' as const, boundary: 'terminated' as const, export: { inventoryHash: 'a'.repeat(64), head: 'b'.repeat(40) } };
  const run = (changed?: Partial<NonNullable<G2CanonicalNativeReceipt['teardown']>>) => {
    const receipt = changed === undefined ? base() : { ...base(), teardown: { ...teardown, ...changed } };
    return normalizeG2NativeReceipt(fixture, receipt, context);
  };
  it('fails closed without an invocation binding or on a mismatched one', () => {
    expect(run().teardownAwaited).toBe(false);
    expect(run().childTreeStopped).toBe(false);
    expect(run({ invocationId: 'other' }).teardownAwaited).toBe(false);
    expect(run({ invocationId: 'other' }).childTreeStopped).toBe(false);
    expect(run({ invocationId: 'inv-1' }).teardownAwaited).toBe(true);
    expect(run({ invocationId: 'inv-1' }).childTreeStopped).toBe(true);
  });
  it('requires the export claim inside the invocation-bound stop proof', () => {
    const receipt = { ...base(), teardown: { invocationId: 'inv-1', processTree: 'stopped-and-reaped' as const, boundary: 'terminated' as const } };
    const result = normalizeG2NativeReceipt(fixture, receipt, context);
    expect(result.teardownAwaited).toBe(false);
    expect(result.childTreeStopped).toBe(true);
  });
});

describe('guardian fixture ownership guards without daemon contact', () => {
  it('disposes a guardian-free private fixture', async () => {
    const fixture = createG2Fixture(); roots.push(fixture.privateRoot);
    await disposeG2Fixture(fixture);
    expect(existsSync(fixture.privateRoot)).toBe(false);
  });
  it('refuses disposal when the fixture root lost its private mode', async () => {
    const fixture = createG2Fixture(); roots.push(fixture.privateRoot);
    chmodSync(fixture.privateRoot, 0o750);
    await expect(disposeG2Fixture(fixture)).rejects.toThrow('private fixture ownership unavailable');
  });
  it('refuses disposal when the fixture root was swapped for a symlink', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cq-g2-swap-')); roots.push(parent);
    const fixture = createG2Fixture();
    const moved = join(parent, 'moved');
    renameSync(fixture.privateRoot, moved); symlinkSync(moved, fixture.privateRoot);
    roots.push(moved);
    await expect(disposeG2Fixture(fixture)).rejects.toThrow('private fixture ownership unavailable');
  });
  it('refuses disposal when the guardian record does not bind the fixture nonce', async () => {
    const fixture = createG2Fixture(); roots.push(fixture.privateRoot);
    fixture.guardian = { containerId: 'f'.repeat(64), volume: 'cq-s5-g2-other', daemonId: G2_EXPECTED_DAEMON_ID, image: FINAL_NATIVE_IMAGE };
    await expect(disposeG2Fixture(fixture)).rejects.toThrow('private guardian identity unavailable');
  });
  it('refuses re-provisioning before any daemon contact', async () => {
    const fixture = createG2Fixture(); roots.push(fixture.privateRoot);
    fixture.guardian = { containerId: 'f'.repeat(64), volume: 'cq-s5-g2-' + fixture.nonce, daemonId: G2_EXPECTED_DAEMON_ID, image: FINAL_NATIVE_IMAGE };
    await expect(provisionG2Guardian(fixture)).rejects.toThrow('guardian already provisioned');
  });
});
