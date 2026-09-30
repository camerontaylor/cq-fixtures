/** Trusted G2 producer receipts and the production denial-evidence verifier.
 * A denial disposition never originates here from model prose, shell output text,
 * or caller labels: it is upgraded only when a hash-sealed producer receipt binds
 * the exact invocation, probe, collector frame and observed typed evidence.
 * Channels without an authenticated producer protocol stay explicitly unavailable.
 */
import { createHash } from 'node:crypto';
import type { G2ControlProof, G2DenialKind, G2ToolErrorCode, G2ToolKind, NativeToolTraceEvent } from './g2-harness.ts';

export const G2_PRODUCER_PROTOCOL_VERSION = 'cq-g2-producer-v1';

/** Private producer-side receipt sealed by the trusted native instrumentation.
 * The conductor admits the producer identities; this module only validates
 * structure, hash integrity and exact joins — it never mints evidence. */
export interface G2DenialEvidenceReceipt {
  producerProtocol: 'cq-g2-producer-v1';
  producerId: string;
  invocationId: string;
  probe: { correlationId: string; kind: G2ToolKind; targetOrCommand: string };
  denialKind: G2DenialKind;
  observed: {
    toolStatus: string;
    toolExitCode?: number | null;
    httpStatus?: number;
    toolErrorCode?: G2ToolErrorCode;
    controlProof?: G2ControlProof;
  };
  collectorSequence: number;
  collectedAt: string;
  /** sha256 over canonicalDenialReceiptBytes of this receipt with receiptHash omitted. */
  receiptHash: string;
}

/** Deterministic serialization; field order is part of the sealed bytes. */
export function canonicalDenialReceiptBytes(receipt: Omit<G2DenialEvidenceReceipt, 'receiptHash'>): string {
  const observed = {
    toolStatus: receipt.observed.toolStatus,
    ...(receipt.observed.toolExitCode === undefined ? {} : { toolExitCode: receipt.observed.toolExitCode }),
    ...(receipt.observed.httpStatus === undefined ? {} : { httpStatus: receipt.observed.httpStatus }),
    ...(receipt.observed.toolErrorCode === undefined ? {} : { toolErrorCode: receipt.observed.toolErrorCode }),
    ...(receipt.observed.controlProof === undefined ? {} : { controlProof: receipt.observed.controlProof }),
  };
  return JSON.stringify({
    producerProtocol: receipt.producerProtocol, producerId: receipt.producerId, invocationId: receipt.invocationId,
    probe: { correlationId: receipt.probe.correlationId, kind: receipt.probe.kind, targetOrCommand: receipt.probe.targetOrCommand },
    denialKind: receipt.denialKind, observed,
    collectorSequence: receipt.collectorSequence, collectedAt: receipt.collectedAt,
  });
}

/** Producer-side sealing helper; the verifier always recomputes this hash. */
export function sealDenialEvidenceReceipt(receipt: Omit<G2DenialEvidenceReceipt, 'receiptHash'>): G2DenialEvidenceReceipt {
  const receiptHash = createHash('sha256').update(canonicalDenialReceiptBytes(receipt)).digest('hex');
  return { ...structuredClone(receipt), receiptHash };
}

/** Per-kind typed-evidence rule. It mirrors the boundary's own corroboration
 * semantics so native acceptance and boundary assessment corroborate identically;
 * shell denials additionally keep the shell status/exit rule everywhere. */
export function denialKindCorroborated(denialKind: G2DenialKind,
  observed: { httpStatus?: number; toolErrorCode?: G2ToolErrorCode; controlProof?: G2ControlProof }): boolean {
  switch (denialKind) {
    case 'filesystem-denied': return observed.toolErrorCode === 'EACCES' || observed.toolErrorCode === 'EPERM';
    case 'not-found': return observed.toolErrorCode === 'ENOENT';
    case 'broker-403': return observed.httpStatus === 403;
    case 'guardian-not-visible': return observed.controlProof?.kind === 'guardian-namespace-absent' && observed.controlProof.verified === true;
    case 'config-inventory-verified': return observed.controlProof?.kind === 'native-inventory-verified' && observed.controlProof.verified === true;
    case 'namespace-denied': return observed.controlProof?.kind === 'namespace-egress-denied' && observed.controlProof.verified === true;
    default: return false;
  }
}

export interface DenialEvidenceInput {
  probe: { correlationId: string; kind: G2ToolKind; targetOrCommand: string };
  event: Pick<NativeToolTraceEvent, 'invocationId' | 'correlationId' | 'kind' | 'targetOrCommand' | 'collectorSequence' | 'at' | 'toolStatus' | 'toolExitCode'> &
    { outcome?: NativeToolTraceEvent['outcome'] };
}

/** Full receipt validation: protocol, hash integrity, invocation/probe/frame/observed
 * joins and per-kind corroboration. Any mismatch is false; it never throws and
 * never derives evidence from the event's own outcome fields. */
