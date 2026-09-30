/** Trusted G2 producer receipts and the production denial-evidence authority.
 * Two independent properties are distinguished and never conflated:
 *  - Structural integrity: a receipt's canonical bytes hash to its receiptHash and
 *    its fields join the exact invocation, probe, collector frame and observed
 *    typed evidence. Self-sealing proves integrity only — anyone can seal a
 *    fabricated receipt, so integrity alone is never authentication.
 *  - Provenance: a receipt authenticates only when its producer identity is in a
 *    host-owned admitted-producer registry bound to an authenticated transport
 *    inventory whose admitted channel set is fixed by this module. With the
 *    current known codex exec transport only the shell channel is admissible and
 *    no authentic producer is admitted at all; fabricated receipts and
 *    caller-claimed channel support are refused in production preconditions.
 * A denial disposition never originates from model prose, shell output text, or
 * caller labels. Channels without an admitted producer protocol stay explicitly
 * unavailable.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { G2ControlProof, G2DenialKind, G2ToolErrorCode, G2ToolKind, NativeToolTraceEvent } from './g2-harness.ts';

export const G2_PRODUCER_PROTOCOL_VERSION = 'cq-g2-producer-v1';

/** Module-fixed transport channel ceiling. The known codex exec --json transport
 * documents only `command_execution` (shell) events; no other tool family is
 * inferred from shell use, CLI help, model prose or caller claims. Unknown
 * transports admit nothing. Callers cannot raise this ceiling. */
export function admittedChannelsForTransport(transport: string): readonly G2ToolKind[] {
  return transport === 'codex-exec' ? ['shell'] : [];
}

/** Host-owned authenticated transport inventory. Created only from parent
 * launch-inventory observations (absolute executable path and host-read version);
 * the admitted channel set is always the module-fixed ceiling for the transport,
 * never a caller-supplied list. */
export interface AuthenticatedG2TransportInventory {
  /** sha256 over canonicalTransportInventoryBytes of the fields below. */
  inventoryId: string;
  transport: 'codex-exec';
  /** Absolute host path observed by the parent launch inventory. */
  resolvedExecutable: string;
  executableVersion: string | null;
  /** Module-fixed admitted channels; not caller-selectable. */
  admittedChannels: readonly G2ToolKind[];
  observedAt: string;
}

export function canonicalTransportInventoryBytes(inventory: Omit<AuthenticatedG2TransportInventory, 'inventoryId'>): string {
  return JSON.stringify({
    transport: inventory.transport,
    resolvedExecutable: inventory.resolvedExecutable,
    executableVersion: inventory.executableVersion,
    admittedChannels: [...inventory.admittedChannels],
    observedAt: inventory.observedAt,
  });
}

/** Bind a transport inventory to this host. The executable path must be absolute
 * and must exist as a regular file at creation time; the channel set is the
 * module-fixed ceiling. */
export function createAuthenticatedTransportInventory(input: {
  transport: 'codex-exec';
  resolvedExecutable: string;
  executableVersion?: string | null;
  observedAt?: string;
}): AuthenticatedG2TransportInventory {
  if (input.transport !== 'codex-exec') throw new Error('unsupported G2 transport inventory');
  if (!isAbsolute(input.resolvedExecutable)) throw new Error('transport inventory requires an absolute host executable path');
  let executable: ReturnType<typeof statSync>;
  try { executable = statSync(input.resolvedExecutable); } catch {
    throw new Error('transport inventory executable does not exist on this host');
  }
  if (!executable.isFile()) throw new Error('transport inventory executable is not a regular host file');
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('transport inventory requires a parseable observation timestamp');
  const unsealed = {
    transport: input.transport,
    resolvedExecutable: input.resolvedExecutable,
    executableVersion: input.executableVersion ?? null,
    admittedChannels: admittedChannelsForTransport(input.transport),
    observedAt,
  };
  return Object.freeze({
    ...unsealed,
    admittedChannels: Object.freeze([...unsealed.admittedChannels]),
    inventoryId: createHash('sha256').update(canonicalTransportInventoryBytes(unsealed)).digest('hex'),
  });
}

