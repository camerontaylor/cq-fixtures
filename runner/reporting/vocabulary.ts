// PK14: pinned copy of the PK03-owned result-row outcome vocabulary.
//
// schema/result-row.schema.json is PK03-owned and is NOT edited or imported for
// mutation here; this is a read-only pinned copy of two enum vocabularies, kept
// so the sidecar can tell an authoritative value apart from a schema-representable
// one. test/report-corrections.test.ts asserts this copy still equals the
// schema, so drift is a test failure rather than a silent divergence.
//
// If the schema enum changes, re-pin these arrays in the same commit that
// observes the change. Do not widen an enum to fit a historical record.

/** Mirrors result-row `execution.terminalCause`. */
export const PINNED_TERMINAL_CAUSES: readonly string[] = [
  'complete',
  'budget-exhausted',
  'transport-error',
  'provider-cancelled',
  'operator-cancelled',
  'prelaunch-failure',
  'unknown',
];

/** Mirrors result-row `outcomes.operationalStatus`. */
export const PINNED_OPERATIONAL_STATUSES: readonly string[] = [
  'complete',
  'measured-failure',
  'measured-transport-failure',
  'operational-missingness',
  'judge-failure',
  'interrupted',
  'integrity-violation',
];

/** Values that assert the run finished normally. */
export const COMPLETION_STATUSES: readonly string[] = ['complete'];

export function isPinnedTerminalCause(value: unknown): value is string {
  return typeof value === 'string' && PINNED_TERMINAL_CAUSES.includes(value);
}

export function isPinnedOperationalStatus(value: unknown): value is string {
  return typeof value === 'string' && PINNED_OPERATIONAL_STATUSES.includes(value);
}
