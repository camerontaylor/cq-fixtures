// PK14 / D22 + D77: the CONSUMER. This is where correction selection stops
// being a sidecar and becomes report input.
//
// The selection primitives in corrections.ts answer "which record speaks, and
// is it qualified?". This module answers the report's question: "given the
// live raw rows and the historic published projection, what does the report
// now say, and what may it NOT say?". It is deliberately the only place where
// a qualified correction becomes an emitted value, so the fail-closed rules
// have exactly one enforcement point:
//
//   1. A pinned record is loaded only if its supplied BYTES hash to the pin
//      AND its canonical record identity matches the pin. Byte drift, identity
//      drift, an unsupplied record and a throwing resolver are four distinct
//      outcomes, and all four yield NO record.
//   2. A legacy record with no typed `overrides` is normalized by an EXPLICIT
//      versioned adapter that declares the exact original byte hash it read.
//      The original document is never rewritten; `recordedAt` stays null.
//   3. A record's own named source artifacts are re-hashed before it can
//      qualify. Unresolvable is unresolved, never "so the correction is
//      unnecessary" and never "so the original still holds".
//   4. An override value that is not in the PK03-pinned vocabulary is REFUSED.
//      The consumer does not widen an enum to fit a historical record.
//   5. A known-applicable but unresolved field WITHHOLDS the derived claim.
//      The original value is never used as a silent fallback - that is exactly
//      how a retracted completion rate of 1 would come back from the dead.
//
// What this module must never do, and does not:
//
//   * mutate a raw row, or drop one. `rawRows` is the live row array, in the
//     live order, and `correctedRows` holds structural copies.
//   * write a correctness, format-conformance or strategy-success value. Those
//     are judgements of immutable candidate bytes and are not row-writable.
//   * transplant a historic literal table rate. The rate is always recomputed
//     from CORRECTED rows and a qualified denominator, or withheld.
//   * change the public row or table schemas. Schema-owned columns are left
//     alone; corrections that have no schema representation become SIDECAR
//     annotations instead of being forced into a row that would then fail
//     validation.

import {
  adaptCorrectionRecord,
  deriveLifecycleOverrides,
  KNOWN_CORRECTION_KINDS,
  recomputeCompletionRate,
  selectCorrections,
  type CorrectionOverride,
  type CorrectionRecord,
  type DeriveLifecycleOptions,
  type DerivedLifecycleOverrides,
  type SelectionResult,
  type WithheldField,
} from './corrections.ts';
import { verifyCorrectionBinding, type ArtifactResolver, type BindingVerdict } from './correction-binding.ts';
import { projectRetention, type RetentionView } from './retention.ts';
import { projectStatusView, type DimensionClaim, type RouteInput, type RouteView, type StatusView } from './status-view.ts';
import { approvedAuthorities, verifyManifest, type CorrectionsManifest, type EntryVerification, type ManifestEntry, type ManifestResolver } from './manifest.ts';
import { COMPLETION_STATUSES, isPinnedOperationalStatus, isPinnedTerminalCause } from './vocabulary.ts';
import type { ArtifactBinding, Disposition, ResourceKind } from './types.ts';

export const CONSUMER_SCHEMA_VERSION = 1;

/**
 * The minimal row surface a correction may touch. Deliberately structural: the
 * consumer must not import the PK02-owned ResultRow, so it states what it
 * needs and lets the aggregate lane pass its own rows in.
 */
export interface CorrectableRow {
  runId: string;
  outcomes?: {
    operationalStatus?: string;
    candidateCorrectness?: boolean | null;
    formatConformance?: boolean | null;
    assignedStrategySuccess?: boolean | null;
  };
  taskOutcome?: {
    operationalStatus?: string;
    execution?: { terminalCause?: string; launched?: boolean | null };
  };
}

/**
 * Correction field paths that map onto a row. A path absent from this table is
 * NOT silently dropped: it is reported as a sidecar annotation, so an
 * unmapped lifecycle fact is visible rather than lost or forced into a column
 * it does not own.
 */
