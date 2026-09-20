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

`breadth/` is the F2 catalog-built seed (2026-09-21): 10 cases (4 easy / 4 medium / 2 hard)
whose faults come from the 24-operator catalog in `catalog/operators.ts`. Each case's
authoritative record is the sibling file `fixtures/breadth-NN.FAULT.json` (outside the
materialized tree — it carries the canonical fix); see `breadth/PROVENANCE.md` for the mixes and
`test/breadth.test.ts` for the validation-filter chain. The plan's full `breadth-verified` (12)
and `breadth-tail` (28) suites are F3's build, extending this seed to the 16/16/8 tier mix.
