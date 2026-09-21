Scored per-role task suites for cq-toolkit: each suite is a directory of task cases, one case = {fixture ref, task spec, scoring probe} (plan §3.2; ws-j item 3).

Each suite directory carries a `suite.json` validated by `schema/suite.schema.json`; the case shape, probe variants, `servedModel`, and `provenance` fields are defined there.

## Scoring

- **fixer-worker — automatic.** The runner re-runs the seeded check probe named by the case's
  `check-rerun` probe. DECIDED contract (phase-3 J3, 2026-09-16, resolving review-debt #8): the
  check is a Node script — the runner always executes it as `node <check>`, and
  `schema/suite.schema.json` declares that format (`probe.check` must end in `.js`, `.cjs`, or
  `.mjs`). The judge script resolves from the repo root, which keeps it IMMUTABLE from the
  worker's perspective — a worker cannot rewrite its own scorer. It executes with cwd = the
  case's materialized writable workspace copy and MUST NOT relative-require fixture modules: a
  relative require would resolve against the pristine fixture under the repo root, not the
  workspace copy being graded. The judge reads the workspace exclusively through
  `process.cwd()`. A probe may spawn additional processes (e.g. a test runner); those children
  inherit cwd from the workspace. The check probe itself stays sweep-agnostic — no toolkit probe
  machinery involved, and the worker's answer does not influence it. DECIDED (DD-4, phase-3 J4,
  2026-09-16): a fixer case carries TWO scored probes — this check-rerun probe plus the
  schema-compliance probe (did the worker declare its verdict in the structured-output shape
  `{fixed: boolean, notes: string}` it was asked for?) — so a fixer row's `outcome.total` is 2
  and each probe contributes one credit: the case's score is the fraction of its probes that
  passed, making a model's json-fidelity visible in its score.
- **review-classifier — verdict match.** The runner compares the classifier's verdict against the
  case's expected verdict in the classifyThreads vocabulary —
  `actionable | responded | resolved | blocked | skip` (ws-j item 3; UC §2 row 34).
  `classifyThreads` itself is not on the toolkit's export surface, so the vocabulary is mirrored
  locally, enum-identical to `schema/suite.schema.json`.

## Result rows

Every scored run emits one result row per case, validated by `schema/result-row.schema.json`:
outcome, cost, and wall time are recorded automatically per row. `costUSD` is `null` on
subscription lanes — a number is never invented for them (DD-9, 2026-09-14).

## Served-id rule (2026-09-14)

Suites and matrix cells request the model id the wire actually serves (GLM coding wire →
`glm-5.3-flash`), so a row's `model` is the served id and the toolkit seam's observed-model check
passes green. An observed remap despite the served id is vendor-behavior documentation, not an
eval red.

## Fake-driver smoke runs

DECIDED (phase-3 J3, 2026-09-16, resolving review-debt #7): a fake-driver run labels its rows
with `--driver-name subprocess`. Rationale: the fake stands in for a local CLI transport — the
lane-file smoke design is "subprocess driver over a fake agent CLI" — so `subprocess` is the
honest lane label for its rows. It must never claim `ai-sdk`, the paid eval axis: a fake row
labeled `ai-sdk` would sit in a comparison-table cell that readers price as real spend. The
fake's honesty properties (see `runner/fake-driver.ts`): it echoes the REQUESTED model id back
as the observed served id, it carries no costUSD (cost derivation stays the runner's job via the
toolkit price map, DD-9 — null on unpriced lanes, never invented), and it cannot fix fixtures (a
fixer case scored against it fails unless the seeded check already passes on the untouched
fixture — correct plumbing-smoke behavior, not a scored eval result). The `.github/workflows/
suite.yml` smoke-job flip to actually run these suites landed in goal J4 (PR #12).

## Provenance / contamination

Suites mark provenance (`provenance.origin` / `provenance.reference`); generated or mutated
faults are preferred over verbatim public benchmark instances so scores measure fixing and
classification skill, not benchmark recall.

The micro-suites (phase 3, J3) live in `suites/fixer-worker/micro/` and
`suites/review-classifier/micro/` — see their `PROVENANCE.md` files and `fixtures/README.md` for
the hand-seeded synthetic fixtures they run against.

The F2 catalog-built seed (now promoted into the F3 suites below, ids unchanged) lived in
`suites/fixer-worker/breadth/` (10 cases, 4 easy / 4 medium / 2 hard). Its per-fault metadata
channel is the fixture-side `fixtures/<name>.FAULT.json` record
(`schema/fault.schema.json`), NOT a suite field — the closed case shape above is unchanged. The
record is a SIBLING FILE outside the materialized fixture directory, because it carries the
canonical fix; `test/breadth.test.ts` proves a worker workspace cannot reach it. `deprecated/`
suites are excluded from the weekly matrix discovery (`.github/workflows/suite.yml`), so a retired
case never spends tokens.

The F3 corpus promotes that seed into two suites (ids unchanged, `breadth-01..40`):
`suites/fixer-worker/breadth-verified/` (12 human-reviewed cases, full filter chain in CI) and
`suites/fixer-worker/breadth-tail/` (28 generated cases, both-states CI). The 30 new cases are
generated deterministically from `catalog/substrates/` by `catalog/generate-cases.ts`; the
runnable filter chain is `catalog/pipeline.ts`. The real-driver matrix takes a
`workflow_dispatch` input `profile: verified|full` — `verified` runs only the breadth-verified
suites, `full` (the default, and the weekly schedule's value) runs every suite. PR CI stays
fake-driver: the smoke loop runs the micro suites plus `breadth-verified`. The verified tier's
≤ 20 min serial per cell is a **projection** (digest ~90 s/case), re-baselined by F1.