export const ROW_WRITABLE_CORRECTION_FIELDS: readonly string[] = ['operationalStatus', 'execution.terminalCause'];

// ---------------------------------------------------------------------------
// Loading pinned records, fail-closed
// ---------------------------------------------------------------------------

/** One pinned record that could NOT be loaded, and why. */
export interface PinnedFailure {
  entryId: string;
  path: string;
  expectedSha256: string;
  observedSha256: string | null;
  disposition: Disposition;
}

/** A verified, adapted pinned record plus the anchoring evidence. */
export interface PinnedRecord {
  /**
   * The typed correction record, or null for an evidence kind that carries no
   * lifecycle overrides (a retention binding or a G1 audit is READ, not
   * overridden). `document` is authoritative for those.
   */
  record: CorrectionRecord | null;
  /** The verified document, exactly as parsed. Never rewritten. */
  document: Record<string, unknown>;
  entry: ManifestEntry;
  /** SHA256 of the ORIGINAL BYTES the record was read from. */
  originalBytesSha256: string;
  /**
   * The versioned adapter that produced the typed overrides, or null when the
   * document already carried them or carries none. Present so a normalization
   * is never anonymous and never un-anchored.
   */
  derivation: DerivedLifecycleOverrides | null;
}

export interface PinnedCorrections {
  ok: boolean;
  records: PinnedRecord[];
  verifications: EntryVerification[];
  failures: PinnedFailure[];
  approvedAuthorities: string[];
}

export interface LoadPinnedOptions {
  /** Only load entries of these kinds. Defaults to every recognized kind. */
  kinds?: readonly string[];
  /**
   * Schema-representable mapping for legacy records that carry no typed
   * overrides. Supplied by the caller (never invented here) and validated
   * against the PK03-pinned vocabulary before use. When omitted, a legacy
   * record loads with no typed overrides and therefore qualifies for no field.
   */
  mapping?: DeriveLifecycleOptions;
}

/** Refuse an adapter mapping whose values are not in the pinned vocabulary. */
function checkMappingPinned(mapping: DeriveLifecycleOptions): Disposition | null {
  if (!isPinnedTerminalCause(mapping.terminalCause)) {
    return {
      status: 'rejected',
      reason: 'disallowed-field',
      detail: `adapter terminalCause '${mapping.terminalCause}' is not in the pinned execution.terminalCause vocabulary`,
    };
  }
  if (!isPinnedOperationalStatus(mapping.operationalStatus)) {
    return {
      status: 'rejected',
      reason: 'disallowed-field',
      detail: `adapter operationalStatus '${mapping.operationalStatus}' is not in the pinned outcomes.operationalStatus vocabulary`,
    };
  }
  if (COMPLETION_STATUSES.includes(mapping.operationalStatus)) {
    return {
      status: 'rejected',
      reason: 'completion-claim-not-retractable',
      detail: 'an adapter may retract normal completion but may not assert it',
    };
  }
  return null;
}

/**
 * Load every pinned record, verifying bytes and canonical identity first.
 *
 * `ok` is false if ANY entry failed. Callers are expected to surface `failures`
 * rather than read `records` and assume the set is whole.
 */