/** Recompute the inventory digest and re-check the host binding. A tampered
 * channel list, altered path/version or vanished executable never verifies. */
export function verifyTransportInventoryIntegrity(inventory: AuthenticatedG2TransportInventory): boolean {
  try {
    if (!inventory || inventory.transport !== 'codex-exec') return false;
    const { inventoryId, ...fields } = inventory;
    if (typeof inventoryId !== 'string' || !/^[a-f0-9]{64}$/iu.test(inventoryId)) return false;
    if (createHash('sha256').update(canonicalTransportInventoryBytes(fields)).digest('hex') !== inventoryId) return false;
    const ceiling = admittedChannelsForTransport(fields.transport);
    if (fields.admittedChannels.length !== ceiling.length || !ceiling.every((channel) => fields.admittedChannels.includes(channel))) return false;
    if (!isAbsolute(fields.resolvedExecutable) || !statSync(fields.resolvedExecutable).isFile()) return false;
    return Number.isFinite(Date.parse(fields.observedAt));
  } catch { return false; }
}

/** Private producer-side receipt sealed by the trusted native instrumentation.
 * The conductor admits the producer identities; sealing proves structural
 * integrity only — provenance requires registry admission. This module never
 * mints evidence. */
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

/** Producer-side sealing helper; the verifier always recomputes this hash.
 * Sealing is structural integrity only and never authenticates the producer. */
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

/** Structural receipt validation: protocol, hash integrity, invocation/probe/
 * frame/observed joins and per-kind corroboration. Any mismatch is false; it
 * never throws and never derives evidence from the event's own outcome fields.
 * Passing this says the receipt is internally consistent ONLY — it says nothing
 * about who produced it. */
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

/** Explicit producer admission. Admission is an act of the conductor/parent:
 * each producer is bound to one known transport and a channel set that can never
 * exceed the module-fixed transport ceiling. Invalid admission throws. */
export interface AdmittedG2Producer {
  producerId: string;
  transport: 'codex-exec';
  channels: readonly G2ToolKind[];
}
export interface G2ProducerRegistry {
  readonly transport: 'codex-exec';
  readonly producers: readonly AdmittedG2Producer[];
  admits(producerId: string, channel: G2ToolKind): boolean;
}
export function admitG2Producers(producers: readonly AdmittedG2Producer[]): G2ProducerRegistry {
  const admitted: AdmittedG2Producer[] = [];
  let transport: 'codex-exec' | undefined;
  for (const producer of producers ?? []) {
    if (!producer || typeof producer.producerId !== 'string' || !producer.producerId.trim()) {
      throw new Error('producer admission requires a nonempty producer identity');
    }
    if (admitted.some((existing) => existing.producerId === producer.producerId)) {
      throw new Error(`producer '${producer.producerId}' is admitted more than once`);
    }
    transport ??= producer.transport;
    if (producer.transport !== transport || producer.transport !== 'codex-exec') {
      throw new Error('producer admission must bind one known transport');
    }
    const ceiling = admittedChannelsForTransport(producer.transport);
    const channels = [...new Set(producer.channels ?? [])];
    if (channels.length === 0 || !channels.every((channel) => ceiling.includes(channel))) {
      throw new Error(`producer '${producer.producerId}' cannot be admitted beyond the fixed '${producer.transport}' channel ceiling`);
    }
    admitted.push(Object.freeze({ producerId: producer.producerId, transport: producer.transport, channels: Object.freeze(channels) }));
  }
  const registry: G2ProducerRegistry = {
    transport: transport ?? 'codex-exec',
    producers: Object.freeze(admitted),
    admits(producerId: string, channel: G2ToolKind): boolean {
      return admitted.some((producer) => producer.producerId === producerId && producer.channels.includes(channel));
    },
  };
  return Object.freeze(registry);
}

/** Provenance authority binding an admitted-producer registry to an
 * authenticated transport inventory of the same transport. */
export interface G2ProducerAuthority {
  registry: G2ProducerRegistry;
  inventory: AuthenticatedG2TransportInventory;
}

