// PK14 sidecar types for correction-aware reporting (D22, D77).
//
// Scope discipline (correction-reporting-development-v1): this module is an
// INTERNAL SIDECAR and a pure projection. It does not change the public
// result-row or comparison-table schemas (PK03-owned) and it is not imported
// by runner/index.ts or runner/aggregate.ts (PK02-owned). Until the conductor
// grants the serialized wiring lease, corrections are SELECTABLE here and
// APPLIED nowhere in an emitted row or table. Do not read this file's presence
// as report consumption.
//
// Three distinctions are load-bearing everywhere below and must never be
// collapsed:
//   * null (unknown) vs false vs 0 — a missing record is unknown, never a
//     favourable value and never an observed zero.
//   * correctness (did the candidate work) vs compliance (format) vs
//     strategy success vs operational completion — a lifecycle correction may
//     retract a completion claim but may never rewrite a correctness outcome.
//   * actual route/profiles vs development worker consumption — the latter is
//     not a campaign observation.

/** Byte-bound reference to an immutable source record or artifact. */
export interface ArtifactBinding {
  /** Canonical readable path of the immutable record, as recorded. */
  path: string;
  /** SHA256 of the original record bytes. */
  sha256: string;
}

/** Which artifact namespace a path belongs to, so a caller can resolve it. */
export type BindingRoot = 'repo' | 'corpus';

/** A byte-bound reference plus the root it is relative to. */
export interface RootedBinding extends ArtifactBinding {
  root: BindingRoot;
}

/**
 * Retention of one resource type. `absent` is PROVEN GONE by a cited record;
 * `unknown` means no proof exists. Artifact absence on its own never proves
 * historical absence, and a lost artifact is never reconstructed from a
 * surviving sibling.
 */
export type RetentionState = 'retained' | 'absent' | 'unknown';

/** The six resource types the D22 contract requires to be stated separately. */
export type ResourceKind =
  | 'patch'
  | 'auth'
  | 'fullCandidate'
  | 'taskVolume'
  | 'contextVolume'
  | 'publishedHost';

/** Overall outcome of deterministic correction selection. */
export type SelectionStatus = 'none' | 'selected' | 'unresolved' | 'conflict';

/** Why a value is unknown / withheld / rejected. Never a claim of success. */
export type DispositionReason =
  | 'no-correction-record'
  | 'original-value'
  | 'selected-correction'
  | 'superseded-by-successor'
  | 'authority-unapproved'
  | 'artifact-binding-unresolved'
  | 'artifact-binding-mismatch'
  | 'scope-mismatch'
  | 'disallowed-field'
  | 'protected-correctness-field'
  | 'completion-claim-not-retractable'
  | 'conflicting-successors'
  | 'supersession-cycle'
  | 'duplicate-record'
  | 'no-approval-proof'
  | 'scope-not-campaign-wide';

/** One recorded disposition for a record, field or dimension. */
export interface Disposition {
  status: 'accepted' | 'rejected' | 'unresolved' | 'superseded';
  reason: DispositionReason;
  detail?: string;
}
