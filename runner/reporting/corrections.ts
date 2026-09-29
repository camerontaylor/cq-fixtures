// PK14 / D22: typed correction records and DETERMINISTIC correction selection.
//
// Original reports are immutable. A correction is a separate, hash-bound
// record that names the original artifact it speaks about and the exact
// predecessor records it supersedes. Selection is a PURE READ: it never edits,
// normalizes in place or rewrites any original document, and it never
// reconstructs evidence that was lost.
//
// Resolution order is explicit supersession, not chronology. The canonical
// record hash is a record's IDENTITY, not a recency signal; `recordedAt`
// orders DISPLAY only and may be null for legacy records, which is never
// replaced with a synthesized timestamp. Equal or unknown timestamps must not
// silently break a substantive conflict.

import { createHash } from 'node:crypto';
import type { ArtifactBinding, Disposition, SelectionStatus } from './types.ts';

export const CORRECTION_SCHEMA_VERSION = 1;

/** Correction kinds this build recognizes. An unknown kind is unresolved. */
export const KNOWN_CORRECTION_KINDS = [
  'append-only-lifecycle-correction',
  'retention-binding',
  'g1-contract-audit',
] as const;
export type CorrectionKind = (typeof KNOWN_CORRECTION_KINDS)[number];

/**
 * Field paths a lifecycle correction may override. Allowlisted, so a
 * correction can retract a lifecycle projection and cannot smuggle in an
 * unrelated field.
 */
export const LIFECYCLE_OVERRIDABLE_FIELDS: readonly string[] = [
  'execution.terminalCause',
  'execution.authoritativeNativeTerminal',
  'operationalStatus',
  'normalWorkerCompletion',
  'assignmentDeadlineCrossed',
  'processTreeStopped',
  'boundaryTermination',
  'boundaryExport',
  'exportReceiptPresent',
  // The table rate is a DERIVED projection. It is overridable only with a value
  // recomputed from corrected rows and a qualified denominator; a literal
  // historic rate is never carried across.
  'table.operationalCompletionRate',
];

/**
 * Fields NO correction may override. Candidate correctness, format
 * conformance, strategy success and the recorded score are the observed
 * outcome of judging immutable candidate bytes. A timeout correction that
 * changes "correct" to "incorrect" (or the reverse) is a category error and is
 * rejected rather than applied.
 */
export const PROTECTED_CORRECTNESS_FIELDS: readonly string[] = [
  'taskResult.candidateCorrectness',
  'taskResult.formatConformance',
  'taskResult.assignedStrategySuccess',
  'taskResult.score',
  'judgement.id',
  'judgement.pin',
  'judgement.candidatePatchSha256',
];

/**
 * Fields that assert normal completion. A correction record may RETRACT such a
 * claim (to a stopped/timeout/budget cause) but may not assert it; that keeps
 * "authoritative native terminal = timeout" from becoming "the run completed".
 */
export const COMPLETION_CLAIM_FIELDS: readonly string[] = [
  'execution.terminalCause',
  'operationalStatus',
  'normalWorkerCompletion',
];
export const COMPLETION_CLAIM_VALUES: readonly string[] = ['complete', 'completed', 'success', 'succeeded'];

/** Exact identity of the run a correction speaks about. */
export interface CorrectionIdentity {
  runId: string;
  /** null only when genuinely unrecorded; never invented. */
  assignmentId: string | null;
  /** null only when genuinely unrecorded; never invented. */
  invocationId: string | null;
}

/** One allowlisted field path plus its typed value. */
export interface CorrectionOverride {
  field: string;
  value: unknown;
}

/** An immutable, hash-bound, append-only correction record. */
export interface CorrectionRecord {
  schemaVersion: number;
  kind: string;
  /** Explicit approved authority identity; an unknown authority is unresolved. */
  authorityId: string;
  identity: CorrectionIdentity;
  /** Authentic RFC3339 timestamp or null. Never synthesized for legacy records. */
  recordedAt: string | null;
  /** Named original artifact references with their exact original SHA256. */
  sourceEvidence: Record<string, ArtifactBinding>;
  /** Canonical record hashes of the predecessors this record supersedes. */
  supersedes: string[];
  overrides: CorrectionOverride[];
  /**
   * Canonical record hash, i.e. the record's identity. For an adapted legacy
   * record it is derived (see `canonicalRecordHash`); a record that declares
   * one must match its own derived value.
   */
  recordSha256: string;
  /** The record document itself, as read. Never mutated by this module. */
  readonly raw: unknown;
}

