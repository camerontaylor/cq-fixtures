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
- `check.mjs` — the immutable judge (the decided probe contract in `suites/README.md`): it
  resolves from the repo root, locates the repo's `node_modules/vitest/vitest.mjs`, and re-runs
  the suite against the workspace under judgment via
  `spawnSync(process.execPath, [vitest, 'run', '--root', process.cwd()])`, exiting with the
  child's status.

## Fixed reference copies (`solutions/`)

`fixtures/solutions/micro-{1..5}/` holds ONLY the fixed version of each faulted `src/` file,
at the same relative path as in the fixture. These copies exist for the repo's own tests
(`test/micro.test.ts`): after asserting the pristine workspace FAILS the judge, a test
overwrites the faulted file with the solution copy and asserts the workspace now PASSES. The
`solutions/` dir is never referenced by any `suite.json` and is never materialized into a
worker workspace — a worker is graded on the fix it produces, not on a diff against a hidden
answer.

## Thread payloads (`threads/`)

`threads/thread-{01..10}.json` are fictional, recorded-SHAPE review threads for the
`suites/review-classifier/micro` suite (GitHub review-thread shape: `id`, `path`, `line`,
`resolved`, `comments[]` with `author`/`body`/`createdAt`/`isReply`). Two payloads per expected
verdict (`actionable`, `responded`, `resolved`, `blocked`, `skip`); the payload-to-verdict
mapping is tabled in `suites/review-classifier/micro/PROVENANCE.md`.
