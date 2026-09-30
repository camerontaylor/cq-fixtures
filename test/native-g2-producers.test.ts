/** PK08 native G2 producer regressions: bounded stdout collection, trusted
 * denial-evidence receipts, invocation-bound teardown wiring and strict
 * actual-route assembly. All checks are no-model development mechanisms; none
 * of them is an actual-route or campaign outcome. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodexCollectedEventFrame } from '../runner/native/codex-g2-events.ts';
import { createBoundedJsonlCollector } from '../runner/native/codex-g2-events.ts';
import type { ActualG2ExpectedAdmission } from '../runner/native/run-actual-g2.ts';
import {
  assembleCodexG2Receipt, createConsumedAdmissionVerifier, decodeCollectedCodexG2Stream,
  declaredChannelCoverage, runActualG2, unsupportedProfileReceipt, validateActualG2DispatchPreconditions,
} from '../runner/native/run-actual-g2.ts';
import type { G2DenialEvidenceReceipt } from '../runner/native/g2-tool-events.ts';
import {
  admittedChannelsForTransport, admitG2Producers, applyTrustedDenialEvidence, createAuthenticatedTransportInventory,
  createTrustedG2ControlVerifier, explicitG2ChannelUnavailable, producerProvenanceVerified,
  sealDenialEvidenceReceipt, verifyDenialEvidenceReceipt, verifyTransportInventoryIntegrity,
} from '../runner/native/g2-tool-events.ts';
import type { G2ProbeFixture, G2ToolKind, NativeExecutionReceipt } from '../runner/native/g2-harness.ts';
import { normalizeG2NativeReceipt, runG2Harness, toBoundaryCanonicalNativeReceipt } from '../runner/native/g2-harness.ts';
import type { FrozenFinalProfileApproval } from '../runner/campaign/final-profile-admission.ts';
import { freezeFinalProfileAdmission } from '../runner/campaign/final-profile-admission.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const identity = { invocationId: 'pk08-producer-inv', assignmentId: 'pk08-assign', stageId: 'stage-g2', attemptId: 'pk08-attempt' };
const context = { stage: 'actual-route-G2' as const, identity, admissionId: 'pk08-producer-admission-1',
  boundaryIdentity: 'boundary-pk08', launchIdentity: 'launch-pk08' };

/** Deterministic collector clock: one stamp per completed line, strictly increasing. */
function collectorOptions() {
  let clock = Date.parse('2026-09-30T00:00:00.000Z');
  return { now: (): string => new Date(clock += 50).toISOString() };
}

const shellCommand = 'printf CQ_PK08_SHELL_PROOF';
const shellEvent = (type: 'item.started' | 'item.completed', exitCode: number | null, status: string, output = '') => JSON.stringify({
  type, item: { id: 'item-pk08-1', type: 'command_execution', command: shellCommand, exit_code: exitCode, status, aggregated_output: output },
});

interface CollectedShell {
  collected: ReturnType<ReturnType<typeof createBoundedJsonlCollector>['result']>;
  resultFrame: CodexCollectedEventFrame;
}

/** Push a start/result shell pair through the bounded collector with split chunks. */
function collectShellPair(exitCode: number | null, status: string, output = ''): CollectedShell {
  const collector = createBoundedJsonlCollector(collectorOptions());
  collector.push(shellEvent('item.started', null, 'in_progress'));
  collector.push('\n');
  const head = shellEvent('item.completed', exitCode, status, output).slice(0, 40);
  collector.push(head);
  collector.push(shellEvent('item.completed', exitCode, status, output).slice(40) + '\n');
  collector.end();
  const collected = collector.result();
  const resultFrame = collected.frames.find((frame) => JSON.parse(String(frame.frame)).type === 'item.completed')!;
  return { collected, resultFrame };
}

function sealedShellDenialReceipt(resultFrame: CodexCollectedEventFrame, overrides: Partial<G2DenialEvidenceReceipt> = {}): G2DenialEvidenceReceipt {
  const unsealed = {
    producerProtocol: 'cq-g2-producer-v1' as const,
    producerId: 'native-tool-instrumentation',
    invocationId: identity.invocationId,
    probe: { correlationId: 'item-pk08-1', kind: 'shell' as const, targetOrCommand: shellCommand },
    denialKind: 'filesystem-denied' as const,
    observed: { toolStatus: 'failed', toolExitCode: 13, toolErrorCode: 'EACCES' as const },
    collectorSequence: resultFrame.collectorSequence,
    collectedAt: resultFrame.collectedAt,
    ...overrides,
  };
  return sealDenialEvidenceReceipt(unsealed);
}

const shellFixture = (outcome: 'success' | 'denied'): G2ProbeFixture => ({
  id: `pk08-shell-${outcome}`, prompt: 'Run only the named synthetic shell probe',
  expected: [{ correlationId: 'item-pk08-1', kind: 'shell', targetOrCommand: shellCommand, outcome }],
});