/** Provenance check: the inventory must still verify on this host, and the
 * registry must belong to the inventory's transport and admit this producer for
 * the receipt's exact channel. Self-sealed receipts from unadmitted producers
 * never authenticate. */
export function producerProvenanceVerified(receipt: G2DenialEvidenceReceipt, authority: G2ProducerAuthority): boolean {
  try {
    if (!verifyTransportInventoryIntegrity(authority.inventory)) return false;
    if (authority.registry.transport !== authority.inventory.transport) return false;
    return authority.registry.admits(receipt.producerId, receipt.probe.kind);
  } catch { return false; }
}

function buildTrustedVerifier(receipts: readonly G2DenialEvidenceReceipt[], authority?: G2ProducerAuthority):
  { verifyDenialEvidence(input: DenialEvidenceInput): boolean } {
  const sealed = receipts.map((receipt) => structuredClone(receipt));
  if (authority) {
    if (!verifyTransportInventoryIntegrity(authority.inventory) || authority.registry.transport !== authority.inventory.transport) {
      throw new Error('producer authority does not match an authenticated transport inventory');
    }
    return {
      verifyDenialEvidence(input: DenialEvidenceInput): boolean {
        return sealed.some((receipt) =>
          verifyDenialEvidenceReceipt(receipt, input) && producerProvenanceVerified(receipt, authority));
      },
    };
  }
  // Development-only form: structural integrity without provenance. Production
  // preconditions refuse unadmitted receipts; this form never runs there.
  return {
    verifyDenialEvidence(input: DenialEvidenceInput): boolean {
      return sealed.some((receipt) => verifyDenialEvidenceReceipt(receipt, input));
    },
  };
}

/** Production G2ControlVerifier over a conductor-supplied receipt set. With a
 * producer authority, receipts authenticate only through registry admission
 * bound to the authenticated inventory; without one, verification stays
 * structural (development only). An empty set verifies nothing. */
export function createTrustedG2ControlVerifier(receipts: readonly G2DenialEvidenceReceipt[], authority?: G2ProducerAuthority):
  { verifyDenialEvidence(input: DenialEvidenceInput): boolean } {
  return buildTrustedVerifier(receipts, authority);
}

export interface TrustedDenialApplication {
  toolTrace: NativeToolTraceEvent[];
  appliedCorrelationIds: string[];
  /** Receipts that matched nothing, failed validation, or lack admitted
   * provenance under a supplied authority are listed here. */
  rejectedReceiptHashes: string[];
}

/** Upgrade a decoded result event from `unknown` to a typed denial only when the
 * sealed producer receipt validates against that exact event in its post-upgrade
 * form and — under a supplied authority — carries admitted provenance. Successes
 * are never downgraded, shell status rules are untouched, and rejected or
 * unmatched receipts are reported. */
export function applyTrustedDenialEvidence(toolTrace: readonly NativeToolTraceEvent[],
  receipts: readonly G2DenialEvidenceReceipt[], authority?: G2ProducerAuthority): TrustedDenialApplication {
  const applied: string[] = [];
  const rejected: string[] = [];
  const trace = toolTrace.map((event) => {
    if (event.phase !== 'result' || event.outcome?.disposition !== 'unknown') return event;
    const receipt = receipts.find((candidate) => candidate.invocationId === event.invocationId &&
      candidate.probe.correlationId === event.correlationId);
    if (!receipt) return event;
    if (authority && !producerProvenanceVerified(receipt, authority)) {
      rejected.push(receipt.receiptHash);
      return event;
    }
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

/** Explicit unavailable receipt for a channel no admitted producer supports.
 * Unknown is never upgraded by shell substitution or inferred inventory. */
export function explicitG2ChannelUnavailable(kind: G2ToolKind, reason: string): {
  channel: G2ToolKind; qualification: 'unavailable'; reason: string;
} {
  if (!reason.trim()) throw new Error('explicit channel unavailability requires a recorded reason');
  return { channel: kind, qualification: 'unavailable', reason };
}