/** Deterministic JSON: object keys sorted, no incidental whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The record's canonical identity hash, excluding the hash field itself. */
export function canonicalRecordHash(raw: unknown): string {
  const withoutHash =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k !== 'recordSha256'))
      : raw;
  return sha256Hex(canonicalJson(withoutHash));
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Adapt a raw record document into a typed `CorrectionRecord`.
 *
 * Returns the record plus the reason it was rejected when the document is not
 * a well-formed record. Rejection is fail-closed: a malformed record never
 * becomes a usable override.
 */
export function adaptCorrectionRecord(
  raw: unknown,
  options: { authorityId?: string; recordedAt?: string | null; canonicalId?: string } = {},
): { record: CorrectionRecord | null; rejection: Disposition | null } {
  const reject = (reason: Disposition['reason'], detail: string): { record: null; rejection: Disposition } => ({
    record: null,
    rejection: { status: 'rejected', reason, detail },
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject('scope-mismatch', 'record is not an object document');
  const doc = raw as Record<string, unknown>;

  const schemaVersion = doc.schemaVersion;
  if (schemaVersion !== CORRECTION_SCHEMA_VERSION) {
    return reject('scope-mismatch', `unsupported schemaVersion ${String(schemaVersion)}`);
  }
  const kind = doc.kind;
  if (typeof kind !== 'string' || !(KNOWN_CORRECTION_KINDS as readonly string[]).includes(kind)) {
    return reject('scope-mismatch', `unrecognized correction kind ${String(kind)}`);
  }
  const runId = asNullableString(doc.runId ?? (doc.identity as Record<string, unknown> | undefined)?.runId);
  if (!runId) return reject('scope-mismatch', 'record has no runId');
  const identityDoc = (doc.identity ?? doc) as Record<string, unknown>;
  const authorityId = options.authorityId ?? asNullableString(doc.authorityId);
  if (!authorityId) return reject('authority-unapproved', 'record has no explicit authorityId');

  // recordedAt: authentic or null. A pinned manifest may adapt a legacy record
  // that carries no timestamp, but it may not invent one.
  let recordedAt: string | null = null;
  if (typeof doc.recordedAt === 'string') {
    if (!RFC3339.test(doc.recordedAt)) return reject('scope-mismatch', `recordedAt is not RFC3339: ${doc.recordedAt}`);
    recordedAt = doc.recordedAt;
  } else if (options.recordedAt !== undefined && options.recordedAt !== null) {
    if (!RFC3339.test(options.recordedAt)) return reject('scope-mismatch', `pinned recordedAt is not RFC3339: ${options.recordedAt}`);
    recordedAt = options.recordedAt;
  }

  const sourceEvidenceRaw = (doc.sourceEvidence ?? {}) as Record<string, unknown>;
  const sourceEvidence: Record<string, ArtifactBinding> = {};
  for (const [name, value] of Object.entries(sourceEvidenceRaw)) {
    const ref = value as Record<string, unknown> | null;
    // Legacy records name their evidence as a bare hash; both shapes are read
    // and neither is rewritten in the original document.
    if (typeof value === 'string' && isSha256(value)) sourceEvidence[name] = { path: name, sha256: value };
    else if (ref && typeof ref === 'object' && isSha256(ref.sha256)) {
      sourceEvidence[name] = { path: asNullableString(ref.path) ?? name, sha256: ref.sha256 };
    } else return reject('artifact-binding-unresolved', `sourceEvidence.${name} is not a hash-bound reference`);
  }

  const supersedes = Array.isArray(doc.supersedes) ? doc.supersedes : [];
  if (!supersedes.every(isSha256)) return reject('scope-mismatch', 'supersedes must be a list of canonical record hashes');

  const overridesRaw = Array.isArray(doc.overrides) ? doc.overrides : [];
  const overrides: CorrectionOverride[] = [];
  for (const entry of overridesRaw) {
    const o = entry as Record<string, unknown>;
    if (!o || typeof o.field !== 'string' || o.field.length === 0) {
      return reject('disallowed-field', 'override has no field path');
    }
    if (!('value' in o)) return reject('disallowed-field', `override for ${o.field} has no value`);
    overrides.push({ field: o.field, value: o.value });
  }

  const derived = canonicalRecordHash(doc);
  const declared = doc.recordSha256;
  if (declared !== undefined && (!isSha256(declared) || declared !== derived)) {
    return reject('artifact-binding-mismatch', `declared recordSha256 does not match canonical hash ${derived}`);
  }
  const recordSha256 = options.canonicalId ?? derived;
  if (!isSha256(recordSha256)) return reject('scope-mismatch', 'canonicalId is not a sha256');

  return {
    record: {
      schemaVersion: CORRECTION_SCHEMA_VERSION,
      kind,
      authorityId,
      identity: {
        runId,
        assignmentId: asNullableString(identityDoc.assignmentId),
        invocationId: asNullableString(identityDoc.invocationId),
      },
      recordedAt,
      sourceEvidence,
      supersedes: [...supersedes],
      overrides,
      recordSha256,
      raw: doc,
    },
    rejection: null,
  };
}

/** One resolved value in the derived projection. */
export interface ProjectedField {
  /** 'original' = untouched original; 'correction' = qualified override applied. */
  origin: 'original' | 'correction';
  value: unknown;
  /** Canonical record hash that supplied the value, or null for the original. */
  recordSha256: string | null;
  recordedAt: string | null;
}

/** A known-applicable correction whose value is deliberately NOT emitted. */
export interface WithheldField {
  field: string;
  reason: Disposition['reason'];
  detail: string;
  recordSha256: string | null;
}

export interface RecordProvenance {
  recordSha256: string;
  kind: string;
  authorityId: string;
  recordedAt: string | null;
  disposition: Disposition;
  /** True when the record was selected as the winner for at least one field. */
  selected: boolean;
}

export interface SelectionResult {
  status: SelectionStatus;
  runId: string;
  /**
   * Separate derived view. It RETAINS the original fields verbatim and adds
   * the selected correction annotations; it is never the original document.
   */
  projection: Record<string, ProjectedField>;
  /** Affected claims that are known but deliberately not asserted. */
  withheld: WithheldField[];
  provenance: RecordProvenance[];
  /** Original document hash, recorded so a consumer can prove immutability. */
  originalRef: ArtifactBinding | null;
}

export interface SelectOptions {
  runId: string;
  /** The original immutable values, as published. Never modified. */
  original: Record<string, unknown>;
  /** Hash-bound reference to the original report, for provenance. */
  originalRef?: ArtifactBinding;
  records: CorrectionRecord[];
  /** Authority identities approved to issue corrections. Unknown => unresolved. */
  approvedAuthorities: readonly string[];
  /**
   * Optional per-record verdict from correction-binding.ts. A record whose
   * binding is not 'verified' is applicable but UNRESOLVED: the derived claim
   * is withheld, and the original value is never used as a silent fallback.
   */
  bindingStatus?: (record: CorrectionRecord) => Disposition | undefined;
}

function scopeMatches(record: CorrectionRecord, runId: string): boolean {
  return record.identity.runId === runId;
}

/** Does `winner` transitively supersede `other`? */
function supersedesTransitively(
  winner: CorrectionRecord,
  other: CorrectionRecord,
  byId: Map<string, CorrectionRecord>,
): boolean {
  const seen = new Set<string>();
  const stack = [...winner.supersedes];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === other.recordSha256) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const next = byId.get(id);
    if (next) stack.push(...next.supersedes);
  }
  return false;
}

