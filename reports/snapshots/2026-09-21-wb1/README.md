<!-- cq-fixtures snapshot header (F6) — machine-read by scripts/snapshot-index.mjs -->
toolkit.lock: 5e5270724df9bf72d7834c4461074f9ab0b62413
suite-sha: ad7d24452b47e26a5820c484025264d9ab400ab6
snapshot-date: 2026-09-21
run-id: 35570311785
<!-- /cq-fixtures snapshot header -->

# Snapshot 2026-09-21 (WB-1 proving run) — full five-cell matrix, run 35570311785

The **WB-1 completion run**: the single `workflow_dispatch` (`profile: full`) that proves the
fixed driver lanes after the toolkit fixes and the runner-side class-token mapping. Dispatched
on `lane/f1b-proving` at head `ad7d244`, toolkit pinned at cq-toolkit main `5e52707`
(package `1.0.1`). A second same-day dispatch exists (`reports/snapshots/2026-09-21/`, the F1
re-run at lock `b06b6a3`); this directory is the later one, distinguished by `run-id` and lock.

Run: <https://github.com/camerontaylor/cq-fixtures/actions/runs/35570311785> — matrix cell jobs
all **success** except acp (see below); overall conclusion `failure` is the acp cell alone, and
the snapshot job still published the surviving cells.

What F1b changed before the run:

- `toolkit.lock` → `5e52707` (cq-toolkit #211 json-schema meta-URI strip, #212 ai-sdk tool-loop
  bound + cause classification, #213 subprocess cause population; issues #208/#209/#210 closed);
- the **runner-side class-token mapping** (`runner/index.ts`): a `stopReason: error` whose cause
  begins with exactly `ai-sdk driver: [structured-output-miss]` publishes an honest DD-4
  scored-miss **row** (outcome 0, passed 0, total 2 for a fixer / 1 for a classifier — a MODEL
  outcome, counted in the tables); every other driver cause (`[endpoint-timeout]`,
  `[provider-error]`, missing, unknown) publishes **no row** — a loud dispatch-only absence
  recorded in `run.json`'s `absences[]`. The workflow's static `skip_roles` pre-skip (the F1
  workaround) is removed; the eval step now renders each absence as a `::warning::` +
  step-summary line + `DISPATCH-ONLY-*` marker, and withholds an empty dispatch-only table from
  the snapshot.

**Honesty rule this snapshot is held to: no cell's zero is a driver error.** A driver-error zero
no longer exists in either direction — a model did not produce parseable structured output
(real scored-miss row), or infrastructure failed and published no row at all (loud absence). The
whole-run check plus its verification script are in "Zero driver-error zeros" below.

## Per-cell verdicts

Denominator is DD-4 probes (a fixer case = 2, a classifier case = 1). `run` count is rows
published; a case with a loud absence has no row and is listed under "Loud absences".

| Cell (model / driver) | Role | Verdict | Evidence (suite: runs, passed/total, costUSD) |
|---|---|---|---|
| glm-5.3-flash / ai-sdk | fixer-worker | **REAL — 34 scored-miss zeros (model) + 11 loud absences** | micro 4, 0/8, 0.002737 · breadth-verified 9, 0/18, 0.005628 · breadth-tail 21, 0/42, 0.015692 |
| glm-5.3-flash / ai-sdk | review-classifier | **REAL** | micro 9/10, 0.001885 · breadth-verified 20/30, 0.008074 · breadth-tail 18/30, 0.007710 |
| deepseek-flash / ai-sdk | fixer-worker | **REAL — 45 scored-miss zeros (model)** | micro 5, 0/10, 0.004135 · breadth-verified 12, 0/24, 0.010367 · breadth-tail 28, 0/56, 0.026659 |
| deepseek-flash / ai-sdk | review-classifier | **REAL** | micro 10/10, 0.001220 · breadth-verified 27/30, 0.002938 · breadth-tail 25/30, 0.004200 |
| glm-5.3-flash / claude-agent | fixer-worker | **REAL scored** (budget-gated tail) | micro 3, 3/6, 0.032042 · breadth-verified 5, 5/10, 0.054711 · breadth-tail 10, 10/20, 0.117639 |
| glm-5.3-flash / claude-agent | review-classifier | **REAL** | micro 9/10, 0.003021 · breadth-verified 27/30, 0.009560 · breadth-tail 25/30, 0.011002 |
| glm-5.3-flash / subprocess | fixer-worker | **REAL scored** (budget-gated tail) | micro 1, 0/2, 0.016728 · breadth-verified 2, 2/4, 0.040234 · breadth-tail 5, 5/10, 0.096982 |
| glm-5.3-flash / subprocess | review-classifier | **REAL** | micro 9/10, 0.023728 · breadth-verified 26/30, 0.087666 · breadth-tail 27/30, 0.091102 |
| glm-5.3-flash / acp | — | **LOUD SKIP, no data** | preflight hard-fail before eval; owner decision pending (installable CI backend vs dispatch-only) |

**Total modeled cost of the published cells: USD 0.675660 as the sum of the 24 committed cell
figures (exact row-level sum USD 0.675658).** Every cell is priced (`costBasis: modeled`); there
is no `costUSD: null` row.

## Observed served ids

Every row's `model` is the id the wire OBSERVED (the served-id rule): `glm-5.3-flash` (270 rows)
and `deepseek-flash` (115 rows). No silent remap is recorded.

## Loud absences (11, all glm-5.3-flash / ai-sdk / fixer-worker)

These cases published **no row**; the cause below is the driver's own bounded text (verbatim in
the run journal and in `run.json`'s `absences[]`). They are endpoint transients now correctly
classified by cq-toolkit #212 — never a fabricated zero. Each cell's `run.json` (carrying the
machine-readable `absences[]`) and `rows.jsonl` (the regrade input) are committed beside its
table, so the omission is machine-validatable and the cell is regrade-able — not just narrated
here.

