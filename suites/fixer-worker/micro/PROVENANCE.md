# Provenance — suites/fixer-worker/micro

## Authorship

Hand-written synthetic content produced by the phase-3 lane-J run, 2026-09-16. The five cases
and their fixtures were authored for this repo in this run; nothing was copied from an external
corpus.

## Contamination posture

No public-benchmark instances are included or adapted. Each fault is a fresh one-line mutation
of a trivial reference implementation written for this suite (`fixtures/micro-{1..5}/src/`), and
each fixture package is a zero-dependency synthetic TS package. The task prompts describe the
wrong BEHAVIOR only — they never name the mutated line, so a worker must diagnose from the
failing vitest suite. The fixed reference implementations are embedded ONLY in this repo's own
test harness (`test/micro.test.ts`, a `SOLUTIONS` map) and are deliberately NOT shipped as repo
files (Codex P1): a real eval worker holds read tools over the repo checkout, so an on-disk
answer key (the former `fixtures/solutions/`) would be readable and copyable — not
materializing it into the workspace hides nothing from a reader.

## Fault manifest (one line per fixture)

| Case | Fixture file | Seeded fault |
| --- | --- | --- |
| micro-1 | `fixtures/micro-1/src/rangeSum.ts` | loop bound `i < b` excludes `b` from an inclusive range sum |
| micro-2 | `fixtures/micro-2/src/slugify.ts` | missing `.toLowerCase()` before hyphen-joining slug words |
| micro-3 | `fixtures/micro-3/src/memoize.ts` | memoized result never written to the cache, so every call recomputes |
| micro-4 | `fixtures/micro-4/src/parseConfig.ts` | malformed JSON returns `{}` instead of throwing `Error('invalid config')` |
| micro-5 | `fixtures/micro-5/src/sortTasks.ts` | comparator sorts priority ascending instead of descending |