describe('bounded Codex JSONL stdout collector', () => {
  it('frames lines split across chunks with dense monotonic sequences and completion timestamps', () => {
    const { collected } = collectShellPair(0, 'completed', 'CQ_PK08_SHELL_PROOF');
    expect(collected.failures).toEqual([]);
    expect(collected.truncated).toBe(false);
    expect(collected.frames.map((frame) => frame.collectorSequence)).toEqual([0, 1]);
    expect(collected.frames[0]!.collectedAt < collected.frames[1]!.collectedAt).toBe(true);
    const decoded = decodeCollectedCodexG2Stream({ invocationId: identity.invocationId, collected });
    expect(decoded.toolPhase).toEqual({ state: 'complete', itemCount: 1 });
    expect(decoded.decoderFailures).toEqual([]);
    expect(decoded.channelCoverage).toMatchObject({ shell: 'observed', read: 'unobserved', http: 'unobserved' });
  });

  it('fails closed on an over-long line, total-byte overflow, frame-count overflow and truncated tails', () => {
    const longLine = JSON.stringify({ type: 'item.started', item: { id: 'x'.repeat(200), type: 'command_execution', command: 'ls', exit_code: null, status: 'in_progress', aggregated_output: '' } });
    const limited = createBoundedJsonlCollector({ ...collectorOptions(), maxLineBytes: 64 });
    limited.push(`${longLine}\n`);
    expect(limited.result().failures.map((failure) => failure.reason)).toEqual(['collector-line-limit-exceeded']);
    expect(limited.result().frames).toEqual([]);

    const tinyTotal = createBoundedJsonlCollector({ ...collectorOptions(), maxTotalBytes: 8 });
    tinyTotal.push(`${shellEvent('item.started', null, 'in_progress')}\n`);
    expect(tinyTotal.result().failures.map((failure) => failure.reason)).toEqual(['collector-total-limit-exceeded']);

    const tinyFrames = createBoundedJsonlCollector({ ...collectorOptions(), maxFrames: 1 });
    tinyFrames.push(`${shellEvent('item.started', null, 'in_progress')}\n${shellEvent('item.completed', 0, 'completed')}\n`);
    expect(tinyFrames.result().failures.map((failure) => failure.reason)).toEqual(['collector-frame-limit-exceeded']);
    expect(tinyFrames.result().frames).toHaveLength(1);

    const truncating = createBoundedJsonlCollector(collectorOptions());
    truncating.push('{"type":"item.started","item":{"id":"unterminated');
    truncating.end();
    expect(truncating.result().truncated).toBe(true);
    expect(truncating.result().failures.map((failure) => failure.reason)).toEqual(['collector-stream-truncated']);
    expect(truncating.result().frames).toEqual([]);
  });

  it('stays fail-closed after a fatal bound violation and never emits later frames', () => {
    const collector = createBoundedJsonlCollector({ ...collectorOptions(), maxLineBytes: 8 });
    collector.push('{"over":"line"}\n');
    collector.push(`${shellEvent('item.started', null, 'in_progress')}\n`);
    const result = collector.result();
    expect(result.failures).toHaveLength(1);
    expect(result.frames).toEqual([]);
  });
});

describe('collector-to-decoder production wiring keeps D44 ordering guarantees', () => {
  it('rejects an equal-time reversed result and duplicate or invalid frames arriving through the collector', () => {
    const reversed = createBoundedJsonlCollector({ now: () => '2026-09-30T00:00:00.000Z' });
    reversed.push(`${shellEvent('item.completed', 0, 'completed', 'out')}\n${shellEvent('item.started', null, 'in_progress')}\n`);
    const reversedEvidence = decodeCollectedCodexG2Stream({ invocationId: identity.invocationId, collected: reversed.result() });
    expect(reversedEvidence.decoderFailures).toContain('command-result-before-start');
    expect(reversedEvidence.toolPhase.state).toBe('unavailable');

    const duplicating = createBoundedJsonlCollector(collectorOptions());
    duplicating.push(`${shellEvent('item.started', null, 'in_progress')}\n${shellEvent('item.started', null, 'in_progress')}\n`);
    expect(decodeCollectedCodexG2Stream({ invocationId: identity.invocationId, collected: duplicating.result() }).decoderFailures)
      .toContain('duplicate-command-start');

    const invalid = createBoundedJsonlCollector(collectorOptions());
    invalid.push(`{not-json\n${shellEvent('item.started', null, 'in_progress')}\n${shellEvent('item.completed', 0, 'completed')}\n`);
    expect(decodeCollectedCodexG2Stream({ invocationId: identity.invocationId, collected: invalid.result() }).decoderFailures)
      .toContain('event-json-invalid');
  });

  it('keeps a completed tool phase separate from a later invocation timeout', () => {
    const { collected } = collectShellPair(0, 'completed', 'CQ_PK08_SHELL_PROOF');
    const evidence = decodeCollectedCodexG2Stream({ invocationId: identity.invocationId, collected });
    const receipt = assembleCodexG2Receipt({
      identity, launch: { boundaryIdentity: context.boundaryIdentity, launchIdentity: 'launch-pk08', admissionId: context.admissionId },
      terminal: { state: 'timeout', code: null, signal: 'SIGTERM' },
      evidence, stopProof: { invocationId: identity.invocationId, processTree: 'stopped-and-reaped' },
      exportReceipt: { inventoryHash: 'a'.repeat(64), head: 'b'.repeat(40) },
    });
    expect(receipt.toolPhase.state).toBe('complete');
    const normalized = normalizeG2NativeReceipt(shellFixture('success'), receipt, context,
      { invocationId: identity.invocationId, processTree: 'stopped-and-reaped', boundary: 'terminated',
        export: { inventoryHash: 'a'.repeat(64), head: 'b'.repeat(40) } });
    expect(normalized.status).toBe('complete');
    expect(normalized.terminal.state).toBe('timeout');
  });
});

