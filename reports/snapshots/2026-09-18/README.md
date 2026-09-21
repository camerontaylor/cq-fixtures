<!-- cq-fixtures snapshot header (F6) — machine-read by scripts/snapshot-index.mjs -->
toolkit.lock: phase-3-done
suite-sha: 1f397857ca5562718441d6e5aa276306b05363f9
snapshot-date: 2026-09-18
run-id: 35392822013
<!-- /cq-fixtures snapshot header -->

# Snapshot 2026-09-18 — first live J5 real-driver matrix (run 35392822013)

First real-driver run of the five-cell axes matrix (ADR-0001 as revised 2026-09-14), dispatched
manually at J5 (`workflow_dispatch` on main after PR #13). Read the "What is proven" section
before the numbers: NONE of this run's zeros are model outcomes.

| Cell (model / driver) | Role | Probes passed/total | What actually happened |
|---|---|---|---|
| glm-5.3-flash / ai-sdk | review-classifier | 7/10 | REAL scored run: tokens in 4530 / out 3226; per-case verdicts graded against the expected vocabulary |
| glm-5.3-flash / ai-sdk | fixer-worker | 0/10 | every case ended `driver stopReason: error` AFTER real token spend (in 5304 / out 1542, wall ~165s) — driver-error zeros, not a "model failed to fix" outcome |
| deepseek-chat / ai-sdk | review-classifier | 9/10 | REAL scored run; rows carry the OBSERVED served id **`deepseek-flash`**, not the requested `deepseek-chat` — costUSD null per DD-9 (no price entry for the observed id) |
| deepseek-chat / ai-sdk | fixer-worker | 0/10 | every case `driver stopReason: error` after real token spend (in 8088 / out 2003); rows observed `deepseek-chat` and are priced $0.004285 (modeled) |
| glm-5.3-flash / claude-agent | both | 0/20 | every case `driver stopReason: error`, 0 tokens — lane-level driver failure on CI; honest zeros |
| glm-5.3-flash / subprocess | both | 0/20 | 0 tokens, ~7.2s wall combined — the headless CLI produced no model output on CI; honest zeros |
| glm-5.3-flash / acp | — | no data | preflight hard-failed (rc 4, "backend dead") — CI cannot run the acp harness yet; loud, never published as data |

Denominator is probes, not rows: a fixer-worker row carries 2 probes (seeded check-rerun + schema-compliance) and a classifier row carries 1, so e.g. fixer `0/10` aggregates 5 rows and a `both` cell sums both roles' probes.

## What is proven vs what is not

- Proven (DoD 5 mechanism): the full pipeline — suite discovery, real dispatch, DD-4 per-role
  schemas, scoring, schema-validated rows/tables, NDJSON journals, per-cell artifacts, snapshot
  publication — ran end-to-end in CI with real drivers, and both per-role tables were emitted per
  live cell.
- Real scored model evidence this run: the two classifier cells (glm 7/10, deepseek 9/10). Note
  the deepseek observation is PER-CELL: the classifier rows observed `deepseek-flash` (unpriced →
  null cost) while the fixer rows observed the requested `deepseek-chat` (priced, modeled) — the
  remap was not endpoint-wide, which is exactly why the observed-model rule records per-row ids.
- NOT model outcomes: every fixer cell's zeros (all cases ended in driver `stopReason: error` —
  an infrastructure/driver failure after spend on the ai-sdk cells), and the entire
  claude-agent / subprocess axes (0 tokens). Follow-up work: ai-sdk fixer driver-error triage,
  headless CLI configuration for the subprocess lane, the agent-SDK peer's CI failure for
  claude-agent, and an installable acp backend (owner action tracked alongside the spend-capped
  eval key in PR #13).
- The matrix job itself is red on this run (the acp cell's loud infrastructure failure) while the
  snapshot published the surviving cells via the merge-not-clear degraded path — both behaviors
  are the designed honesty rules (PR #13).

Schema: every table above conforms to `schema/comparison-table.schema.json` (validated in the
runner before emission; formally re-validated against the schema in review; the snapshot job
copies `*.table.json` verbatim).
