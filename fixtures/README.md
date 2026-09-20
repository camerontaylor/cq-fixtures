Small target repos used by the suites — one directory per fixture, synthetic by construction (plan §3.2; ws-j item 1).
Sourcing at scale is R6's deliverable, not this repo's; what lands here now is the phase-3 (J3) micro-fixture set.

## Micro fixtures (`micro-{1..5}`)

Five tiny SYNTHETIC zero-dependency TypeScript packages, one seeded fault each (phase-3 J3,
2026-09-16), graded by the `suites/fixer-worker/micro` suite. Each package has the same layout:

- `package.json` — `{ "name": "micro-N", "private": true, "version": "0.0.0", "type": "module" }`.
- `src/<module>.ts` — the module carrying exactly ONE seeded fault: a small behavior mutation a
  competent worker can fix from the failing tests alone.
- `test/<module>.test.ts` — a vitest suite that FAILS on the pristine (faulted) package and
  PASSES once the fault is fixed. These suites are excluded from the repo's own `npm test`
  (`vitest.config.ts`): they are red by design and are only ever graded inside a materialized
  workspace copy.
- `check.mjs` — a thin shim over the shared immutable judge,
  `fixtures/judge-lib.mjs` (which lives at the fixtures/ level and is never
  materialized into a workspace; the shim only identifies which fixture it
  judges, resolving the pristine fixture dir and repo root from the shim's
  own URL). The judge re-runs the fixture's vitest suite against the
  workspace under judgment (`node <repo vitest> run --root <cwd> --config
  fixtures/judge.vitest.config.mjs`) and fails closed — exit 1, never pass —
  on: misuse (cwd containing the pristine fixture), a graded-tree escape
  (every non-directory entry must realpath-resolve inside the workspace; the
  worker owns the tree and may plant symlinks), a missing restore target, or
  a spawn failure. Before every run it restores the PRISTINE `test/` into
  the workspace (the tests are part of the judge), scrubs worker-planted
  `vitest.config.*` / `vite.config.*` from the workspace root, and the
  explicit judge config disables discovery entirely (include pinned to the
  restored `test/**/*.test.ts`, `passWithNoTests: false` so a broken restore
  fails). Diagnostics are forwarded; the final status is set via
  `process.exitCode` so piped output always flushes.

## Reference fixes (embedded in the harness — the real posture, no hiding)

The five fixed reference sources live as embedded strings in `test/micro.test.ts` (a
`SOLUTIONS` map; the former on-disk `fixtures/solutions/` was removed, Codex P1). They are IN
the tree, not hidden: a worker that can read the repo checkout CAN find them. What keeps the
key out of play today is the dispatched worker surface, not file hiding — today's toolkit
lanes confine read/edit to the materialized workspace and run to an empty default allowlist,
so the key is unreachable by the surface this repo actually dispatches today. The residual
exposure for phase-4 fixer cells (host-privileged run tools, first-party prompts) is already
recorded in `.github/workflows/suite.yml`'s ACCEPTED-RISK block and joins that class. The
discrimination test overwrites the faulted file with the embedded fix in its tmp workspace
copy and asserts the judge now passes.

## Thread payloads (`threads/`)

`threads/thread-{01..10}.json` are fictional, recorded-SHAPE review threads for the
`suites/review-classifier/micro` suite (GitHub review-thread shape: `id`, `path`, `line`,
`resolved`, `comments[]` with `author`/`body`/`createdAt`/`isReply`). Two payloads per expected
verdict (`actionable`, `responded`, `resolved`, `blocked`, `skip`); the payload-to-verdict
mapping is tabled in `suites/review-classifier/micro/PROVENANCE.md`.

## Breadth fixtures (`breadth-{01..10}`)

Ten synthetic zero-dependency multi-module TypeScript packages (F2, 2026-09-21), one catalog-built
fault each except the two hard cases (two combined faults each), graded by the
`suites/fixer-worker/breadth` suite. Each package has 3-5 `src/` files, 1-3 `test/` files and a
`check.mjs` shim over `fixtures/judge-lib.mjs` (same immutable-judge contract as the micro
fixtures).

The authoritative per-fault record is `fixtures/breadth-NN.FAULT.json` — a SIBLING FILE, never
inside the fixture directory. It is HumanEvalFix-shaped (`bug_type`, `failure_symptoms`,
`operator`, `difficulty`, `provenance`, `validation{f2p,p2p,fix}`) and carries the canonical fix,
so it must stay outside the tree the runner materializes into a worker workspace; the runner
copies only `fixtures/<name>/` (`runner/index.ts`), and `test/breadth.test.ts` proves the record
is unreachable from that workspace. See `suites/fixer-worker/breadth/PROVENANCE.md` for the tier
and generation mixes.
