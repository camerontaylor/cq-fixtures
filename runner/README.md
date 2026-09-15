Thin-custom eval runner — the R7 null hypothesis (plan §3.2; DECISIONS.md): before adopting a framework (evalite/promptfoo/Inspect), dogfood the toolkit's own ops and see how far plain data plus one execution seam gets. R7 decides later whether a framework replaces or wraps this; the runner is built regardless.

## What it dogfoods (public package surface only)

- `Driver.run(OpInvocation)` — execution. The driver is INJECTED (`runSuite` takes one; the CLI builds it from `--driver`), so adding a case is a suite.json edit and swapping lanes is a flag — no runner change (the conformance property, pinned by `test/runner.test.ts`).
- `BudgetGovernor` + `governorConfig` — the run's USD/token caps: admission gate per case, usage/cost rollup per result, fail-loud trip (an unpriced model under `--max-usd` gates the run rather than running unbounded). A tripped cap emits NO rows for refused cases — the honest stop lives on the journal's `run-finished` event and the nonzero exit.
- `openRunLog` — the NDJSON journal: `run-started` / `job-started` / `job-finished` / `run-finished` events, one file per run.
- `computeCostUSD` / `priceOf` — DD-9 cost: derived ONLY from the price map over observed usage; `null` when the served model has no price (a subscription lane never gets an invented number), `costBasis: "modeled"` when derived.

The boundary is enforced by `test/boundary.test.ts`: runner code and `scripts/pack-toolkit.sh` consume ONLY the bare `@camerontaylor/cq-toolkit` specifier — never a `src`/`dist` deep import, never a relative escape into a vendored tree.

## CLI

```
node --experimental-strip-types runner/index.ts \
  --suite <dir> --driver fake --driver-name <lane> \
  --model <served-id> --provider <handle> --max-usd 1 --out <dir>
```

Node >= 23.6 runs the TypeScript directly (type stripping); CI uses node 24. `--suite` is repeatable; other flags: `--max-tokens`, `--check-timeout-ms`, `--journal <dir>`. `--driver fake` is the deterministic offline stand-in for plumbing smoke/CI — rows must be labeled with the lane it impersonates via `--driver-name` (the row schema's driver enum only accepts the four toolkit lanes); `--driver ai-sdk` builds the toolkit's `AiSdkDriver` with production defaults and is never the default. Exit codes: 0 clean, 1 any case scored 0 / validation failure / budget-gated run, 2 usage error.

## Scoring contract

Per-role scorers live in `runner/score/`: `check-rerun` (fixer-worker) re-runs the seeded check with cwd set to the fixture workspace — the worker's answer does not influence the probe, re-running the check IS the contract; `expected-verdict` (review-classifier) compares the classifier's `structuredOutput.verdict` against the suite's expected value from the toolkit's classifyThreads vocabulary (actionable | responded | resolved | blocked | skip). A probe that cannot execute scores 0 with diagnostics and never aborts the run.

## Served ids

The row's `model` is the OBSERVED id the driver reports from the wire (a gateway's silent remap surfaces as data, never silently rewritten); the requested id is only the fallback for lanes that cannot observe it.
