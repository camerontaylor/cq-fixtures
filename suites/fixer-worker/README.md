Seeded-fault task suites for the fixer-worker role: one directory of task cases, each case = {fixture ref, fault spec, scoring probe} (plan §3.2; ws-j item 3).

`micro/` is the populated suite (phase-3 J3, 2026-09-16): five hand-seeded synthetic cases
(micro-1..micro-5), each a one-line behavior mutation in a zero-dependency TypeScript package
under `fixtures/micro-{1..5}/`. The per-fixture fault manifest lives in `micro/PROVENANCE.md`;
the fixed reference copies used only by this repo's own tests live under `fixtures/solutions/`
and are never materialized into a worker workspace. Scoring re-runs each case's `check.mjs`
judge — a vitest run against the case's materialized workspace copy. The decided judge contract
(Node script, immutable from the repo root, cwd = the workspace, no relative requires) and the
fake-smoke `--driver-name subprocess` labeling decision are recorded in `suites/README.md`.
