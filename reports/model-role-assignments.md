# Model-role assignment log

Spec Ontology row "Model-role assignment" made real: the fixtures repo is the evidence source for
which model fills which toolkit role. This file is the CHANGE LOG for that decision — a role's
default model/provider is only changed by adding a row here, and every row MUST cite the snapshot
that justifies it.

## Format

A row is appended whenever a toolkit role default changes (or is re-affirmed after a fresh
snapshot). Each row carries:

- **Role** — the toolkit role (`fixer-worker`, `review-classifier`).
- **Current default** — `<model> / <provider> / <driver>` as bound by the toolkit config.
- **Evidence snapshot** — the `reports/snapshots/<date>/` whose tables the decision reads.
- **Observed** — the per-cell score with its denominator `n` (probes). At `n >= 30` the cell's
  `scoreCI` (Wilson, 95%) MUST be quoted too; below `n` the row says so — a small-`n` lead is not
  a decision.
- **Decision** — hold / change, and the reason.
- **Date** — when the row was added.

Invariant: a row that changes a default cites a snapshot in which the challenger beats the
incumbent by more than the quoted interval overlap — a point-estimate lead inside the noise does
not move a default.

## Current defaults and their evidence

| Role | Current default (model/provider/driver) | Evidence snapshot | Observed | Decision | Date |
|---|---|---|---|---|---|
| fixer-worker | `glm-5.3-flash` / `zai` / `ai-sdk` (cq-toolkit `src/selfhost/config.ts` `SelfhostDefaults.driver`, commit `c4b1253`) | `reports/snapshots/2026-09-18` | No real model outcome: every fixer cell ended `driver stopReason: error` (honest zeros, not a fixing result), so `n = 0` gradeable probes | Hold — no evidence exists yet to change the default | 2026-09-21 |
| review-classifier | `glm-5.3-flash` / `zai` / `ai-sdk` (same `SelfhostDefaults.driver`) | `reports/snapshots/2026-09-18` | ai-sdk classifier cells: `glm-5.3-flash` 7/10 (`0.70`, `n = 10`); `deepseek-flash` (observed served id for the `deepseek-chat` request) 9/10 (`0.90`, `n = 10`) | Hold — the `deepseek-flash` lead is a point estimate at `n = 10`, far below the `n >= 30` floor at which this log accepts a Wilson-interval comparison; revisit when a breadth snapshot gives each classifier cell `n >= 30` | 2026-09-21 |

## Why the `n >= 30` floor

A role default is a standing decision across every future run, so it is changed on interval
evidence, not on a single snapshot's point estimate. The 2026-09-18 classifier gap (7/10 vs 9/10)
is one case wide; at `n = 10` the Wilson intervals overlap heavily. The `scoreCI` field that
`aggregate.ts` emits at `n >= 30` (F6/WB-5.2c) is the field a future row quotes to move this
default. Until a snapshot carries it, every row above is a "hold".