| Cases | Cause |
|---|---|
| micro-4; breadth-tail bread-13, -18, -26, -28, -34, -36, -40 (8) | `ai-sdk driver: [endpoint-timeout] run failed — Step timeout of 120000ms exceeded` |
| breadth-verified breadth-01, -02, -04 (3) | `ai-sdk driver: [endpoint-timeout] run failed — Failed after 2 attempts. Last error: AI_APICallError: Rate limit reached for requests` |

The runner's lesson is the mapping's whole point: these 11 are infrastructure (no row), while the
34 glm + 45 deepseek misses above are model outcomes (real rows). The same `stopReason: error`
verdict, two honest dispositions.

## Scored-miss rows (model outcome, not infrastructure)

`ai-sdk driver: [structured-output-miss] run failed — No object generated: could not parse the
response.` (deepseek, 45/45 fixer cases) and the glm counterpart (34/45). The model spent real
tokens on the fixer tool loop and never produced a parseable structured object; the persisted
patches are empty (no edits), so both DD-4 probes genuinely fail. This is a **model fidelity**
result on the fixer tool loop, exactly the CQ-3 signal the schema-compliance probe exists to
measure — not a driver error and not an infrastructure absence.

## Budget-gated tails (honest governor stops, not absences)

The subprocess and claude-agent **fixer** suites stopped early on the token cap
(`run-finished` `earlyStopReason: budget`); the governor then refused the remaining cases, which
therefore publish **no row and no absence** (the F1/WB-1.6 honest-stop shape). Dispatched fixer
cases per cell: claude-agent 18/45 (micro 3/5, breadth-verified 5/12, breadth-tail 10/28);
subprocess 8/45 (micro 1/5, breadth-verified 2/12, breadth-tail 5/28). All other suites ran to
completion (10/30/30 classifier cases; ai-sdk fixer 45/45).

Cause: the headless `claude` CLI lanes report large **cache-read** usage per case
(input ~18–45 k, output ~5–7 k, cacheRead ~300–470 k), so the workflow's
`--max-tokens-per-case 60000` cap (per-suite = 60000 × cases) is exhausted after one to five
cases. This is a **fixtures-side cap-sizing gap for the cacheRead-heavy CLI lanes**, not a
driver defect; routed as a follow-up (see the PR body "Deferred to"), not re-sized inside this
one-dispatch proving PR.

## Zero driver-error zeros — the check

