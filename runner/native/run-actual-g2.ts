/** Strict actual-route G2 assembly: executor/decoder/admission/teardown joins.
 * This module composes and validates the production seams; it never launches a
 * model, provisions a daemon, redeems credit or dispatches on its own — the
 * conductor owns live admission and dispatch. Refusals are explicit typed
 * receipts, never synthetic qualification, shell substitution or caller-labelled
 * denial. `expectedAdmission` matches the PK09 boundary harness field-for-field
 * so the conductor can pass the identical frozen joins to both.
 */
import { resolve } from 'node:path';
import { verifyConsumedAdmissionRecord } from '../campaign/final-profile-admission.ts';
import type { G2ProbeFixture, G2TerminalState, G2ToolKind, G2TrustedContext, NativeExecutionReceipt, NativeToolTraceEvent } from './g2-harness.ts';
import { runG2Harness } from './g2-harness.ts';
import type { CollectedJsonlStream } from './codex-g2-events.ts';
import { decodeCodexShellEventFrames } from './codex-g2-events.ts';
import type { G2DenialEvidenceReceipt } from './g2-tool-events.ts';
import { applyTrustedDenialEvidence, createTrustedG2ControlVerifier } from './g2-tool-events.ts';
import type { SupervisedInvocationIdentity } from './process.ts';

export interface G2ChannelCapability {
  channel: G2ToolKind;
  qualification: 'observed' | 'unavailable';
  reason: string;
}

/** Declared per-channel capability for an exact native transport inventory.
 * The codex exec --json transport documents only `command_execution` (shell)
 * events; no other tool family is inferred from shell use, CLI help, model
 * prose, or a labels file. Unsupported channels are explicit and remain
 * unavailable until an authenticated producer protocol is admitted. */
export function declaredChannelCoverage(transport: { name: string; executableVersion?: string | null }): G2ChannelCapability[] {
  const channels: G2ToolKind[] = ['read', 'search', 'shell', 'http', 'config'];
  if (transport.name !== 'codex-exec') {
    return channels.map((channel) => ({
      channel, qualification: 'unavailable' as const,
      reason: `transport '${transport.name}' has no authenticated G2 producer inventory`,
    }));
  }
  return channels.map((channel) => channel === 'shell' ? {
    channel, qualification: 'observed' as const,
    reason: `codex exec --json command_execution events${transport.executableVersion ? ` (${transport.executableVersion})` : ''}`,
  } : {
    channel, qualification: 'unavailable' as const,
    reason: 'native tool protocol unobserved in the transport inventory; shell substitution refused',
  });
}

/** Explicit unavailable receipt for a profile the conductor has not qualified. */
export function unsupportedProfileReceipt(profile: string, reason: string): {
  profile: string; qualification: 'unavailable'; reason: string;
} {
  if (!profile.trim() || !reason.trim()) throw new Error('unsupported-profile receipts need an explicit profile and reason');
  return { profile, qualification: 'unavailable', reason };
}

export type ActualG2PreconditionFailure =
  | 'final-g1-evidence-unaccepted'
  | 'expected-admission-missing'
  | 'expected-admission-malformed'
  | 'guardian-unprovisioned'
  | 'required-channel-unavailable'
  | 'trusted-denial-receipts-absent';

/** Exact frozen joins; identical to the PK09 boundary harness expectedAdmission. */
export interface ActualG2ExpectedAdmission {
  ledgerRoot: string;
  sourcePin: string;
  assignmentId: string;
  attemptId: string;
  boundaryIdentity: string;
  invocationIdentity: string;
}

const hex64 = (value: string): boolean => /^[a-f0-9]{64}$/iu.test(value);

/** Validate every strict dispatch prerequisite. Any failure refuses dispatch
 * before any execution seam is touched; the returned reasons are the explicit
 * unavailable receipt for this attempt. */
export function validateActualG2DispatchPreconditions(input: {
  finalG1EvidenceAccepted: boolean;
  expectedAdmission?: ActualG2ExpectedAdmission;
  guardianProvisioned: boolean;
  capabilities: readonly G2ChannelCapability[];
  trustedDenialReceipts: readonly G2DenialEvidenceReceipt[];
}): { ready: true } | { ready: false; reason: ActualG2PreconditionFailure; detail: string } {
  if (!input.finalG1EvidenceAccepted) {
    return { ready: false, reason: 'final-g1-evidence-unaccepted', detail: 'final-profile G1 evidence for the exact frozen profile was not accepted' };
  }
  const expected = input.expectedAdmission;
  if (!expected) return { ready: false, reason: 'expected-admission-missing', detail: 'frozen consumed-admission joins are required before dispatch' };
  if (expected.ledgerRoot !== resolve(expected.ledgerRoot) || !hex64(expected.sourcePin) || !hex64(expected.boundaryIdentity) ||
      !hex64(expected.invocationIdentity) || !expected.assignmentId.trim() || !expected.attemptId.trim()) {
    return { ready: false, reason: 'expected-admission-malformed', detail: 'frozen admission joins need an absolute ledger root and exact source/boundary/invocation pins' };
  }
  if (!input.guardianProvisioned) {
    return { ready: false, reason: 'guardian-unprovisioned', detail: 'the private sibling guardian must be preregistered and provisioned before actual-route G2' };
  }
  const unavailable = input.capabilities.filter((capability) => capability.qualification !== 'observed');
  if (unavailable.length > 0) {
    return { ready: false, reason: 'required-channel-unavailable',
      detail: `channels without authenticated producers: ${unavailable.map((capability) => `${capability.channel} (${capability.reason})`).join('; ')}` };
  }
  if (input.trustedDenialReceipts.length === 0) {
    return { ready: false, reason: 'trusted-denial-receipts-absent', detail: 'denial probes require sealed trusted producer receipts; caller labels are never accepted' };
  }
  return { ready: true };
}