export function verifyDenialEvidenceReceipt(receipt: G2DenialEvidenceReceipt, input: DenialEvidenceInput): boolean {
  try {
    if (!receipt || receipt.producerProtocol !== G2_PRODUCER_PROTOCOL_VERSION) return false;
    if (typeof receipt.producerId !== 'string' || !receipt.producerId.trim()) return false;
    const { receiptHash, ...unsealed } = receipt;
    if (!/^[a-f0-9]{64}$/iu.test(receiptHash)) return false;
    if (createHash('sha256').update(canonicalDenialReceiptBytes(unsealed)).digest('hex') !== receiptHash) return false;
    if (!receipt.invocationId || receipt.invocationId !== input.event.invocationId) return false;
    if (receipt.probe.correlationId !== input.probe.correlationId || receipt.probe.kind !== input.probe.kind ||
        receipt.probe.targetOrCommand !== input.probe.targetOrCommand) return false;
    if (receipt.probe.correlationId !== input.event.correlationId || receipt.probe.kind !== input.event.kind ||
        receipt.probe.targetOrCommand !== input.event.targetOrCommand) return false;
    if (!Number.isInteger(receipt.collectorSequence) || receipt.collectorSequence !== input.event.collectorSequence) return false;
    if (receipt.collectedAt !== input.event.at) return false;
    const observed = receipt.observed;
    if (typeof observed.toolStatus !== 'string' || !observed.toolStatus.trim() || observed.toolStatus !== input.event.toolStatus) return false;
    if ((observed.toolExitCode ?? null) !== (input.event.toolExitCode ?? null)) return false;
    const outcome = input.event.outcome;
    if (!outcome || outcome.disposition !== 'denied' || outcome.denialKind !== receipt.denialKind) return false;
    if ((outcome.httpStatus ?? undefined) !== observed.httpStatus || (outcome.toolErrorCode ?? undefined) !== observed.toolErrorCode) return false;
    if (JSON.stringify(outcome.controlProof ?? null) !== JSON.stringify(observed.controlProof ?? null)) return false;
    if (observed.httpStatus !== undefined && (!Number.isInteger(observed.httpStatus) || observed.httpStatus < 100 || observed.httpStatus > 599)) return false;
    if (!denialKindCorroborated(receipt.denialKind, observed)) return false;
    return true;
  } catch { return false; }
}

/** Production G2ControlVerifier over a conductor-supplied receipt set. An empty
 * set verifies nothing; verification is by exact sealed-receipt lookup only. */
export function createTrustedG2ControlVerifier(receipts: readonly G2DenialEvidenceReceipt[]): {
  verifyDenialEvidence(input: DenialEvidenceInput): boolean;
} {
  const sealed = receipts.map((receipt) => structuredClone(receipt));
  return {
    verifyDenialEvidence(input: DenialEvidenceInput): boolean {
      return sealed.some((receipt) => verifyDenialEvidenceReceipt(receipt, input));
    },
  };
}

export interface TrustedDenialApplication {
  toolTrace: NativeToolTraceEvent[];
  appliedCorrelationIds: string[];
  /** Receipts that matched nothing, or failed validation, are listed here. */
  rejectedReceiptHashes: string[];
}

/** Upgrade a decoded result event from `unknown` to a typed denial only when the
 * sealed producer receipt validates against that exact event in its post-upgrade
 * form. Successes are never downgraded, shell status rules are untouched, and
 * rejected or unmatched receipts are reported. */
export function applyTrustedDenialEvidence(toolTrace: readonly NativeToolTraceEvent[],
  receipts: readonly G2DenialEvidenceReceipt[]): TrustedDenialApplication {
  const applied: string[] = [];
  const rejected: string[] = [];
  const trace = toolTrace.map((event) => {
    if (event.phase !== 'result' || event.outcome?.disposition !== 'unknown') return event;
    const receipt = receipts.find((candidate) => candidate.invocationId === event.invocationId &&
      candidate.probe.correlationId === event.correlationId);
    if (!receipt) return event;
    const candidateEvent: NativeToolTraceEvent = {
      ...event,
      outcome: {
        disposition: 'denied' as const, denialKind: receipt.denialKind,
        ...(typeof event.toolExitCode === 'number' ? { exitCode: event.toolExitCode } : {}),
        ...(receipt.observed.httpStatus === undefined ? {} : { httpStatus: receipt.observed.httpStatus }),
        ...(receipt.observed.toolErrorCode === undefined ? {} : { toolErrorCode: receipt.observed.toolErrorCode }),
        ...(receipt.observed.controlProof === undefined ? {} : { controlProof: receipt.observed.controlProof }),
      },
    };
    if (!verifyDenialEvidenceReceipt(receipt, { probe: receipt.probe, event: candidateEvent })) {
      rejected.push(receipt.receiptHash);
      return event;
    }
    applied.push(event.correlationId);
    return candidateEvent;
  });
  for (const receipt of receipts) {
    if (!trace.some((event) => event.phase === 'result' && event.correlationId === receipt.probe.correlationId)) {
      rejected.push(receipt.receiptHash);
    }
  }
  return { toolTrace: trace, appliedCorrelationIds: applied, rejectedReceiptHashes: [...new Set(rejected)] };
}

/** Explicit unavailable receipt for a channel no authenticated producer supports.
 * Unknown is never upgraded by shell substitution or inferred inventory. */
export function explicitG2ChannelUnavailable(kind: G2ToolKind, reason: string): {
  channel: G2ToolKind; qualification: 'unavailable'; reason: string;
} {
  if (!reason.trim()) throw new Error('explicit channel unavailability requires a recorded reason');
  return { channel: kind, qualification: 'unavailable', reason };
}
