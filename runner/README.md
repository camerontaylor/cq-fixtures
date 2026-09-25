Thin-custom eval runner — the R7 null hypothesis (plan §3.2; DECISIONS.md): before adopting a framework (evalite/promptfoo/Inspect), dogfood the toolkit's own ops and see how far plain data plus one execution seam gets. R7 decides later whether a framework replaces or wraps this; the runner is built regardless.

## What it dogfoods (public package surface only)

- `Driver.run(OpInvocation)` — execution. The driver is INJECTED (`runSuite` takes one; the CLI builds it from `--driver`), so adding a case is a suite.json edit and swapping lanes is a flag — no runner change (the conformance property, pinned by `test/runner.test.ts`).
- `BudgetGovernor` + `governorConfig` — the run's USD/token caps: admission gate per case, usage/cost rollup per result, fail-loud trip (an unpriced model under `--max-usd` gates the run rather than running unbounded). A tripped cap emits NO rows for refused cases — the honest stop lives on the journal's `run-finished` event and the nonzero exit.
- `openRunLog` — the NDJSON journal: `run-started` / `job-started` / `job-finished` / `run-finished` events, one file per run.
- `computeCostUSD` / `priceOf` — DD-9 cost: derived ONLY from the price map over observed usage; `null` when the served model has no price (a subscription lane never gets an invented number), `costBasis: "modeled"` when derived.

The boundary is enforced by `test/boundary.test.ts`: runner code, its built `dist/` output (`npm run build`), the test tree, and `scripts/pack-toolkit.sh` + `scripts/flip-to-published.sh` consume ONLY the bare `@camerontaylor/cq-toolkit` specifier — never a `src`/`dist` deep import, never a relative escape into a vendored tree.

## CLI

```
node --experimental-strip-types runner/index.ts \
  --suite <dir> --driver fake --driver-name <lane> \
  --model <served-id> --provider <handle> --max-usd 1 --out <dir>
```

