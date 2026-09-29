// PK14 barrel. Correction-aware reporting sidecar for D22 and D77.
//
// CONSUMPTION STATUS: the sidecar now HAS a non-test producer.
// `runner/reporting/producer.ts` is the caller that reads the pinned manifest
// from disk, re-verifies every pin, resolves the artifacts a correction names,
// consumes each run's report and re-aggregates the derived rows;
// `runner/reporting/produce-correction-report.ts` is its runtime entry point
// (`node --experimental-strip-types runner/reporting/produce-correction-report.ts`),
// guarded the same way runner/index.ts guards its own, so importing the
// producer has no side effect and running the script is the production run.
//
// `runner/index.ts` deliberately does NOT re-export the producer. Its
// correction-aware exports (`consumeRunReport`, `aggregateCorrected`) are the
// independently-accepted API-only surface and are unchanged. Eagerly importing
// the producer there would load this whole sidecar into every runner
// subprocess, which measurably slowed the subprocess-heavy campaign-contract
// tests past their timeouts. The producer is reached by running it, which is
// the point of a producer.
//
// What is still NOT wired, and is deliberately not claimed: the runner's own
// emit phase (runner/cli.ts, which writes rows.jsonl and the comparison tables)
// still publishes the original projection unchanged. The corrected report is a
// separate, correction-aware artifact beside it, never an overwrite. Closing
// that seam needs the conductor's serialized lease for runner/cli.ts, recorded
// as SEAM-3; it is NOT granted and is NOT asserted here. Nothing in this module
// is evidence for any campaign acceptance criterion.

export * from './types.ts';
export * from './corrections.ts';
export * from './correction-binding.ts';
export * from './retention.ts';
export * from './status-view.ts';
export * from './board.ts';
export * from './manifest.ts';
export * from './consumer.ts';
export * from './producer.ts';
