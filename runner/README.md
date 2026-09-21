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

Node >= 23.6 runs the TypeScript directly (type stripping); CI uses node 24. `--suite` is repeatable; other flags: `--max-tokens`, `--check-timeout-ms`, `--journal <dir>`, `--probe-record <path>`. `--probe-record` takes the workflow ACP preflight's `ACP-PROBE.json` (review-debt #14): the pre-runner auth probe is admitted through the run's governor and journaled with the run as a labeled conservative token reservation instead of spending off-books — a missing or malformed record is exit 2. `--driver fake` is the deterministic offline stand-in for plumbing smoke/CI — rows must be labeled with the lane it impersonates via `--driver-name` (the row schema's driver enum only accepts the four toolkit lanes); `--driver ai-sdk` builds the toolkit's `AiSdkDriver` with production defaults and is never the default. Exit codes: 0 clean, 1 scored-zero/gated/scoring-phase failure, 2 usage error, suite load/validation failure, or missing-credential failure.

## Scoring contract

Per-role scorers live in `runner/score/`: `check-rerun` (fixer-worker) re-runs the seeded check with cwd set to the fixture workspace — the worker's answer does not influence the probe, re-running the check IS the contract; `expected-verdict` (review-classifier) compares the classifier's `structuredOutput.verdict` against the suite's expected value from the toolkit's classifyThreads vocabulary (actionable | responded | resolved | blocked | skip). A probe that cannot execute scores 0 with diagnostics and never aborts the run. Fixer cases carry a SECOND scored probe (DD-4, phase-3 J4): `runner/dimensions/schemaCompliance.ts` grades whether the worker's `structuredOutput` holds the strict `{fixed: boolean, notes: string}` shape it was asked to declare — so a fixer row's `outcome.total` is 2 (check probe + schema probe) and a model's json-fidelity is visible in its score.

Per-verdict metrics F4 (2026-09-21): review-classifier rows carry `probes[]` with the observed verdict per case (null when missing/unparseable — a miss with no predicted bucket) plus `suspiciousBenign: true` when the case's fixture-side `label.json` (beside the thread payload) carries fp_flag `suspicious-benign`; `runner/aggregate.ts` folds these into per-cell `byVerdict` confusion counts, `macroF1`, and `fpRate`/`fpN`. The sidecar read never throws (missing/unreadable sidecars stay unflagged — micro suites carry no labels) and fixer cells keep their exact pre-F4 shape.

## Served ids

The row's `model` is the OBSERVED id the driver reports from the wire (a gateway's silent remap surfaces as data, never silently rewritten); the requested id is only the fallback for lanes that cannot observe it.