Committed and **reproducible offline**: `node scripts/snapshot-mapping-check.mjs
reports/snapshots/2026-09-21-wb1` re-derives the result from the snapshot's own committed
evidence — each cell's `journal/*.ndjson` (the `job-finished` entries), `rows.jsonl`, and
`run.json`'s `absences[]`. For every cell it asserts: (a) every `[structured-output-miss]`
failure has a row whose outcome is exactly 0; (b) every non-miss `failed` failure has NO row and
is in `absences[]`; (c) no absence case has a row; (d) every `ok` job has a row; (e) every
governed stop (`budget-exhausted`, or `indeterminate` carrying the aborted detail) has a row and
is NOT an absence; (f) every materialization refusal has NO row; and (g) a missing journal, a
journal with zero `job-finished` entries, or an unparseable NDJSON line is a problem — so the
check can never pass vacuously. It exits non-zero on any violation. Every cell's raw NDJSON
journal is committed beside its table, and the exact command output is committed as
`mapping-check.txt`. Result across all 4 evaluated cells × 6 suites (24 cells): **rows 385,
problems 0**.

## What is proven vs what is not

- **Proven (WB-1 acceptance, plan §4 WB-1.7):** every cell now emits rows that are either real
  scores or loud dispatch-only absences; the snapshot contains **zero driver-error zeros**. The
  ai-sdk fixer cells are real-scored (model-side misses), and the claude-agent (#211) and
  subprocess (#212/#213 + CI wiring) lanes are **real-scored for both roles** — the two lanes
  that produced 0 tokens on 2026-09-18 now run real model work on CI.
- **NOT met — WB-1.1's "green real-scored fixer cell":** no ai-sdk fixer cell is green. glm and
  deepseek both fail the fixer tool loop's mandatory structured output
  (`[structured-output-miss]`), which the class-token contract defines as a MODEL outcome; the
  residual glm endpoint timeouts/rate limits are loud absences. The honest disposition and the
  re-diagnosis are in `triage-addendum.md`.
- **Thin but real — the CLI fixer cells:** claude-agent and subprocess fixer scores (0.5) rest
  on 18 and 8 dispatched cases respectively (budget-gated tails), so they are real scored
  evidence at reduced n, not full-suite results.
- **Not exercised:** the acp lane (no CI backend, preflight hard-fail; owner decision pending)
  and the subprocess lane's populated-cause channel (#213) — no subprocess driver *error*
  occurred this run, so its cause text was not surfaced (its micro fixer case is a
  `budget-exhausted` row, an honest governor outcome).

## Interim toolkit pin (why the lock is a SHA, not a version)

`toolkit.lock` pins the commit `5e52707` — post-v1.0.0 `main` after cq-toolkit #211/#212/#213,
package version `1.0.1`. It is a **commit SHA, not an npm version, because npm publish of `1.0.1`
is owner-gated**: the fixtures flip PR cannot exist pre-publish. `scripts/flip-to-published.sh`
replaces this pin with the published version after the owner publishes; until then the cost
columns above are computed from the tarball build of that SHA (packed by `scripts/pack-toolkit.sh`,
SHA path) and `costBasis: modeled` is API-equivalent list price, never billed USD (DD-9).

## CQ-5 delta (b06b6a3 → 5e52707)

The generated index (`reports/snapshots/README.md`) carries the per-cell delta section. What
moved between the F1 snapshot (lock `b06b6a3`, only two real classifier-micro cells) and this one
(lock `5e52707`, 24 real cells):

- **lane fixes landed:** the ai-sdk fixer roles moved from *dispatch-only absence* to *real
  scored-miss rows*; the claude-agent and subprocess lanes moved from *dispatch-only absence* to
  *real-scored cells for both roles*.
- **classifier micro:** glm-5.3-flash/ai-sdk 0.8000 → 0.9000 (+0.1000); deepseek-flash/ai-sdk
  1.0000 → 1.0000 (0.0000). Every other cell is new (the F1 snapshot carried only the two
  classifier-micro tables).

## Schema

Every published table conforms to `schema/comparison-table.schema.json` (validated in the runner
before emission; the snapshot job copies `*.table.json` verbatim). Each of the 24 published cells
ships its table **plus** `run.json` (the F6 manifest: role/suite/model/driver/variant,
`toolkit.lock`, `suiteSha`, `runId`, and the `absences[]` records) and `rows.jsonl` (the F6
regrade input) plus its raw `journal/*.ndjson` beside it — 99 committed files (24 tables + 24
`run.json` + 24 `rows.jsonl` + 24 journals + this README + `triage-addendum.md` +
`mapping-check.txt`), a superset of what the automatic snapshot job copies (journals included so
the mapping check is offline-reproducible).
