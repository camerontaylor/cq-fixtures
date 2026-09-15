Scored per-role task suites for cq-toolkit: each suite is a directory of task cases, one case = {fixture ref, task spec, scoring probe} (plan §3.2; ws-j item 3).

Each suite directory carries a `suite.json` validated by `schema/suite.schema.json`; the case shape, probe variants, `servedModel`, and `provenance` fields are defined there.

## Scoring

- **fixer-worker — automatic.** The runner re-runs the seeded check probe named by the case's
  `check-rerun` probe, reusing the toolkit's baselineProbe mechanics (kept sweep-agnostic).
  The case passes iff the probe passes on the worker's result.
- **review-classifier — verdict match.** The runner compares the classifier's verdict against the
  case's expected verdict in the toolkit's exported `classifyThreads` vocabulary:
  `actionable | responded | resolved | blocked | skip` (ws-j item 3; UC §2 row 34).

## Result rows

Every scored run emits one result row per case, validated by `schema/result-row.schema.json`:
outcome, cost, and wall time are recorded automatically per row. `costUSD` is `null` on
subscription lanes — a number is never invented for them (DD-9, 2026-09-14).

## Served-id rule (2026-09-14)

Suites and matrix cells request the model id the wire actually serves (GLM coding wire →
`glm-5.3-flash`), so a row's `model` is the served id and the toolkit seam's observed-model check
passes green. An observed remap despite the served id is vendor-behavior documentation, not an
eval red.

## Provenance / contamination

Suites mark provenance (`provenance.origin` / `provenance.reference`); generated or mutated
faults are preferred over verbatim public benchmark instances so scores measure fixing and
classification skill, not benchmark recall.

Micro-suites land in phase 3 (J3) — the two role subdirectories stay scaffold scaffolds until
then (their own READMEs say so).