Node >= 23.6 runs the TypeScript directly (type stripping); CI uses node 24. `--suite` is repeatable; other flags: `--max-usd-per-case`, `--max-tokens`, `--check-timeout-ms`, `--journal <dir>`, `--probe-record <path>`. `--probe-record` takes the workflow ACP preflight's `ACP-PROBE.json` (review-debt #14): the pre-runner auth probe is admitted through the run's governor and journaled with the run as a labeled conservative token reservation instead of spending off-books — a missing or malformed record is exit 2. `--driver fake` is the deterministic offline stand-in for plumbing smoke/CI — rows must be labeled with the lane it impersonates via `--driver-name` (the row schema's driver enum only accepts the four toolkit lanes); `--driver ai-sdk` builds the toolkit's `AiSdkDriver` with production defaults and is never the default. Exit codes: 0 clean, 1 scored-zero/gated/scoring-phase failure, 2 usage error, suite load/validation failure, or missing-credential failure.

## Per-case USD budgets and coverage (W6.2)

Every run carries a **per-case USD budget**: an explicit `--max-usd-per-case`, or — by default — the accepted D9 envelope's cap for the exact cell (`runner/budget.ts` `D9_PER_CASE_USD`: $0.05 on the ai-sdk flash cells, $0.10 on the claude-agent/subprocess/acp GLM lanes, $1.00 on the frontier Claude cell). A cell the table does not map refuses to run (exit 2, before any spend) rather than run uncapped — fake runs resolve like real ones, so smoke proves the table covers every dispatchable cell. The budget binds at two grains: each invocation's `budget.maxUsd` (driver-enforced on claude-agent/subprocess) and the run governor's cumulative cap, the per-case budget × the suite's case count — the enforcement that also covers the lanes whose driver ignores `Budget.maxUsd` (ai-sdk, acp).

The three stop shapes are recorded differently, per the honesty taxonomy below:

- **Refused before dispatch** (the cumulative cap tripped): NO row, and an explicit `budget-stop: …` absence in `RunSuiteResult.absences[]` and the manifest's `absences[]` — never a silent no-row.
- **Stopped mid-case by its own budget** (`stopReason: 'budget'`): the honest incomplete row gains `stopCause: 'budget'` — the cause column — and the cell counts it in `budgetStops`.
- **Completed but over its own ceiling** (W6.4; the lanes whose driver ignores `Budget.maxUsd` — ai-sdk, acp — have no per-case driver stop, so the overrun is detected from the derived cost after the fact): the row keeps its measured outcome AND gains `stopCause: 'budget'`, plus a `per-case budget exceeded: …` absence, so the case is recorded and excluded from coverage instead of passing silently.

Coverage is mechanical (`RS-9 §1.3`): every row carries `expectedCases` (the suite's case count), and cells aggregate it into `expectedCases` / `coveredCases` (distinct cases whose row is complete evidence — a budget-stopped row does not count) / `coverage`, with `isAtCoverageParity(a, b)` as the gate a comparison must pass before it may be labelled stronger than *descriptive*. `run.json` records `expectedCases` and the binding `maxUsdPerCase` + basis (`d9-default` | `explicit`) so a snapshot states the cap that bound it. All fields are additive-optional: pre-W6.2 rows re-aggregate to their original tables byte-identically.

## Unattended ceiling refusal (W6.4)

The real matrix passes each cell's D9 cap explicitly (suite.yml `usd_per_case` → `--max-usd-per-case`; the workflow-contract test cross-checks the literals against `D9_PER_CASE_USD`). The runner adds a second, environment-level gate: a real-lane run under `GITHUB_ACTIONS=true` whose only cap is the legacy run-level `--max-usd` is refused (exit 2, before any dispatch) — an unattended run has nobody to watch a case blow through its envelope share, so it must carry a per-case ceiling. Attended local runs keep the legacy `--max-usd` semantics verbatim, and fake runs are exempt (the smoke spends nothing and its D9 resolution already proves the envelope covers every dispatchable cell).

## Scoring contract

Per-role scorers live in `runner/score/`: `check-rerun` (fixer-worker) re-runs the seeded check with cwd set to the fixture workspace — the worker's answer does not influence the probe, re-running the check IS the contract; `expected-verdict` (review-classifier) compares the classifier's `structuredOutput.verdict` against the suite's expected value from the toolkit's classifyThreads vocabulary (actionable | responded | resolved | blocked | skip). A probe that cannot execute scores 0 with diagnostics and never aborts the run. Fixer cases carry a SECOND scored probe (DD-4, phase-3 J4): `runner/dimensions/schemaCompliance.ts` grades whether the worker's `structuredOutput` holds the strict `{fixed: boolean, notes: string}` shape it was asked to declare — so a fixer row's `outcome.total` is 2 (check probe + schema probe) and a model's json-fidelity is visible in its score.

Per-verdict metrics F4 (2026-09-21): review-classifier rows carry `probes[]` with the observed verdict per case (null when missing/unparseable — a miss with no predicted bucket) plus `suspiciousBenign: true` when the case's fixture-side `label.json` (beside the thread payload) carries fp_flag `suspicious-benign`; `runner/aggregate.ts` folds these into per-cell `byVerdict` confusion counts, `macroF1`, and `fpRate`/`fpN`. The sidecar read never throws (missing/unreadable sidecars stay unflagged — micro suites carry no labels) and fixer cells keep their exact pre-F4 shape.

## Driver failures — scored miss vs loud absence (F1b/WB-1)

A case whose driver returns `stopReason: 'error'` is classified from the
bounded `WorkerResult.error` cause the toolkit surfaces (cq-toolkit #206/#210/#212).
The cause's class token is its second component: `ai-sdk driver: [<token>]`.

- Exactly `ai-sdk driver: [structured-output-miss]` is a MODEL outcome: the
  worker emitted unparseable structured output. The case publishes an honest
  DD-4 scored-miss row — `outcome {score: 0, passed: 0, total: <probe ceiling>}`
  (2 for a fixer, 1 for a classifier) — so it counts in the tables as a real
  zero. The journal keeps the cause verbatim; `structuredOutput` is never
  fabricated. The match is exact (the predicate `isStructuredOutputMissCause`
  reads the token from position zero and compares it with `===`): a longer
  token, a mid-message mention, or another lane's cause is not a miss. Only the
  separator AFTER the closing bracket is a character class — any non-identifier
  character (space, tab, comma, newline) or end-of-string; the toolkit emits a
  space, but a different separator must never flip a model outcome into an
  infrastructure absence.
- Every other cause (`[endpoint-timeout]`, `[provider-error]`, no cause, an
  unknown one) is infrastructure: NO row and NO prediction artifact is
  published — a driver failure never masquerades as a model score (I9). The
  case is recorded in `RunSuiteResult.absences` and, in the out dir's
  `run.json`, in the entry's optional `absences[]`; the journal keeps the
  cause verbatim with status `failed`. The workflow renders that as a
  `::warning::`, a step-summary line, and a `DISPATCH-ONLY-*` marker (so the
  snapshot job never clears a same-day dir), and the CLI exits 1.
- A driver that THROWS (`worker === undefined`) is the same infrastructure
  class — no `WorkerResult`, no class token — so it publishes no row and is
  recorded as an absence carrying the bounded/redacted thrown message.

Governed stops are NOT absences: `stopReason: 'budget'` (the driver's own
`stopWhen`/length stop) and `stopReason: 'aborted'` (the governor's
cancellation signal fired) both mean the case RAN and was deliberately cut
off, so they keep publishing honest incomplete rows (`outcome 0` over the
probe ceiling) with their own journal statuses (`budget-exhausted` /
`indeterminate`). Only the `error` verdict's non-model causes — and a thrown
driver — become absences, because those are the paths where the model was
never given a gradeable, completed chance at all.

## Served ids

The row's `model` is the OBSERVED id the driver reports from the wire (a gateway's silent remap surfaces as data, never silently rewritten); the requested id is only the fallback for lanes that cannot observe it.

## Eval root, answer key and sentinel (W6.3)

Runs dispatch from an **eval root**, never from the checkout (RS-9 §4.3). `node scripts/eval-root.mjs build --out <root> --key <key>` builds it from an allowlist: `runner/**/*.ts`, the three runtime schemas, the denylist policy, `package.json`, `toolkit.lock`, the judge (`fixtures/judge-lib.mjs` + its vitest config), each suite's fixture (`check.mjs`, `package.json`, `src/**`, `test/**`, or one thread payload), and every non-deprecated `suite.json` stripped to `id`, `fixture`, `task.prompt`, `probe.kind` and `probe.check`. Fault records, label sidecars, `catalog/`, docs, `reports/`, `test/` and `.git` never enter it. The classifier's expected verdicts and label-sidecar flags go to a runner-only answer key **outside** the root; `loadSuite(dir, key)` fills them in before schema validation. `scan` re-derives the allowlist and fails on any extra, altered or answer-bearing file, an escaping symlink, or a prompt carrying an answer marker or a 6-token span of its fix diff.

A runner inside a built root (its `EVAL-ROOT.json` is present) refuses to run without `--answer-key`, refuses a key inside the root or built for another root, and arms the **sentinel**: the key's random token is planted in a file beside the fixtures (and, in CI, in the pruned checkout). A case whose structured output, error, tool denials, driver throw, patch, session transcript or workspace carries the token, the key path, a planted path or any path under the root publishes no row — it becomes a `sentinel-contamination` absence in `run.json` — and the run exits 2. The classifier prompt no longer names its fixture path, and fixer patches exclude `node_modules/`.
