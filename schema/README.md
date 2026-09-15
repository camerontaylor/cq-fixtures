Result-row + per-role comparison-table JSON schemas (plan §3.2; ws-j item 2, field list in plan §8), plus the task-suite schema they score against (ws-j item 3).

- `result-row.schema.json` — one evaluated task case, with the plan §8 field list verbatim
  (`role, suite, model, driver, outcome{score,passed,total}, costUSD, costBasis?, wallTimeMs,
  tokens, runId, timestamp`). One row per case per run; per-role tables aggregate rows.
- `comparison-table.schema.json` — one table per role, one cell per (model, driver) pair.
  Axis 1 (ADR-0001, revised 2026-09-14) fills cells with driver `ai-sdk` across models; axis 2
  fills cells with the fixed served GLM id (`glm-5.3-flash`) across all four drivers
  (`ai-sdk`, `claude-agent`, `subprocess`, `acp`). Cell score is the aggregate passed/total.
- `suite.schema.json` — a suite is a directory of task cases: `{id, fixture, task{prompt}, probe}`
  per case. Probes are discriminated by `kind`: `check-rerun` (re-run a seeded check, reusing the
  toolkit's baselineProbe mechanics) or `expected-verdict` (toolkit `classifyThreads` vocabulary:
  `actionable | responded | resolved | blocked | skip`).

Served-id rule for `model` fields: every `model` id is the id the wire actually served. The eval
wires request the served id (GLM coding wire → `glm-5.3-flash`; anthropic-compat and deepseek keep
their served ids), so the toolkit seam's observed-model check passes green; an observed remap
despite the served id is vendor-behavior documentation, not an eval failure (decision 2026-09-14).

DD-9 null-cost rule: subscription lanes have no per-invocation USD, so `costUSD` may be `null`
(and is always present). When a number is reported, optional `costBasis` (`billed | modeled`,
mirroring the toolkit's `WorkerResult.costBasis`) marks whether it is actual spend or an estimate,
so a modeled number is never silently reported as spend.

Validation: `test/schema.test.ts` compiles all three with ajv draft 2020-12 (`ajv/dist/2020`).
Later goals wire this validation into CI.