describe('trusted producer denial evidence (D42)', () => {
  it('upgrades a failed shell result to a typed denial only through a sealed receipt', () => {
    const { collected, resultFrame } = collectShellPair(13, 'failed', 'EACCES-shaped output never proves denial');
    const decoded = decodeCodexShellEventFramesForTest(collected.frames);
    expect(decoded.toolTrace[1]?.outcome).toEqual({ disposition: 'unknown', exitCode: 13 });
    const receipt = sealedShellDenialReceipt(resultFrame);
    const upgraded = applyTrustedDenialEvidence(decoded.toolTrace, [receipt]);
    expect(upgraded.appliedCorrelationIds).toEqual(['item-pk08-1']);
    expect(upgraded.toolTrace[1]?.outcome).toMatchObject({ disposition: 'denied', denialKind: 'filesystem-denied', exitCode: 13, toolErrorCode: 'EACCES' });
    expect(verifyDenialEvidenceReceipt(receipt, { probe: receipt.probe, event: upgraded.toolTrace[1]! })).toBe(true);

    const normalized = normalizeG2NativeReceipt(shellFixture('denied'),
      shellReceipt(upgraded.toolTrace, { invocationId: receipt.invocationId, export: { inventoryHash: 'c'.repeat(64), head: 'd'.repeat(40) } }),
      context,
      { invocationId: identity.invocationId, processTree: 'stopped-and-reaped', boundary: 'terminated',
        export: { inventoryHash: 'c'.repeat(64), head: 'd'.repeat(40) } },
      createTrustedG2ControlVerifier([receipt]));
    expect(normalized.status).toBe('complete');
    expect(normalized.events[0]).toMatchObject({ outcome: 'denied', denialKind: 'filesystem-denied', toolErrorCode: 'EACCES' });
  });

  it('never accepts caller-labelled denials without a verifying trusted receipt', () => {
    const { collected } = collectShellPair(13, 'failed', 'EACCES: synthetic');
    const decoded = decodeCodexShellEventFramesForTest(collected.frames);
    const forged = decoded.toolTrace.map((event) => event.phase === 'result' ? { ...event,
      outcome: { disposition: 'denied' as const, denialKind: 'filesystem-denied' as const, exitCode: 13, toolErrorCode: 'EACCES' as const } } : event);
    const normalized = normalizeG2NativeReceipt(shellFixture('denied'),
      shellReceipt(forged, { export: { inventoryHash: 'c'.repeat(64), head: 'd'.repeat(40) } }), context,
      { invocationId: identity.invocationId, processTree: 'stopped-and-reaped', boundary: 'terminated',
        export: { inventoryHash: 'c'.repeat(64), head: 'd'.repeat(40) } });
    expect(normalized.status).toBe('unavailable');
    expect(normalized.failures).toContain('denial-control-unverified');
    expect(() => toBoundaryCanonicalNativeReceipt(shellReceipt(forged, { export: null }), shellFixture('denied'))).toThrow(/denial-control-unverified/u);
  });

  it('rejects sealed receipts whose invocation, probe, frame, observed or hash bindings disagree', () => {
    const { collected, resultFrame } = collectShellPair(13, 'failed');
    const decoded = decodeCodexShellEventFramesForTest(collected.frames);
    const authentic = sealedShellDenialReceipt(resultFrame);
    const upgraded = applyTrustedDenialEvidence(decoded.toolTrace, [authentic]);
    const event = upgraded.toolTrace[1]!;
    expect(upgraded.appliedCorrelationIds).toEqual(['item-pk08-1']);
    expect(verifyDenialEvidenceReceipt(authentic, { probe: authentic.probe, event })).toBe(true);
    const mismatches: Array<[string, Partial<G2DenialEvidenceReceipt>]> = [
      ['invocation', { invocationId: 'other-invocation' }],
      ['target', { probe: { correlationId: 'item-pk08-1', kind: 'shell', targetOrCommand: 'printf OTHER' } }],
      ['kind', { probe: { correlationId: 'item-pk08-1', kind: 'read', targetOrCommand: shellCommand } }],
      ['status', { observed: { toolStatus: 'completed', toolExitCode: 13, toolErrorCode: 'EACCES' } }],
      ['exit', { observed: { toolStatus: 'failed', toolExitCode: 12, toolErrorCode: 'EACCES' } }],
      ['errno-for-403', { denialKind: 'broker-403', observed: { toolStatus: 'failed', toolExitCode: 13, toolErrorCode: 'EACCES' } }],
      ['correlation', { probe: { correlationId: 'item-other', kind: 'shell', targetOrCommand: shellCommand } }],
    ];
    for (const [name, override] of mismatches) {
      const receipt = sealedShellDenialReceipt(resultFrame, override);
      expect(verifyDenialEvidenceReceipt(receipt, { probe: receipt.probe, event }), name).toBe(false);
    }
    const wrongSequence = sealedShellDenialReceipt({ ...resultFrame, collectorSequence: resultFrame.collectorSequence + 5 });
    expect(verifyDenialEvidenceReceipt(wrongSequence, { probe: wrongSequence.probe, event }), 'sequence').toBe(false);
    const tampered = { ...authentic, receiptHash: 'f'.repeat(64) };
    expect(verifyDenialEvidenceReceipt(tampered, { probe: authentic.probe, event }), 'hash').toBe(false);
    const rejectedUpgrade = applyTrustedDenialEvidence(decoded.toolTrace, [wrongSequence]);
    expect(rejectedUpgrade.appliedCorrelationIds).toEqual([]);
    expect(rejectedUpgrade.toolTrace[1]?.outcome).toEqual({ disposition: 'unknown', exitCode: 13 });
  });

  it('corroborates non-shell denials through typed evidence and rejects wrong HTTP status', () => {
    const target = 'http://172.29.249.2:8080/route/refresh/oauth/token';
    const startEvent = {
      eventId: 'http-1:start', invocationId: identity.invocationId, collectorSequence: 4,
      phase: 'start' as const, kind: 'http' as const, targetOrCommand: target,
      correlationId: 'http-1', at: '2026-09-30T00:00:00.900Z', toolStatus: 'in_progress', toolExitCode: null,
    };
    const httpEvent = {
      eventId: 'http-1:result', invocationId: identity.invocationId, collectorSequence: 5,
      phase: 'result' as const, kind: 'http' as const, targetOrCommand: target,
      correlationId: 'http-1', at: '2026-09-30T00:00:01.000Z', toolStatus: 'failed', toolExitCode: 1,
      outcome: { disposition: 'denied' as const, denialKind: 'broker-403' as const, exitCode: 1, httpStatus: 403 },
    };
    const sealed = (httpStatus: number) => sealDenialEvidenceReceipt({
      producerProtocol: 'cq-g2-producer-v1', producerId: 'native-tool-instrumentation', invocationId: identity.invocationId,
      probe: { correlationId: 'http-1', kind: 'http', targetOrCommand: target },
      denialKind: 'broker-403', observed: { toolStatus: 'failed', toolExitCode: 1, httpStatus },
      collectorSequence: httpEvent.collectorSequence, collectedAt: httpEvent.at,
    });
    const verifier = createTrustedG2ControlVerifier([sealed(403)]);
    const fixture: G2ProbeFixture = { id: 'pk08-http', prompt: 'probe', expected: [
      { correlationId: 'http-1', kind: 'http', targetOrCommand: target, outcome: 'denied' }] };
    const httpReceipt = shellReceipt([startEvent, httpEvent], { export: { inventoryHash: 'a'.repeat(64), head: 'b'.repeat(40) } });
    const normalized = normalizeG2NativeReceipt(fixture, httpReceipt, context,
      { invocationId: identity.invocationId, processTree: 'stopped-and-reaped', boundary: 'terminated',
        export: { inventoryHash: 'a'.repeat(64), head: 'b'.repeat(40) } }, verifier);
    expect(normalized.status).toBe('complete');
    expect(normalized.events[0]).toMatchObject({ outcome: 'denied', denialKind: 'broker-403', httpStatus: 403 });

    const wrongStatus = { ...httpEvent, outcome: { ...httpEvent.outcome, httpStatus: 200 } };
    expect(verifyDenialEvidenceReceipt(sealed(200), { probe: sealed(200).probe, event: wrongStatus })).toBe(false);
    const unverified = normalizeG2NativeReceipt(fixture, shellReceipt([startEvent, wrongStatus], { export: { inventoryHash: 'a'.repeat(64), head: 'b'.repeat(40) } }),
      context, { invocationId: identity.invocationId, processTree: 'stopped-and-reaped', boundary: 'terminated',
        export: { inventoryHash: 'a'.repeat(64), head: 'b'.repeat(40) } }, verifier);
    expect(unverified.status).toBe('unavailable');
    expect(unverified.failures).toContain('denial-control-unverified');
  });

  it('marks unsupported channels and profiles explicitly unavailable instead of substituting shell', () => {
    expect(explicitG2ChannelUnavailable('read', 'native tool protocol unobserved in the transport inventory'))
      .toEqual({ channel: 'read', qualification: 'unavailable', reason: 'native tool protocol unobserved in the transport inventory' });
    const codexCoverage = declaredChannelCoverage({ name: 'codex-exec', executableVersion: 'codex-cli 0.155.1' });
    expect(codexCoverage.find((capability) => capability.channel === 'shell')?.qualification).toBe('observed');
    for (const channel of ['read', 'search', 'http', 'config'] as const) {
      expect(codexCoverage.find((capability) => capability.channel === channel)).toMatchObject({ qualification: 'unavailable' });
    }
    const unknownCoverage = declaredChannelCoverage({ name: 'unknown-transport' });
    expect(unknownCoverage.every((capability) => capability.qualification === 'unavailable')).toBe(true);
    expect(unsupportedProfileReceipt('pi-opencode/opencode-go/space-bunny-free', 'no admitted G2 producer inventory for this profile'))
      .toMatchObject({ qualification: 'unavailable' });
  });
});

