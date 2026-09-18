# Snapshot 2026-09-18 — first live J5 real-driver matrix (run 35392822013)

First real-driver run of the five-cell axes matrix (ADR-0001 as revised 2026-09-14), dispatched
manually at J5 (`workflow_dispatch` on main after PR #13). Cells and outcomes:

| Cell (model / driver) | Role | Scored | Outcome |
|---|---|---|---|
| glm-5.3-flash / ai-sdk | review-classifier | 7/10 | live model data (tokens in 4530 / out 3226) |
| glm-5.3-flash / ai-sdk | fixer-worker | 0/10 | live model data (tokens in 5304 / out 1542) — real runs, fixes failed |
| deepseek-chat / ai-sdk | review-classifier | 9/10 | live; **observed model `deepseek-flash`, not the requested `deepseek-chat`** (see below) |
| deepseek-chat / ai-sdk | fixer-worker | 0/10 | live, priced $0.004285 (modeled) — real runs, fixes failed |
| glm-5.3-flash / claude-agent | both | 0/20 | **driver stopReason: error on every case** — lane-level driver failure on CI, honest zeros |
| glm-5.3-flash / subprocess | both | 0/30 | **0 tokens, ~3s wall** — the headless CLI produced no model output on CI; honest zeros |
| glm-5.3-flash / acp | — | no data | preflight hard-failed (rc 4, "backend dead") — CI cannot run the acp harness yet; loud, never published as data |

## What is proven vs what is not

- Proven (DoD 5 mechanism): the full pipeline — suite discovery, real dispatch, DD-4 per-role
  schemas, scoring, schema-validated rows/tables, NDJSON journals, per-cell artifacts, snapshot
  publication — ran end-to-end in CI with real drivers, and both per-role tables were emitted per
  live cell.
- Model axis: REAL scored evidence on both models (classifier 7/10 glm, 9/10 deepseek; both
  fixers 0/10 — the micro fixer faults were not fixed by either model this run).
- Driver axis: claude-agent / subprocess / acp did NOT produce model data in CI yet. The zeros
  are infrastructure-shaped (driver errors / no tokens), not model behavior, and must not be read
  as eval outcomes. Follow-up work: headless CLI configuration for the subprocess lane, the
  agent-SDK peer's CI failure for claude-agent, and an installable acp backend (owner action
  tracked alongside the spend-capped eval key in PR #13).
- Observed-model defence working: the deepseek classifier cell's rows carry the OBSERVED served
  id `deepseek-flash` — the endpoint did not serve the requested `deepseek-chat`. Per DD-9 the
  cell's costUSD is null (no price entry for the observed id) rather than a fabricated number;
  the price-map gap is upstream (WS-B/DD-2).
- The matrix job itself is red on this run (the acp cell's loud infrastructure failure) while the
  snapshot published the surviving cells via the merge-not-clear degraded path — both behaviors
  are the designed honesty rules (PR #13).

Schema: every table above conforms to `schema/comparison-table.schema.json` (validated in the
runner before emission; the snapshot job copies `*.table.json` verbatim).