function hasCycle(records: CorrectionRecord[]): boolean {
  const byId = new Map(records.map((r) => [r.recordSha256, r]));
  const state = new Map<string, 0 | 1 | 2>();
  for (const start of records) {
    if (state.get(start.recordSha256) === 2) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start.recordSha256, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const current = state.get(frame.id) ?? 0;
      if (current === 0) state.set(frame.id, 1);
      const record = byId.get(frame.id);
      const edges = record ? record.supersedes.filter((id) => byId.has(id)) : [];
      if (frame.next < edges.length) {
        const nextId = edges[frame.next];
        frame.next += 1;
        const nextState = state.get(nextId) ?? 0;
        if (nextState === 1) return true;
        if (nextState === 0) stack.push({ id: nextId, next: 0 });
      } else {
        state.set(frame.id, 2);
        stack.pop();
      }
    }
  }
  return false;
}

/** Reject an override whose field is protected, unallowlisted or over-claiming. */
export function checkOverrideAllowed(record: CorrectionRecord, override: CorrectionOverride): Disposition | null {
  if (PROTECTED_CORRECTNESS_FIELDS.includes(override.field)) {
    return {
      status: 'rejected',
      reason: 'protected-correctness-field',
      detail: `${record.kind} may not override ${override.field}; judged candidate bytes are immutable`,
    };
  }
  if (!LIFECYCLE_OVERRIDABLE_FIELDS.includes(override.field)) {
    return { status: 'rejected', reason: 'disallowed-field', detail: `${override.field} is not allowlisted for ${record.kind}` };
  }
  if (COMPLETION_CLAIM_FIELDS.includes(override.field) && typeof override.value === 'string' && COMPLETION_CLAIM_VALUES.includes(override.value)) {
    return {
      status: 'rejected',
      reason: 'completion-claim-not-retractable',
      detail: `a correction may retract ${override.field} but may not assert normal completion`,
    };
  }
  if (override.field === 'normalWorkerCompletion' && override.value !== false) {
    return {
      status: 'rejected',
      reason: 'completion-claim-not-retractable',
      detail: 'normalWorkerCompletion may only be retracted to false, never asserted true',
    };
  }
  return null;
}