export function loadPinnedCorrections(
  manifest: CorrectionsManifest,
  resolve: ManifestResolver,
  options: LoadPinnedOptions = {},
): PinnedCorrections {
  const verification = verifyManifest(manifest, resolve);
  const byId = new Map(verification.entries.map((entry) => [entry.id, entry]));
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const mappingProblem = options.mapping ? checkMappingPinned(options.mapping) : null;

  const records: PinnedRecord[] = [];
  const failures: PinnedFailure[] = [];

  for (const entry of manifest.entries) {
    const check = byId.get(entry.id);
    const skip = (disposition: Disposition): void => {
      failures.push({
        entryId: entry.id,
        path: entry.path,
        expectedSha256: entry.sha256,
        observedSha256: check?.observedSha256 ?? null,
        disposition,
      });
    };

    if (!check || check.status !== 'verified') {
      const status = check?.status ?? 'not-supplied';
      skip(
        status === 'byte-mismatch'
          ? { status: 'unresolved', reason: 'artifact-binding-mismatch', detail: check?.detail ?? 'byte drift' }
          : status === 'canonical-mismatch'
            ? { status: 'unresolved', reason: 'artifact-binding-mismatch', detail: check?.detail ?? 'identity drift' }
            : { status: 'unresolved', reason: 'artifact-binding-unresolved', detail: check?.detail ?? 'record not supplied' },
      );
      continue;
    }
    if (kinds && !kinds.has(entry.kind)) continue;

    let doc: Record<string, unknown>;
    try {
      // The bytes were just hashed, so a parse failure here means the pin
      // describes something that is not JSON: still fail closed.
      doc = JSON.parse(String(resolve(entry))) as Record<string, unknown>;
    } catch (error) {
      skip({ status: 'unresolved', reason: 'artifact-binding-unresolved', detail: `pinned record is not parseable JSON: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    // The conductor-pinned manifest is what classifies a record. Legacy
    // retention and audit documents declare no `kind` of their own, so the pin
    // supplies it. A document that DOES declare a kind must agree with its
    // pin: kind drift between the bytes and the manifest is a binding failure,
    // not a silent reclassification.
    const declaredKind = typeof doc.kind === 'string' ? doc.kind : null;
    if (declaredKind !== null && declaredKind !== entry.kind) {
      skip({ status: 'unresolved', reason: 'artifact-binding-mismatch', detail: `document kind '${declaredKind}' disagrees with the pinned kind '${entry.kind}'` });
      continue;
    }
    if (declaredKind === null && !(KNOWN_CORRECTION_KINDS as readonly string[]).includes(entry.kind)) {
      skip({ status: 'rejected', reason: 'scope-mismatch', detail: `pinned kind '${entry.kind}' is not a recognized record kind` });
      continue;
    }

    // Only a lifecycle correction carries overrides. A retention binding or a
    // G1 audit is evidence to be READ (projectRetention / consumeStatus), not
    // a record that may override a projection, so it gets no typed record.
    if (entry.kind !== 'append-only-lifecycle-correction') {
      records.push({ record: null, document: doc, entry, originalBytesSha256: entry.sha256, derivation: null });
      continue;
    }

    // Legacy records carry no authority of their own. The manifest entry IS the
    // conductor-pinned authority/supersession reference the interface allows
    // for adapting them, and it is never used to invent a timestamp.
    const adapted = adaptCorrectionRecord({ ...doc, kind: entry.kind }, {
      authorityId: entry.authorityId,
      canonicalId: entry.canonicalId,
      recordedAt: entry.recordedAt,
    });
    if (!adapted.record) {
      skip(adapted.rejection ?? { status: 'rejected', reason: 'scope-mismatch', detail: 'record did not adapt' });
      continue;
    }

    // A record with no typed overrides is the legacy shape. Normalize it
    // through the versioned adapter, anchored to the original byte hash.
    let derivation: DerivedLifecycleOverrides | null = null;
    let overrides: CorrectionOverride[] = adapted.record.overrides;
    if (overrides.length === 0) {
      if (mappingProblem) {
        skip(mappingProblem);
        continue;
      }
      if (options.mapping) {
        derivation = deriveLifecycleOverrides(doc, entry.sha256, options.mapping);
        overrides = derivation.overrides;
      }
    }

    records.push({
      // The record keeps the identity the manifest verified; only the override
      // list is normalized, and only by a declared, anchored adapter.
      record: { ...adapted.record, overrides },
      document: doc,
      entry,
      originalBytesSha256: entry.sha256,
      derivation,
    });
  }

  return {
    ok: failures.length === 0,
    records,
    verifications: verification.entries,
    failures,
    approvedAuthorities: approvedAuthorities(manifest),
  };
}

// ---------------------------------------------------------------------------
// Consuming a run's report
// ---------------------------------------------------------------------------

/** The subset of the selection result a report needs to render its own state. */
export interface ReportState {
  selectionStatus: SelectionResult['status'];
  correctedFields: string[];
  withheld: WithheldField[];
  /** The historic literal value, reported for contrast and never reused. */
  historicCompletionRate: number | null;
  /**
   * Recomputed from CORRECTED rows over a qualified denominator, or null when
   * the claim is withheld. Never the historic literal.
   */
  correctedCompletionRate: number | null;
  /** True when a completion rate was retracted and cannot be recomputed. */
  completionRateWithheld: boolean;
  /** Corrected lifecycle facts with no schema-owned column, kept as sidecar. */
  annotations: Array<{ field: string; value: unknown; recordSha256: string }>;
  /** Records that blocked a claim for this run, with the reason. */
  blockers: Disposition[];
  /** False when nothing qualified, or when a blocker withheld a claim. */
  applied: boolean;
}

export interface RunReportInput<T extends CorrectableRow> {
  runId: string;
  /** The live raw rows, in the live order. Never mutated, never reordered. */
  rows: readonly T[];
  /** The historic published projection values, verbatim. */
  original: Record<string, unknown>;
  /** Byte-bound reference to the historic report, for provenance. */
  originalRef?: ArtifactBinding;
  corrections: PinnedCorrections;
  /**
   * Resolver for the artifacts each correction names in its own
   * sourceEvidence. Omitted means every named artifact is unresolved, which
   * withholds the affected claims rather than assuming agreement.
   */
  resolveEvidence?: ArtifactResolver;
}

export interface ConsumedRunReport<T> {
  schemaVersion: number;
  runId: string;
  /** The live raw rows, exactly as supplied. */
  rawRows: T[];
  /** Structural copies carrying whatever correction actually qualified. */
  correctedRows: T[];
  selection: SelectionResult;
  state: ReportState;
}

/** Is `value` a number, i.e. a literal table rate rather than an absence? */
function historicRate(original: Record<string, unknown>): number | null {
  const value = original['table.operationalCompletionRate'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Apply one qualified override to a DERIVED copy of a row.
 *
 * The copy is shallow-with-nested-clones along the two paths the consumer
 * writes, so the raw row and its nested objects are never aliased into the
 * correction. A protected field is never a target: it is not in
 * ROW_WRITABLE_CORRECTION_FIELDS, so a qualified record cannot reach it here
 * even if the allowlist were widened upstream.
 */
function applyToRow<T extends CorrectableRow>(row: T, override: CorrectionOverride): T {
  if (override.field === 'operationalStatus' && isPinnedOperationalStatus(override.value)) {
    const next: T = { ...row };
    if (row.outcomes !== undefined) next.outcomes = { ...row.outcomes, operationalStatus: override.value };
    if (row.taskOutcome !== undefined) next.taskOutcome = { ...row.taskOutcome, operationalStatus: override.value as never };
    return next;
  }
  if (override.field === 'execution.terminalCause' && isPinnedTerminalCause(override.value)) {
    if (row.taskOutcome === undefined || row.taskOutcome.execution === undefined) return row;
    const next: T = { ...row, taskOutcome: { ...row.taskOutcome, execution: { ...row.taskOutcome.execution, terminalCause: override.value } } };
    return next;
  }
  return row;
}

/**
 * Refuse an override whose value is outside the pinned vocabulary.
 *
 * This is the last gate before a value reaches a row. A record that names a
 * lifecycle label the PK03 schema does not represent does not get that label
 * forced onto the row, and the schema enum is NOT widened to accept it.
 */
function checkValueVocabulary(override: CorrectionOverride): Disposition | null {
  if (override.field === 'operationalStatus') {
    if (!isPinnedOperationalStatus(override.value)) {
      return { status: 'rejected', reason: 'disallowed-field', detail: `operationalStatus '${String(override.value)}' is not in the pinned vocabulary; the enum is not widened to fit a historical record` };
    }
    if (COMPLETION_STATUSES.includes(override.value)) {
      return { status: 'rejected', reason: 'completion-claim-not-retractable', detail: 'a correction may retract normal completion but may not assert it' };
    }
    return null;
  }
  if (override.field === 'execution.terminalCause') {
    if (!isPinnedTerminalCause(override.value)) {
      return { status: 'rejected', reason: 'disallowed-field', detail: `execution.terminalCause '${String(override.value)}' is not in the pinned vocabulary` };
    }
    return null;
  }
  return null;
}

/**
 * Consume the corrections for one run into an emitted report view.
 *
 * The returned object carries BOTH row sets. A caller publishes `rawRows` (or
 * its own aggregate of them) unchanged and publishes `correctedRows` only
 * alongside `state`, which says what was corrected and what was withheld.
 */
export function consumeRunReport<T extends CorrectableRow>(input: RunReportInput<T>): ConsumedRunReport<T> {
  const { runId, rows, original, corrections, resolveEvidence } = input;
  const originalRef = input.originalRef ?? null;
  const blockers: Disposition[] = [];

  // Only lifecycle corrections can override a projection; an evidence record
  // (retention binding, G1 audit) has no typed record and is read, not applied.
  const scoped = corrections.records.filter((pinned) => pinned.record?.identity.runId === runId && pinned.record !== null);
  // Every load failure is a blocker for EVERY run, not just the run the failed
  // record would have spoken about: an unverified pin means the pinned set is
  // not whole, and a consumer that scoped the failure to one run would imply
  // the other runs' reports are complete. A record that failed to load has no
  // readable runId, so the run-scoped judgement cannot honestly be made here.
  for (const failure of corrections.failures) {
    blockers.push(failure.disposition);
  }

  // Re-hash every artifact each record names, before it can qualify.
  const bindingVerdicts = new Map<string, BindingVerdict>();
  for (const pinned of scoped) {
    const record = pinned.record!;
    const verdict = verifyCorrectionBinding(record, resolveEvidence ?? (() => null));
    bindingVerdicts.set(record.recordSha256, verdict);
    // EVERY non-verified verdict is a blocker, including a mismatch. Resolved
    // bytes that differ from the pin are an integrity failure the report must
    // surface, not a silent non-event.
    if (verdict.status !== 'verified') {
      blockers.push(verdict.disposition);
    }
  }

  const selection = selectCorrections({
    runId,
    original,
    ...(originalRef ? { originalRef } : {}),
    records: scoped.map((pinned) => pinned.record!).filter((record): record is CorrectionRecord => record !== null),
    approvedAuthorities: corrections.approvedAuthorities,
    bindingStatus: (record) => bindingVerdicts.get(record.recordSha256)?.disposition,
  });

  // Vocabulary gate, applied to every qualified value before it can reach a row.
  const correctedFields: string[] = [];
  const annotations: ReportState['annotations'] = [];
  const vocabularyRejects: WithheldField[] = [];
  const effective = new Map<string, CorrectionOverride>();
  for (const [field, projected] of Object.entries(selection.projection)) {
    if (projected.origin !== 'correction') continue;
    const override: CorrectionOverride = { field, value: projected.value };
    const problem = checkValueVocabulary(override);
    if (problem) {
      vocabularyRejects.push({ field, reason: problem.reason, detail: problem.detail ?? 'no detail recorded', recordSha256: projected.recordSha256 ?? null });
      continue;
    }
    effective.set(field, override);
    correctedFields.push(field);
    if (!ROW_WRITABLE_CORRECTION_FIELDS.includes(field)) {
      annotations.push({ field, value: projected.value, recordSha256: projected.recordSha256 ?? 'unanchored' });
    }
  }

  const rawRows = [...rows];
  let correctedRows: T[] = rawRows;
  for (const override of effective.values()) {
    correctedRows = correctedRows.map((row) => applyToRow(row, override));
  }

  const withheld = [...selection.withheld, ...vocabularyRejects];

  // A pinned record whose declared adapter DECLINED a lifecycle projection has
  // still SPOKEN about that field. `selectCorrections` only sees fields a record
  // supplies an override for, so a declined projection would otherwise leave the
  // field with no speaker and the retracted ORIGINAL value would quietly stand
  // again - which is precisely how run19's historic completion rate of 1 comes
  // back from the dead. Any field a record retires but cannot replace is
  // therefore marked withheld here, so the original is never reused.
  for (const pinned of scoped) {
    for (const gap of pinned.derivation?.unmapped ?? []) {
      if (!(gap.field in original)) continue;
      if (withheld.some((entry) => entry.field === gap.field)) continue;
      withheld.push({
        field: gap.field,
        reason: 'adapter-unmapped',
        detail: `${pinned.entry.id} retires ${gap.field} but its adapter produced no replacement (${gap.reason}); the original value is not reused for a retracted projection`,
        recordSha256: pinned.record?.recordSha256 ?? null,
      });
    }
  }

  const rateWithheld = withheld.some((entry) => entry.field === 'table.operationalCompletionRate');
  const rateOverride = effective.get('table.operationalCompletionRate');
  const correctedCompletionRate: number | null = rateWithheld
    ? null
    : rateOverride !== undefined
      ? recomputeCompletionRate(
          correctedRows
            .filter((row) => row.runId === runId)
            .map((row) => ({ operationalStatus: row.outcomes?.operationalStatus ?? 'unknown' })),
        )
      : historicRate(original);

  const state: ReportState = {
    selectionStatus: selection.status,
    correctedFields: [...correctedFields].sort(),
    withheld,
    historicCompletionRate: historicRate(original),
    correctedCompletionRate,
    completionRateWithheld: rateWithheld,
    annotations,
    blockers,
    applied: correctedFields.length > 0,
  };

  return { schemaVersion: CONSUMER_SCHEMA_VERSION, runId, rawRows, correctedRows, selection, state };
}

// ---------------------------------------------------------------------------
// Consuming retention
// ---------------------------------------------------------------------------

/**
 * Why the consumer refuses a state change. Retained/absent/unknown is decided
 * from evidence, so the only legal move between two records is an exact
 * agreement; a downgrade to `unknown` is always legal because `unknown` never
 * asserts more than the weaker record does.
 */
function reconcileStates(a: string, b: string): { state: string; conflicted: boolean } {
  if (a === b) return { state: a, conflicted: false };
  if (a === 'unknown') return { state: b, conflicted: false };
  if (b === 'unknown') return { state: a, conflicted: false };
  return { state: 'unknown', conflicted: true };
}

export interface ConsumedRetention {
  runId: string;
  /** null when no verified retention record covers this run, or on conflict. */
  view: RetentionView | null;
  /** Verifications of the retention entries considered, in manifest order. */
  sources: Array<{ entryId: string; verification: EntryVerification }>;
  blockers: Disposition[];
}

export interface ConsumeRetentionInput {
  runId: string;
  corrections: PinnedCorrections;
  /** Kinds treated as retention evidence. Defaults to ['retention-binding']. */
  kinds?: readonly string[];
}

/**
 * Consume pinned retention records into a per-resource tri-state.
 *
 * `unknown` is preserved as `unknown`. Nothing here can lift a resource off
 * `absent` because another resource is retained, and nothing here turns a
 * `retained` sibling into a restored candidate: a patch surviving does not
 * restore the full candidate, and a later record's silence is not a retraction.
 */
export function consumeRetention(input: ConsumeRetentionInput): ConsumedRetention {
  const { runId, corrections } = input;
  const kinds = new Set(input.kinds ?? ['retention-binding']);
  const blockers: Disposition[] = [];
  const sources: ConsumedRetention['sources'] = [];

  const views: RetentionView[] = [];
  for (const pinned of corrections.records) {
    if (!kinds.has(pinned.entry.kind)) continue;
    const doc = pinned.document;
    if (doc.runId !== runId) continue;
    const check = corrections.verifications.find((entry) => entry.id === pinned.entry.id) ?? null;
    sources.push({ entryId: pinned.entry.id, verification: check as EntryVerification });
    views.push(
      projectRetention({
        runId,
        record: doc,
        recordRef: { path: pinned.entry.path, sha256: pinned.entry.sha256 },
        recordedAt: pinned.entry.recordedAt,
      }),
    );
  }

  for (const failure of corrections.failures) {
    blockers.push(failure.disposition);
  }

  if (views.length === 0) return { runId, view: null, sources, blockers };

  // Reconcile by evidence, never by recency. Agreement keeps the state; a
  // genuine contradiction (retained vs absent) is a conflict, and the resource
  // falls back to `unknown` rather than picking a winner by timestamp.
  let merged = views[0]!;
  let conflicted = false;
  for (const view of views.slice(1)) {
    const resources = { ...merged.resources };
    let anyConflicted = false;
    for (const kind of Object.keys(resources) as ResourceKind[]) {
      const outcome = reconcileStates(resources[kind]!.state, view.resources[kind]!.state);
      if (outcome.conflicted) anyConflicted = true;
      resources[kind] = {
        state: outcome.state as typeof resources[typeof kind]['state'],
        evidence: [...resources[kind]!.evidence, ...view.resources[kind]!.evidence],
        recordedAt: resources[kind]!.recordedAt ?? view.resources[kind]!.recordedAt,
        reason:
          outcome.conflicted
            ? `records disagree (${resources[kind]!.state} vs ${view.resources[kind]!.state}); retained/absent conflict resolves to unknown`
            : resources[kind]!.reason,
      };
    }
    merged = { ...merged, resources };
    if (anyConflicted) conflicted = true;
  }
  if (conflicted) {
    blockers.push({ status: 'unresolved', reason: 'conflicting-successors', detail: 'retention records disagree; the affected resources are unknown, not a chosen winner' });
  }

  return { runId, view: conflicted ? null : merged, sources, blockers };
}

// ---------------------------------------------------------------------------
// Consuming route/campaign status
// ---------------------------------------------------------------------------

/** Fields that state a route's G1 qualification, and how to read them. */
const G1_EVIDENCE_KEYS = ['workspaceSeparation', 'frozenBaselineTree', 'independentJudgement', 'timeoutStopSettlementExport', 'nullableUsagePreserved'] as const;

/** Fields that record an OPEN leg, i.e. the route's remaining criterion. */
const OPEN_LEG_KEYS = ['actualPiTimeoutCancellationLeg', 'cleanupEvidence'] as const;

export interface ConsumedRoute {
  route: string;
  lane: RouteView['lane'];
  /** The gate scope the audit itself states, e.g. "final-container Codex". */
  scope: string | null;
  /** The remaining criterion named by the record, or null when none is open. */
  remainingCriterion: string | null;
  claims: DimensionClaim[];
  blockers: Disposition[];
}

export interface ConsumedStatus {
  view: StatusView;
  routes: ConsumedRoute[];
  blockers: Disposition[];
  /** Every audit considered, so an unread route is visible as unread. */
  unreadEntries: string[];
}

export interface ConsumeStatusInput {
  corrections: PinnedCorrections;
  /** Explicit as-of instant. Required; the wall clock is never read. */
  asOf: string;
  /**
   * The scope each pinned entry id speaks for. An entry with no scope is not
   * consumed, because a route is a scope and an unscoped audit qualifies
   * nothing.
   */
  scopes: ReadonlyArray<{ entryId: string; route: string; lane: RouteView['lane'] }>;
  /** Kinds treated as route audits. Defaults to ['g1-contract-audit']. */
  kinds?: readonly string[];
}

function claimFrom(dimension: DimensionClaim['dimension'], value: boolean | null, pinned: PinnedRecord, scope: string | null): DimensionClaim {
  return {
    dimension,
    value,
    record: { path: pinned.entry.path, sha256: pinned.entry.sha256 },
    recordedAt: pinned.entry.recordedAt,
    ...(scope ? { scope } : {}),
  };
}

/**
 * Consume pinned G1 audits into per-route dimension states and a campaign
 * claim.
 *
 * The D77 discipline is enforced here: an audit that does not speak to a
 * dimension yields `null` (unknown) with a reason, never `false`; a campaign
 * claim comes only from a record that states one, never from a route pass; and
 * a route with no pin at all is listed in `unreadEntries` rather than rendered
 * as a confident "no".
 */
export function consumeStatus(input: ConsumeStatusInput): ConsumedStatus {
  const { corrections, asOf, scopes } = input;
  const kinds = new Set(input.kinds ?? ['g1-contract-audit']);
  const blockers: Disposition[] = [...corrections.failures.map((failure) => failure.disposition)];
  const unreadEntries: string[] = [];
  const routes: ConsumedRoute[] = [];

  for (const scope of scopes) {
    const pinned = corrections.records.find((record) => record.entry.id === scope.entryId);
    if (!pinned || !kinds.has(pinned.entry.kind)) {
      unreadEntries.push(scope.entryId);
      blockers.push({
        status: 'unresolved',
        reason: 'no-approval-proof',
        detail: `${scope.entryId} did not verify, so route '${scope.route}' is unknown rather than unqualified`,
      });
      routes.push({ route: scope.route, lane: scope.lane, scope: null, remainingCriterion: null, claims: [], blockers: [] });
      continue;
    }
    const doc = pinned.document;
    const auditScope = typeof doc.scope === 'string' ? doc.scope : null;
    const claims: DimensionClaim[] = [];
    const routeBlockers: Disposition[] = [];

    // actualRouteQualified, read from whichever affirmative field the audit
    // states. A record that states none leaves the dimension unknown.
    const g1 = doc.g1Evidence as Record<string, unknown> | undefined;
    const stopLeg = (doc.s1Audit as Record<string, unknown> | undefined)?.actualPiTimeoutStopLeg;
    let qualified: boolean | null = null;
    if (g1 !== undefined && G1_EVIDENCE_KEYS.every((key) => typeof g1[key] === 'boolean')) {
      qualified = G1_EVIDENCE_KEYS.every((key) => g1[key] === true);
    } else if (typeof stopLeg === 'string') {
      qualified = stopLeg === 'qualified';
    } else if (typeof doc.actualPiTimeoutCancellationLeg === 'string') {
      qualified = doc.actualPiTimeoutCancellationLeg.startsWith('qualified');
    }
    claims.push(claimFrom('actualRouteQualified', qualified, pinned, auditScope));
    if (qualified === null) {
      routeBlockers.push({
        status: 'unresolved',
        reason: 'no-approval-proof',
        detail: `${scope.entryId} states no G1 qualification field; actualRouteQualified is unknown, not false`,
      });
    }

    // The remaining criterion is the record's own words, never an inference.
    let remaining: string | null = null;
    for (const key of OPEN_LEG_KEYS) {
      const value = doc[key];
      if (typeof value === 'string' && value.length > 0) {
        remaining = remaining === null ? value : `${remaining}; ${value}`;
      }
    }

    routes.push({ route: scope.route, lane: scope.lane, scope: auditScope, remainingCriterion: remaining, claims, blockers: routeBlockers });
  }

  // Campaign completion is read only from records that state it explicitly.
  const campaignClaims: DimensionClaim[] = [];
  for (const pinned of corrections.records) {
    if (!kinds.has(pinned.entry.kind)) continue;
    const doc = pinned.document;
    if (typeof doc.campaignComplete !== 'boolean') continue;
    campaignClaims.push(claimFrom('campaignComplete', doc.campaignComplete, pinned, typeof doc.scope === 'string' ? doc.scope : null));
  }
  const first: DimensionClaim | undefined = campaignClaims[0];
  const campaign: DimensionClaim | undefined = first
    ? {
        ...first,
        value: campaignClaims.every((c) => c.value === first.value) ? first.value : null,
      }
    : undefined;
  if (campaignClaims.length > 1 && !campaignClaims.every((c) => c.value === first?.value)) {
    blockers.push({ status: 'unresolved', reason: 'conflicting-successors', detail: 'pinned audits disagree on campaignComplete; it is unknown until an explicit supersession decides' });
  }

  const routeInputs: RouteInput[] = routes.map((route) => ({ route: route.route, lane: route.lane, claims: route.claims }));
  const view = projectStatusView({ asOf, routes: routeInputs, ...(campaign ? { campaign } : {}) });

  return { view, routes, blockers, unreadEntries };
}