describe('strict actual-route assembly (D45)', () => {
  const hex = (character: string) => character.repeat(64);
  const expectedAdmission: ActualG2ExpectedAdmission = {
    ledgerRoot: '/tmp/pk08-unused-ledger', sourcePin: hex('a'), assignmentId: identity.assignmentId,
    attemptId: identity.attemptId, boundaryIdentity: hex('b'), invocationIdentity: hex('c'),
  };
  // Host-owned authenticated transport inventory and an explicitly admitted
  // producer registry. The channel set is module-fixed: codex-exec admits only
  // shell, and no authentic non-shell producer exists.
  const inventory = createAuthenticatedTransportInventory({
    transport: 'codex-exec', resolvedExecutable: process.execPath,
    executableVersion: 'codex-cli 0.155.1', observedAt: '2026-09-30T00:00:00.000Z',
  });
  const registry = admitG2Producers([
    { producerId: 'native-tool-instrumentation', transport: 'codex-exec', channels: ['shell'] },
  ]);
  const producerAuthority = { registry, inventory };
  const devReceipts = (): G2DenialEvidenceReceipt[] => [
    sealedShellDenialReceipt({ frame: '', collectorSequence: 0, collectedAt: '2026-09-30T00:00:00.000Z' })];

  it('refuses dispatch, without touching the execution seam, while required channels lack admitted producers', async () => {
    let executed = false;
    const result = await runActualG2({
      fixture: shellFixture('success'), context, signal: new AbortController().signal, timeoutMs: 10_000,
      finalG1EvidenceAccepted: true, expectedAdmission, guardianProvisioned: true,
      inventory, trustedDenialReceipts: devReceipts(), producerAuthority,
      execute: async () => { executed = true; return {}; },
      stop: async () => ({ invocationId: identity.invocationId, processTree: 'stopped-and-reaped', boundary: 'terminated', export: { inventoryHash: hex('a'), head: hex('b').slice(0, 40) } }),
      decodeReceipt: () => null,
    });
    expect(result.refused).toBe(true);
    if (!result.refused) return;
    expect(result.reason).toBe('required-channel-unavailable');
    expect(result.detail).toContain('read');
    expect(result.detail).toContain('config');
    expect(result.qualification).toBe('refused');
    expect(result.qualificationAuthority).toBe('conductor-boundary-runG2Harness-with-expectedAdmission-required');
    expect(executed).toBe(false);
  });

  it('refuses every missing strict prerequisite and can never report ready for the known transport', () => {
    // The standing truth for the known codex transport: required non-shell
    // channels have no admitted producers, so production preconditions are
    // unreachable-ready by construction. The former fake-ready expectation
    // (caller-mapped all-observed capabilities => ready) was the F01 finding.
    const base = { finalG1EvidenceAccepted: true, expectedAdmission, guardianProvisioned: true,
      inventory, trustedDenialReceipts: devReceipts(), producerAuthority };
    expect(validateActualG2DispatchPreconditions(base)).toMatchObject({ ready: false, reason: 'required-channel-unavailable' });
    expect(validateActualG2DispatchPreconditions({ ...base, finalG1EvidenceAccepted: false })).toMatchObject({ ready: false, reason: 'final-g1-evidence-unaccepted' });
    expect(validateActualG2DispatchPreconditions({ ...base, expectedAdmission: undefined })).toMatchObject({ ready: false, reason: 'expected-admission-missing' });
    expect(validateActualG2DispatchPreconditions({ ...base, expectedAdmission: { ...expectedAdmission, sourcePin: 'short' } })).toMatchObject({ ready: false, reason: 'expected-admission-malformed' });
    expect(validateActualG2DispatchPreconditions({ ...base, expectedAdmission: { ...expectedAdmission, ledgerRoot: 'relative/ledger' } })).toMatchObject({ ready: false, reason: 'expected-admission-malformed' });
    expect(validateActualG2DispatchPreconditions({ ...base, guardianProvisioned: false })).toMatchObject({ ready: false, reason: 'guardian-unprovisioned' });
    // With receipts present and authenticated, the standing channel gap refuses;
    // an empty receipt set also hits the channel gate first. The
    // trusted-denial-receipts-absent gate guards future fully-admitted transports.
    expect(validateActualG2DispatchPreconditions({ ...base, trustedDenialReceipts: [] })).toMatchObject({ ready: false, reason: 'required-channel-unavailable' });
  });

  it('F01: caller-forged all-observed capability claims cannot reach the production gate', () => {
    // The forged mapping a caller could pass at the old head; production
    // preconditions no longer accept capability input at all.
    const forgedAllObserved = declaredChannelCoverage({ name: 'codex-exec' })
      .map((capability) => ({ ...capability, qualification: 'observed' as const }));
    expect(forgedAllObserved.every((capability) => capability.qualification === 'observed')).toBe(true);
    void forgedAllObserved;
    // The channel set comes only from the module-fixed ceiling of the
    // authenticated inventory, so even a hostile inventory admits only shell.
    expect(admittedChannelsForTransport('codex-exec')).toEqual(['shell']);
    expect(admittedChannelsForTransport('unknown-transport')).toEqual([]);
    expect(inventory.admittedChannels).toEqual(['shell']);
    const verdict = validateActualG2DispatchPreconditions({
      finalG1EvidenceAccepted: true, expectedAdmission, guardianProvisioned: true,
      inventory, trustedDenialReceipts: devReceipts(), producerAuthority,
    });
    expect(verdict).toMatchObject({ ready: false, reason: 'required-channel-unavailable' });
    if (!verdict.ready) expect(verdict.detail).toContain('no authenticated producer protocol is admitted');
  });

  it('F01: self-sealed receipts stay structurally valid but authenticate only through admitted provenance', () => {
    const { collected } = collectShellPair(13, 'failed', 'EACCES-shaped');
    const decoded = decodeCodexShellEventFramesForTest(collected.frames);
    const rawResult = decoded.toolTrace[1]!;
    const forged = sealDenialEvidenceReceipt({
      producerProtocol: 'cq-g2-producer-v1', producerId: 'attacker-forged-producer', invocationId: identity.invocationId,
      probe: { correlationId: 'item-pk08-1', kind: 'shell', targetOrCommand: shellCommand },
      denialKind: 'filesystem-denied', observed: { toolStatus: 'failed', toolExitCode: 13, toolErrorCode: 'EACCES' },
      collectorSequence: rawResult.collectorSequence, collectedAt: rawResult.at,
    });
    const forgedEvent = { ...rawResult,
      outcome: { disposition: 'denied' as const, denialKind: 'filesystem-denied' as const, exitCode: 13, toolErrorCode: 'EACCES' as const } };
    // Structural integrity holds — self-sealing proves integrity only.
    expect(verifyDenialEvidenceReceipt(forged, { probe: forged.probe, event: forgedEvent })).toBe(true);
    // Provenance refuses the unadmitted producer identity.
    expect(producerProvenanceVerified(forged, { registry, inventory })).toBe(false);
    expect(createTrustedG2ControlVerifier([forged], { registry, inventory }).verifyDenialEvidence({ probe: forged.probe, event: forgedEvent })).toBe(false);
    // Production preconditions refuse the forged proof before any dispatch.
    const verdict = validateActualG2DispatchPreconditions({
      finalG1EvidenceAccepted: true, expectedAdmission, guardianProvisioned: true,
      inventory, trustedDenialReceipts: [forged], producerAuthority,
    });
    expect(verdict).toMatchObject({ ready: false, reason: 'trusted-denial-receipts-unauthenticated' });
    if (!verdict.ready) expect(verdict.detail).toContain('not authentication');
    // The upgrade path also refuses without provenance, and upgrades only in the
    // explicit development form without an authority.
    const gated = applyTrustedDenialEvidence(decoded.toolTrace, [forged], { registry, inventory });
    expect(gated.appliedCorrelationIds).toEqual([]);
    expect(gated.toolTrace[1]?.outcome).toEqual({ disposition: 'unknown', exitCode: 13 });
    const devOnly = applyTrustedDenialEvidence(decoded.toolTrace, [forged]);
    expect(devOnly.appliedCorrelationIds).toEqual(['item-pk08-1']);
    // The admitted producer still authenticates under the same authority.
    const { resultFrame } = collectShellPair(13, 'failed');
    const admitted = sealedShellDenialReceipt(resultFrame);
    expect(producerProvenanceVerified(admitted, { registry, inventory })).toBe(true);
  });

  it('F01: producer admission can never exceed the fixed transport channel ceiling', () => {
    expect(() => admitG2Producers([{ producerId: 'p', transport: 'codex-exec', channels: ['read'] }])).toThrow(/channel ceiling/u);
    expect(() => admitG2Producers([{ producerId: 'p', transport: 'codex-exec', channels: [] }])).toThrow(/channel ceiling/u);
    expect(() => admitG2Producers([{ producerId: 'p', transport: 'unknown-transport' as 'codex-exec', channels: ['shell'] }])).toThrow(/one known transport/u);
    expect(() => admitG2Producers([
      { producerId: 'dup', transport: 'codex-exec', channels: ['shell'] },
      { producerId: 'dup', transport: 'codex-exec', channels: ['shell'] },
    ])).toThrow(/more than once/u);
    const shellRegistry = admitG2Producers([{ producerId: 'p', transport: 'codex-exec', channels: ['shell'] }]);
    expect(shellRegistry.admits('p', 'shell')).toBe(true);
    expect(shellRegistry.admits('p', 'read')).toBe(false);
    expect(shellRegistry.admits('other', 'shell')).toBe(false);
  });

  it('F01: tampered, retagged or host-stale transport inventories fail authentication', () => {
    expect(verifyTransportInventoryIntegrity(inventory)).toBe(true);
    const widened = { ...inventory, admittedChannels: ['shell', 'read'] as G2ToolKind[] };
    expect(verifyTransportInventoryIntegrity(widened)).toBe(false);
    const retagged = { ...inventory, inventoryId: 'f'.repeat(64) };
    expect(verifyTransportInventoryIntegrity(retagged)).toBe(false);
    const relative = { ...inventory, resolvedExecutable: 'relative/node' };
    expect(verifyTransportInventoryIntegrity(relative)).toBe(false);
    expect(() => createAuthenticatedTransportInventory({
      transport: 'codex-exec', resolvedExecutable: '/nonexistent/cq-missing-binary', observedAt: '2026-09-30T00:00:00.000Z',
    })).toThrow(/does not exist/u);
    expect(() => createAuthenticatedTransportInventory({
      transport: 'codex-exec', resolvedExecutable: 'relative/node', observedAt: '2026-09-30T00:00:00.000Z',
    })).toThrow(/absolute/u);
    const verdict = validateActualG2DispatchPreconditions({
      finalG1EvidenceAccepted: true, expectedAdmission, guardianProvisioned: true,
      inventory: widened as typeof inventory, trustedDenialReceipts: devReceipts(), producerAuthority,
    });
    expect(verdict).toMatchObject({ ready: false, reason: 'transport-inventory-unauthenticated' });
  });

  it('verifies consumed admission against the real private ledger and refuses replay or wrong joins', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'cq-pk08-ledger-')); roots.push(ledgerRoot);
    const approval: FrozenFinalProfileApproval = {
      receipt: { admissionId: context.admissionId, stage: 'actual-route-G2', profile: 'cq-subscription-http',
        boundaryIdentity: hex('b'), invocationIdentity: hex('c'), expiresAt: Date.now() + 600_000, heldOut: false },
      assignmentId: identity.assignmentId, attemptId: identity.attemptId, sourcePin: hex('a'),
    };
    const joins = { ledgerRoot, sourcePin: hex('a'), assignmentId: identity.assignmentId, attemptId: identity.attemptId,
      boundaryIdentity: hex('b'), invocationIdentity: hex('c') };
    const unconsumed = createConsumedAdmissionVerifier({ ...joins });
    await expect(unconsumed({ admissionId: context.admissionId })).resolves.toBe(false);
    const admit = await freezeFinalProfileAdmission(ledgerRoot, approval);
    await admit({ stage: 'actual-route-G2', boundaryIdentity: hex('b'), invocationIdentity: hex('c') });
    const verifier = createConsumedAdmissionVerifier(joins);
    await expect(verifier({ admissionId: context.admissionId })).resolves.toBe(true);
    const replayId = 'pk08-replay-admission-1';
    await expect(verifier({ admissionId: replayId })).resolves.toBe(false);
    await expect(createConsumedAdmissionVerifier({ ...joins, sourcePin: hex('d') })({ admissionId: context.admissionId })).resolves.toBe(false);
    await expect(createConsumedAdmissionVerifier({ ...joins, invocationIdentity: hex('e') })({ admissionId: context.admissionId })).resolves.toBe(false);
  });

  it('binds teardown to the exact invocation and keeps mismatched stop proofs unproven', () => {
    const { collected } = collectShellPair(0, 'completed', 'CQ_PK08_SHELL_PROOF');
    const evidence = decodeCollectedCodexG2Stream({ invocationId: identity.invocationId, collected });
    const bound = assembleCodexG2Receipt({
      identity, launch: { boundaryIdentity: context.boundaryIdentity, launchIdentity: 'launch-pk08', admissionId: context.admissionId },
      terminal: { state: 'exit', code: 0, signal: null }, evidence,
      stopProof: { invocationId: identity.invocationId, processTree: 'stopped-and-reaped' },
      exportReceipt: { inventoryHash: hex('a'), head: hex('b').slice(0, 40) },
    });
    expect(bound.teardown).toMatchObject({ invocationId: identity.invocationId, processTree: 'stopped-and-reaped', boundary: 'terminated' });
    const canonical = toBoundaryCanonicalNativeReceipt(bound);
    expect(canonical.teardown).toMatchObject({ invocationId: identity.invocationId });

    const mismatched = assembleCodexG2Receipt({
      identity, launch: bound.launch, terminal: { state: 'exit', code: 0, signal: null }, evidence,
      stopProof: { invocationId: 'another-invocation', processTree: 'stopped-and-reaped' },
      exportReceipt: { inventoryHash: hex('a'), head: hex('b').slice(0, 40) },
    });
    expect(mismatched.teardown).toMatchObject({ processTree: 'unproven', boundary: 'unproven', export: null });
    const tamperedBinding: NativeExecutionReceipt = { ...bound, teardown: { ...bound.teardown, invocationId: 'another-invocation' } };
    expect(() => toBoundaryCanonicalNativeReceipt(tamperedBinding)).toThrow(/teardown-invocation-unbound/u);
    const normalized = normalizeG2NativeReceipt(shellFixture('success'), tamperedBinding, context,
      { invocationId: identity.invocationId, processTree: 'stopped-and-reaped', boundary: 'terminated',
        export: { inventoryHash: hex('a'), head: hex('b').slice(0, 40) } });
    expect(normalized.failures).toContain('receipt-teardown-invocation-unbound');
  });

  it('composes collector, decoder, sealed denial, consumed ledger and invocation-bound teardown end to end', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'cq-pk08-ledger-')); roots.push(ledgerRoot);
    const approval: FrozenFinalProfileApproval = {
      receipt: { admissionId: context.admissionId, stage: 'actual-route-G2', profile: 'cq-subscription-http',
        boundaryIdentity: hex('b'), invocationIdentity: hex('c'), expiresAt: Date.now() + 600_000, heldOut: false },
      assignmentId: identity.assignmentId, attemptId: identity.attemptId, sourcePin: hex('a'),
    };
    const admit = await freezeFinalProfileAdmission(ledgerRoot, approval);
    await admit({ stage: 'actual-route-G2', boundaryIdentity: hex('b'), invocationIdentity: hex('c') });

    const success = collectShellPair(0, 'completed', 'CQ_PK08_SHELL_PROOF');
    const successEvidence = decodeCollectedCodexG2Stream({ invocationId: identity.invocationId, collected: success.collected });
    // A second invocation-local collector stream for the denied probe, rebased onto
    // strictly increasing sequences and later timestamps before decoding, so the
    // combined receipt stays order-valid and the sealed receipt binds the rebased frame.
    const denial = collectShellPair(13, 'failed', 'EACCES-shaped');
    const denialCommand = JSON.parse(String(denial.resultFrame.frame)).item.command as string;
    const denialCorrelation = 'item-pk08-denied';
    const rebasedFrames = denial.collected.frames.map((frame) => {
      const parsed = JSON.parse(String(frame.frame)) as { item: { id: string } };
      parsed.item.id = denialCorrelation;
      return {
        frame: JSON.stringify(parsed),
        collectorSequence: frame.collectorSequence + success.collected.frames.length,
        collectedAt: new Date(Date.parse(frame.collectedAt) + 1_000).toISOString(),
      };
    });
    const rebasedResultFrame = rebasedFrames.find((frame) => JSON.parse(String(frame.frame)).type === 'item.completed')!;
    const denialReceipt = sealDenialEvidenceReceipt({
      producerProtocol: 'cq-g2-producer-v1', producerId: 'native-tool-instrumentation', invocationId: identity.invocationId,
      probe: { correlationId: denialCorrelation, kind: 'shell', targetOrCommand: denialCommand },
      denialKind: 'filesystem-denied', observed: { toolStatus: 'failed', toolExitCode: 13, toolErrorCode: 'EACCES' },
      collectorSequence: rebasedResultFrame.collectorSequence, collectedAt: rebasedResultFrame.collectedAt,
    });
    const denialEvidence = decodeCollectedCodexG2Stream({ invocationId: identity.invocationId,
      collected: { frames: rebasedFrames, failures: [], truncated: false }, trustedDenialReceipts: [denialReceipt] });
    const evidence = {
      toolPhase: { state: 'complete' as const, itemCount: 2 },
      decoderFailures: [...successEvidence.decoderFailures, ...denialEvidence.decoderFailures],
      toolTrace: [...successEvidence.toolTrace, ...denialEvidence.toolTrace],
      channelCoverage: successEvidence.channelCoverage,
    };
    const executionReceipt = assembleCodexG2Receipt({
      identity, launch: { boundaryIdentity: context.boundaryIdentity, launchIdentity: 'launch-pk08', admissionId: context.admissionId },
      terminal: { state: 'exit', code: 0, signal: null }, evidence,
      stopProof: { invocationId: identity.invocationId, processTree: 'stopped-and-reaped' },
      exportReceipt: { inventoryHash: hex('9'), head: hex('8').slice(0, 40) },
    });
    const fixture: G2ProbeFixture = { id: 'pk08-assembly', prompt: 'shell probes',
      expected: [
        { correlationId: 'item-pk08-1', kind: 'shell', targetOrCommand: shellCommand, outcome: 'success' },
        { correlationId: denialCorrelation, kind: 'shell', targetOrCommand: denialCommand, outcome: 'denied' },
      ] };
    const report = await runG2Harness({
      fixture, context, signal: new AbortController().signal, timeoutMs: 10_000,
      execute: async () => ({ admissionId: context.admissionId, executionReceipt }),
      stop: async () => ({ invocationId: identity.invocationId, processTree: 'stopped-and-reaped' as const, boundary: 'terminated' as const,
        export: { inventoryHash: hex('9'), head: hex('8').slice(0, 40) } }),
      verifyConsumedAdmission: createConsumedAdmissionVerifier({ ledgerRoot, sourcePin: hex('a'), assignmentId: identity.assignmentId,
        attemptId: identity.attemptId, boundaryIdentity: hex('b'), invocationIdentity: hex('c') }),
      decodeReceipt: (value) => (value as { executionReceipt: NativeExecutionReceipt }).executionReceipt,
      controlVerifier: createTrustedG2ControlVerifier([denialReceipt]),
    });
    expect(report.failures).toEqual([]);
    expect(report.status).toBe('complete');
    expect(report.events).toEqual([
      { correlationId: 'item-pk08-1', kind: 'shell', targetOrCommand: shellCommand, outcome: 'success', exitCode: 0 },
      { correlationId: denialCorrelation, kind: 'shell', targetOrCommand: denialCommand, outcome: 'denied', denialKind: 'filesystem-denied', exitCode: 13, toolErrorCode: 'EACCES' },
    ]);
    expect(report.teardown).toMatchObject({ invocationId: identity.invocationId, processTree: 'stopped-and-reaped' });
  });

  it('refuses the composed run when the stop proof names another invocation', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'cq-pk08-ledger-')); roots.push(ledgerRoot);
    const approval: FrozenFinalProfileApproval = {
      receipt: { admissionId: context.admissionId, stage: 'actual-route-G2', profile: 'cq-subscription-http',
        boundaryIdentity: hex('b'), invocationIdentity: hex('c'), expiresAt: Date.now() + 600_000, heldOut: false },
      assignmentId: identity.assignmentId, attemptId: identity.attemptId, sourcePin: hex('a'),
    };
    const admit = await freezeFinalProfileAdmission(ledgerRoot, approval);
    await admit({ stage: 'actual-route-G2', boundaryIdentity: hex('b'), invocationIdentity: hex('c') });
    const { collected } = collectShellPair(0, 'completed', 'CQ_PK08_SHELL_PROOF');
    const evidence = decodeCollectedCodexG2Stream({ invocationId: identity.invocationId, collected });
    const executionReceipt = assembleCodexG2Receipt({
      identity, launch: { boundaryIdentity: context.boundaryIdentity, launchIdentity: 'launch-pk08', admissionId: context.admissionId },
      terminal: { state: 'exit', code: 0, signal: null }, evidence,
      stopProof: { invocationId: 'another-invocation', processTree: 'stopped-and-reaped' }, exportReceipt: null,
    });
    const report = await runG2Harness({
      fixture: shellFixture('success'), context, signal: new AbortController().signal, timeoutMs: 10_000,
      execute: async () => ({ admissionId: context.admissionId, executionReceipt }),
      stop: async () => ({ invocationId: 'another-invocation', processTree: 'stopped-and-reaped' as const, boundary: 'terminated' as const,
        export: { inventoryHash: hex('9'), head: hex('8').slice(0, 40) } }),
      verifyConsumedAdmission: createConsumedAdmissionVerifier({ ledgerRoot, sourcePin: hex('a'), assignmentId: identity.assignmentId,
        attemptId: identity.attemptId, boundaryIdentity: hex('b'), invocationIdentity: hex('c') }),
      decodeReceipt: (value) => (value as { executionReceipt: NativeExecutionReceipt }).executionReceipt,
    });
    expect(report.status).toBe('unavailable');
    expect(report.failures).toContain('receipt-teardown-unproven');
    expect(report.failures).toContain('trusted-teardown-unproven');
    expect(report.teardown).toBeNull();
  });
});

/** Local helpers: decode a collector stream without denial receipts, and build a
 * receipt around an explicit trace. */
function decodeCodexShellEventFramesForTest(frames: readonly CodexCollectedEventFrame[]) {
  return decodeCollectedCodexG2Stream({ invocationId: identity.invocationId, collected: { frames: [...frames], failures: [], truncated: false } });
}

function shellReceipt(toolTrace: NativeExecutionReceipt['toolTrace'], options: { invocationId?: string; export: { inventoryHash: string; head: string } | null }): NativeExecutionReceipt {
  return {
    identity, launch: { boundaryIdentity: context.boundaryIdentity, launchIdentity: 'launch-pk08', admissionId: context.admissionId },
    terminal: { state: 'exit', code: 0, signal: null },
    toolPhase: { state: 'complete', itemCount: toolTrace.filter((event) => event.phase === 'result').length },
    decoderFailures: [], toolTrace,
    teardown: { ...(options.invocationId ? { invocationId: options.invocationId } : {}),
      processTree: 'stopped-and-reaped', boundary: 'terminated', export: options.export },
  };
}