/** Explicit version of the legacy-record normalization adapter below. */
export const LIFECYCLE_ADAPTER_VERSION = 'append-only-lifecycle-correction/overrides/v1';

export interface DerivedLifecycleOverrides {
  /** Explicit version, recorded in provenance so an adapter is never anonymous. */
  adapterVersion: string;
  /** SHA256 of the original record document the overrides were derived from. */
  originalRecordSha256: string;
  overrides: CorrectionOverride[];
  /**
   * Fields a wired row consumer must decide for itself, with the reason. Kept
   * visible so a missing mapping is a reported gap, not a silent default.
   */
  unmapped: Array<{ field: string; reason: string }>;
}

export interface DeriveLifecycleOptions {
  /**
   * Schema-representable value for `execution.terminalCause`. Required when the
   * authoritative native terminal has no matching pinned enum value, because the
   * sidecar does not invent a lifecycle label: it records 'unknown' and keeps
   * the authoritative string verbatim in `execution.authoritativeNativeTerminal`.
   */
  terminalCause: string;
  /**
   * Schema-representable value for `operationalStatus`, from the pinned enum.
   * Must not be a normal-completion value.
   */
  operationalStatus: string;
  /**
   * Rows for the affected table AFTER the operationalStatus override has been
   * applied. The completion rate is recomputed from these; a literal historic
   * table rate is never transplanted. Omit to decline emitting the rate.
   */
  completionRows?: ReadonlyArray<{ operationalStatus: string }>;
}

/**
 * Recompute an operational completion rate from corrected rows.
 *
 * Mirrors the aggregate lane's rule: a row counts as an operational completion
 * when its status is 'complete' or 'measured-failure'. An empty denominator is
 * 0 (an observed zero, not a missing value).
 */
export function recomputeCompletionRate(rows: ReadonlyArray<{ operationalStatus: string }>): number {
  if (rows.length === 0) return 0;
  const completions = rows.filter((row) => row.operationalStatus === 'complete' || row.operationalStatus === 'measured-failure').length;
  return completions / rows.length;
}

