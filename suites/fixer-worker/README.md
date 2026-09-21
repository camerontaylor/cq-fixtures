Seeded-fault task suites for the fixer-worker role: one directory of task cases, each case = {fixture ref, fault spec, scoring probe} (plan §3.2; ws-j item 3).

`micro/` is the populated suite (phase-3 J3, 2026-09-16): five hand-seeded synthetic cases
(micro-1..micro-5), each a one-line behavior mutation in a zero-dependency TypeScript package
under `fixtures/micro-{1..5}/`. The per-fixture fault manifest lives in `micro/PROVENANCE.md`;
the fixed reference implementations are embedded only in this repo's own test harness
(`test/micro.test.ts`), deliberately NOT shipped as repo files so an eval worker cannot read
the answers. Scoring re-runs each case's `check.mjs`
judge — a vitest run against the case's materialized workspace copy. The decided judge contract
(Node script, immutable from the repo root, cwd = the workspace, no relative requires) and the
fake-smoke `--driver-name subprocess` labeling decision are recorded in `suites/README.md`.

`breadth-verified/` and `breadth-tail/` are the F3 corpus (2026-09-21), ids `breadth-01..40`
(never renumbered): 40 cases total, 16 easy / 16 medium / 8 hard, 24 operator-catalog / 12
LM-injected / 4 diff-replay. `breadth-verified` is the 12-case human-reviewed tier (every fault
independently reproduced from `FAULT.json` alone — see `breadth-verified/REPRODUCTION.md`) and
runs the full filter chain in CI; `breadth-tail` is the 28-case generated tail with both-states
CI. Each case's authoritative record is the sibling file `fixtures/breadth-NN.FAULT.json`
(outside the materialized tree — it carries the canonical fix). The 30 F3 cases are generated
deterministically from `catalog/substrates/` by `catalog/generate-cases.ts`; the runnable filter
chain is `catalog/pipeline.ts`. The plan's `profile: verified|full` dispatch input selects the
weekly matrix roots (F3). The verified tier's ≤ 20 min serial per cell is a **projection**
(digest ~90 s/case), re-baselined by F1.