export interface CodexG2CollectedEvidence {
  toolPhase: { state: 'complete' | 'unavailable'; itemCount: number };
  decoderFailures: readonly string[];
  toolTrace: NativeToolTraceEvent[];
  channelCoverage: Record<G2ToolKind, 'observed' | 'unobserved'>;
}

/** Production collector→decoder wiring: bound collector failures into the
 * receipt's decoder failures, and upgrade a result event to a typed denial only
 * through a sealed trusted producer receipt. Any collector failure keeps the
 * tool phase unavailable. */
export function decodeCollectedCodexG2Stream(input: {
  invocationId: string;
  collected: CollectedJsonlStream;
  trustedDenialReceipts?: readonly G2DenialEvidenceReceipt[];
}): CodexG2CollectedEvidence {
  const decoded = decodeCodexShellEventFrames({ invocationId: input.invocationId, frames: input.collected.frames });
  const denialApplication = applyTrustedDenialEvidence(decoded.toolTrace, input.trustedDenialReceipts ?? []);
  const decoderFailures = [...decoded.decoderFailures, ...input.collected.failures.map((failure) => failure.reason)];
  const complete = decoded.toolPhase.state === 'complete' && input.collected.failures.length === 0 && !input.collected.truncated;
  return {
    toolPhase: { state: complete ? 'complete' : 'unavailable', itemCount: decoded.toolPhase.itemCount },
    decoderFailures,
    toolTrace: denialApplication.toolTrace,
    channelCoverage: decoded.channelCoverage,
  };
}

/** Assemble the native execution receipt from supervised transport results.
 * Teardown counts only when the independently observed stop proof names this
 * exact invocation and proves the process tree stopped; an export receipt is
 * retained only inside such an invocation-bound stop proof. */
export function assembleCodexG2Receipt(input: {
  identity: SupervisedInvocationIdentity;
  launch: { boundaryIdentity: string; launchIdentity: string; admissionId: string; profileInvocationIdentity?: string };
  terminal: { state: G2TerminalState; code: number | null; signal: string | null };
  evidence: CodexG2CollectedEvidence;
  stopProof?: { invocationId: string; processTree: 'stopped-and-reaped' } | null;
  exportReceipt?: { inventoryHash: string; head: string } | null;
}): NativeExecutionReceipt {
  const bound = input.stopProof?.invocationId === input.identity.invocationId && input.stopProof.processTree === 'stopped-and-reaped';
  return {
    identity: { ...input.identity },
    launch: { ...input.launch },
    terminal: { ...input.terminal },
    toolPhase: { ...input.evidence.toolPhase },
    decoderFailures: input.evidence.decoderFailures,
    toolTrace: input.evidence.toolTrace,
    teardown: bound ? {
      invocationId: input.identity.invocationId,
      processTree: 'stopped-and-reaped', boundary: 'terminated',
      export: input.exportReceipt ? { ...input.exportReceipt } : null,
    } : { processTree: 'unproven', boundary: 'unproven', export: null },
  };
}

/** Authoritative consumed-ledger verifier with exact source/assignment/stage/
 * attempt/invocation/boundary joins. It reads the parent's private ledger and
 * never echoes caller receipt fields. */
export function createConsumedAdmissionVerifier(expected: ActualG2ExpectedAdmission):
  (receipt: { admissionId: string }) => Promise<boolean> {
  return async (receipt) => verifyConsumedAdmissionRecord(expected.ledgerRoot, {
    admissionId: receipt.admissionId, stage: 'actual-route-G2', boundaryIdentity: expected.boundaryIdentity,
    invocationIdentity: expected.invocationIdentity, sourcePin: expected.sourcePin,
    assignmentId: expected.assignmentId, attemptId: expected.attemptId,
  });
}

/** Strict actual-route composition over the native G2 harness. Dispatch happens
 * only when every precondition holds; otherwise an explicit refusal receipt is
 * returned without touching the execution seam. */
export async function runActualG2(input: {
  fixture: G2ProbeFixture;
  context: G2TrustedContext;
  signal: AbortSignal;
  timeoutMs: number;
  finalG1EvidenceAccepted: boolean;
  expectedAdmission: ActualG2ExpectedAdmission;
  guardianProvisioned: boolean;
  capabilities: readonly G2ChannelCapability[];
  trustedDenialReceipts: readonly G2DenialEvidenceReceipt[];
  execute(request: { prompt: string; stage: 'actual-route-G2'; admissionId: string; signal: AbortSignal }): Promise<unknown>;
  stop(): Promise<{ invocationId: string; processTree: 'stopped-and-reaped'; boundary: 'terminated'; export: { inventoryHash: string; head: string } }>;
  decodeReceipt(actualResult: unknown): NativeExecutionReceipt | null;
}): Promise<{ refused: true; reason: ActualG2PreconditionFailure; detail: string } | { refused: false; report: Awaited<ReturnType<typeof runG2Harness>> }> {
  const preconditions = validateActualG2DispatchPreconditions(input);
  if (!preconditions.ready) return { refused: true, reason: preconditions.reason, detail: preconditions.detail };
  const report = await runG2Harness({
    fixture: input.fixture, context: input.context, signal: input.signal, timeoutMs: input.timeoutMs,
    execute: input.execute,
    stop: input.stop,
    verifyConsumedAdmission: createConsumedAdmissionVerifier(input.expectedAdmission),
    decodeReceipt: input.decodeReceipt,
    controlVerifier: createTrustedG2ControlVerifier(input.trustedDenialReceipts),
  });
  return { refused: false, report };
}