/**
 * Normalize a legacy append-only lifecycle correction into typed overrides.
 *
 * The original document is read and never rewritten: the adapter produces a
 * separate, versioned override list, and the record's own bytes stay exactly as
 * they were appended.
 */
export function deriveLifecycleOverrides(
  doc: unknown,
  originalRecordSha256: string,
  options: DeriveLifecycleOptions,
): DerivedLifecycleOverrides {
  const source = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const authoritative = typeof source.authoritativeNativeTerminal === 'string' ? source.authoritativeNativeTerminal : null;
  const superseded = Array.isArray(source.supersededLifecycleProjections) ? (source.supersededLifecycleProjections as unknown[]) : [];
  const overrides: CorrectionOverride[] = [];
  const unmapped: Array<{ field: string; reason: string }> = [];

  for (const entry of superseded) {
    if (typeof entry !== 'string') continue;
    const [field] = entry.split('=');
    if (field === 'execution.terminalCause') {
      if (authoritative !== null) {
        // The authoritative string is preserved verbatim beside the mapped value.
        overrides.push({ field: 'execution.authoritativeNativeTerminal', value: authoritative });
        overrides.push({ field: 'execution.terminalCause', value: options.terminalCause });
      } else {
        unmapped.push({ field, reason: 'record asserts no authoritativeNativeTerminal' });
      }
    } else if (field === 'operationalStatus') {
      if (options.operationalStatus === 'complete') {
        unmapped.push({ field, reason: 'a lifecycle correction may not assert normal completion' });
      } else {
        overrides.push({ field: 'operationalStatus', value: options.operationalStatus });
      }
    } else if (field === 'table.operationalCompletionRate') {
      if (options.completionRows) {
        overrides.push({ field: 'table.operationalCompletionRate', value: recomputeCompletionRate(options.completionRows) });
      } else {
        unmapped.push({
          field,
          reason: 'a derived table rate must be recomputed from corrected rows and a qualified denominator; the historic literal is not transplanted',
        });
      }
    } else {
      unmapped.push({ field, reason: 'no adapter mapping for this superseded projection' });
    }
  }

  if (source.normalWorkerCompletion === false) {
    overrides.push({ field: 'normalWorkerCompletion', value: false });
  }
  for (const booleanField of ['assignmentDeadlineCrossed', 'processTreeStopped', 'exportReceiptPresent'] as const) {
    if (typeof source[booleanField] === 'boolean') overrides.push({ field: booleanField, value: source[booleanField] });
  }
  for (const stringField of ['boundaryTermination', 'boundaryExport'] as const) {
    if (typeof source[stringField] === 'string') overrides.push({ field: stringField, value: source[stringField] });
  }

  return { adapterVersion: LIFECYCLE_ADAPTER_VERSION, originalRecordSha256, overrides, unmapped };
}

/** Display order: recordedAt ascending, nulls last, then canonical hash. Display only. */
function displayOrder(records: CorrectionRecord[]): CorrectionRecord[] {
  return [...records].sort((a, b) => {
    if (a.recordedAt !== b.recordedAt) {
      if (a.recordedAt === null) return 1;
      if (b.recordedAt === null) return -1;
      return a.recordedAt < b.recordedAt ? -1 : 1;
    }
    return a.recordSha256 < b.recordSha256 ? -1 : a.recordSha256 > b.recordSha256 ? 1 : 0;
  });
}

/**
 * Select the corrections that apply to one run and build the derived
 * projection. Pure, deterministic and side-effect free: the original record is
 * only read, and its bytes are never rewritten.
 *
 * Fail-closed conditions, each of which withholds the affected derived claim
 * instead of falling back to a retracted original value: unapproved authority,
 * unverified artifact binding, duplicate conflicting records, a supersession
 * cycle, and competing unrelated successors.
 */
export function selectCorrections(options: SelectOptions): SelectionResult {
  const { runId, original, originalRef = null, records, approvedAuthorities } = options;
  const provenance: RecordProvenance[] = [];
  const withheld: WithheldField[] = [];

  const scoped = records.filter((record) => scopeMatches(record, runId));
  const outOfScope = records.filter((record) => !scopeMatches(record, runId));
  for (const record of outOfScope) {
    provenance.push({
      recordSha256: record.recordSha256,
      kind: record.kind,
      authorityId: record.authorityId,
      recordedAt: record.recordedAt,
      disposition: { status: 'rejected', reason: 'scope-mismatch', detail: `record is for run ${record.identity.runId}` },
      selected: false,
    });
  }

  // Duplicates: the same canonical record supplied twice is ONE record, and
  // supplying it twice is not a conflict. Two DIFFERENT records that disagree
  // are a conflict, and are resolved by explicit supersession or fail closed.
  const counts = new Map<string, number>();
  for (const record of scoped) counts.set(record.recordSha256, (counts.get(record.recordSha256) ?? 0) + 1);
  const byHash = new Map<string, CorrectionRecord>();
  for (const record of scoped) if (!byHash.has(record.recordSha256)) byHash.set(record.recordSha256, record);
  const uniqueScoped = [...byHash.values()];

  const byId = new Map(uniqueScoped.map((r) => [r.recordSha256, r]));
  const cycle = uniqueScoped.length > 0 && hasCycle(uniqueScoped);

  // Per-record admissibility, computed once. Authority and binding problems
  // are record-wide; a rejected override is scoped to its own field. An
  // inadmissible record is still APPLICABLE to its fields when the problem is
  // authority or binding: the claim is then withheld, never silently reverted
  // to the original.
  const admissible = new Map<string, { recordOk: boolean; ok: boolean; disposition: Disposition; rejectedFields: Map<string, Disposition> }>();
  for (const record of uniqueScoped) {
    const rejectedFields = new Map<string, Disposition>();
    for (const override of record.overrides) {
      const problem = checkOverrideAllowed(record, override);
      if (problem) rejectedFields.set(override.field, problem);
    }
    let recordOk = true;
    let disposition: Disposition = { status: 'accepted', reason: 'selected-correction', detail: 'record is applicable' };
    if (!approvedAuthorities.includes(record.authorityId)) {
      recordOk = false;
      disposition = { status: 'unresolved', reason: 'authority-unapproved', detail: `authority ${record.authorityId} is not approved` };
    } else {
      const binding = options.bindingStatus?.(record);
      if (binding && binding.status !== 'accepted') {
        recordOk = false;
        disposition = binding;
      }
    }
    admissible.set(record.recordSha256, {
      recordOk,
      ok: recordOk && rejectedFields.size === 0,
      disposition: recordOk && rejectedFields.size > 0
        ? { status: 'rejected', reason: 'disallowed-field', detail: `${rejectedFields.size} override(s) rejected` }
        : disposition,
      rejectedFields,
    });
  }

  // Fields: original plus every field any scoped record speaks about.
  const fields = new Set<string>(Object.keys(original));
  for (const record of scoped) for (const override of record.overrides) fields.add(override.field);

  const projection: Record<string, ProjectedField> = {};
  const winners = new Set<string>();
  let status: SelectionStatus = 'none';
  const escalate = (next: SelectionStatus): void => {
    const rank: Record<SelectionStatus, number> = { none: 0, selected: 1, unresolved: 2, conflict: 3 };
    if (rank[next] > rank[status]) status = next;
  };

  for (const field of [...fields].sort()) {
    const speakers = uniqueScoped.filter((r) => r.overrides.some((o) => o.field === field));
    if (speakers.length === 0) {
      if (field in original) {
        projection[field] = { origin: 'original', value: original[field], recordSha256: null, recordedAt: null };
      }
      continue;
    }

    if (cycle) {
      withheld.push({ field, reason: 'supersession-cycle', detail: 'supersession graph among applicable records contains a cycle', recordSha256: null });
      escalate('conflict');
      continue;
    }

    // Admissibility is per FIELD, not per record: a rejected override on one
    // field must not silently disqualify the record's other, well-formed
    // overrides. Authority and binding problems remain record-wide.
    const qualified = speakers.filter((r) => {
      const info = admissible.get(r.recordSha256)!;
      return info.recordOk && !info.rejectedFields.has(field);
    });
    if (qualified.length === 0) {
      // Known applicable, but no qualified record supplies the value.
      for (const record of displayOrder(speakers)) {
        const info = admissible.get(record.recordSha256)!;
        const perField = info.rejectedFields.get(field);
        withheld.push({
          field,
          reason: perField?.reason ?? info.disposition.reason,
          detail: perField?.detail ?? info.disposition.detail ?? 'no qualified correction supplies this field',
          recordSha256: record.recordSha256,
        });
      }
      escalate('unresolved');
      continue;
    }

    // Explicit supersession decides. A record that transitively supersedes
    // every other speaker wins; more than one such head is a conflict.
    const heads = qualified.filter((candidate) => !qualified.some((other) => other.recordSha256 !== candidate.recordSha256 && supersedesTransitively(other, candidate, byId)));
    const losers = qualified.filter((r) => !heads.includes(r));
    for (const loser of losers) {
      provenance.push({
        recordSha256: loser.recordSha256,
        kind: loser.kind,
        authorityId: loser.authorityId,
        recordedAt: loser.recordedAt,
        disposition: { status: 'superseded', reason: 'superseded-by-successor', detail: `superseded for ${field}` },
        selected: false,
      });
    }

    if (heads.length > 1) {
      for (const head of displayOrder(heads)) {
        withheld.push({ field, reason: 'conflicting-successors', detail: 'two applicable records supersede each other neither', recordSha256: head.recordSha256 });
      }
      escalate('conflict');
      continue;
    }

    const winner = heads[0];
    const override = winner.overrides.find((o) => o.field === field)!;
    projection[field] = {
      origin: 'correction',
      value: override.value,
      recordSha256: winner.recordSha256,
      recordedAt: winner.recordedAt,
    };
    winners.add(winner.recordSha256);
    escalate('selected');

    // A qualified winner does not silence a sibling that is applicable to the
    // same field but unresolved: the unresolved record still withholds nothing
    // here (it is superseded), but its disposition is recorded.
    for (const other of speakers) {
      if (other.recordSha256 === winner.recordSha256) continue;
      const info = admissible.get(other.recordSha256)!;
      if (info.recordOk && !info.rejectedFields.has(field)) continue;
      provenance.push({
        recordSha256: other.recordSha256,
        kind: other.kind,
        authorityId: other.authorityId,
        recordedAt: other.recordedAt,
        disposition: info.disposition,
        selected: false,
      });
    }
  }

  for (const record of displayOrder(uniqueScoped)) {
    if (winners.has(record.recordSha256)) continue;
    if (provenance.some((p) => p.recordSha256 === record.recordSha256)) continue;
    const info = admissible.get(record.recordSha256)!;
    const supplied = counts.get(record.recordSha256)!;
    provenance.push({
      recordSha256: record.recordSha256,
      kind: record.kind,
      authorityId: record.authorityId,
      recordedAt: record.recordedAt,
      disposition:
        supplied > 1
          ? { status: info.disposition.status, reason: info.disposition.reason, detail: `${info.disposition.detail ?? 'record applicable'}; supplied ${supplied} times as the same canonical record and de-duplicated` }
          : info.disposition,
      selected: false,
    });
  }

  for (const record of displayOrder(uniqueScoped)) {
    if (winners.has(record.recordSha256)) {
      provenance.push({
        recordSha256: record.recordSha256,
        kind: record.kind,
        authorityId: record.authorityId,
        recordedAt: record.recordedAt,
        disposition: { status: 'accepted', reason: 'selected-correction', detail: 'selected for at least one field' },
        selected: true,
      });
    }
  }

  provenance.sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    if (a.recordedAt !== b.recordedAt) {
      if (a.recordedAt === null) return 1;
      if (b.recordedAt === null) return -1;
      return a.recordedAt < b.recordedAt ? -1 : 1;
    }
    return a.recordSha256 < b.recordSha256 ? -1 : a.recordSha256 > b.recordSha256 ? 1 : 0;
  });

  return { status, runId, projection, withheld, provenance, originalRef };
}
