# Provenance — suites/fixer-worker/breadth

## Authorship

Synthetic, catalog-built content produced by the F2 lane of the cq-fixtures
build-out run, 2026-09-21. Every case is a zero-dependency multi-module
TypeScript package under `fixtures/breadth-NN/`; nothing is copied or adapted
from an external corpus. The 24-operator vocabulary and its `bug_type` /
difficulty metadata live in `catalog/operators.ts` (R6 digest §7); the engines
(`@stryker-mutator/instrumenter`, `ts-morph`) are devDependencies and are
mutant GENERATORS only — the repo's judge is the scorer.

## Tier mix (plan WB-2.4)

| Tier | Cases | Count |
| --- | --- | --- |
| easy | breadth-01 … breadth-04 | 4 |
| medium | breadth-05 … breadth-08 | 4 |
| hard | breadth-09 … breadth-10 | 2 |

The plan's full-corpus target is 16 easy / 16 medium / 8 hard (F3); F2 seeds a
10-case slice at the same 4:4:2 proportion.

## Generation mix (plan WB-2.4)

| Origin | Cases | Count |
| --- | --- | --- |
| `operator-catalog` | 01, 02, 05, 06, 09, 10 | 6 |
| `lm-injected` (lane leader, no external model dispatch) | 03, 04, 07 | 3 |
| `diff-replay` (fixture git history) | 08 | 1 |

## Case table

| Case | Tier | Operator(s) | bug_type | Fault |
| --- | --- | --- | --- | --- |
| breadth-01 | easy | arithmetic-swap | operator misuse | rectangle area multiplies as `+` |
| breadth-02 | easy | equality-boundary | operator misuse | last-page test uses `>` not `>=` |
| breadth-03 | easy | ternary-swap | operator misuse | membership discount arms swapped |
| breadth-04 | easy | constant-delta (trivial-prone) | value misuse | backoff factor 3 instead of 2 |
| breadth-05 | medium | method-swap | function misuse | `every` becomes `some` |
| breadth-06 | medium | remove-assignment | missing logic | cache write dropped |
| breadth-07 | medium | default-param-removal | value misuse | retries default removed |
| breadth-08 | medium | non-null-overreach | function misuse | `?.` becomes `!` |
| breadth-09 | hard | shared-reference-return + logical-swap | variable misuse | live stock returned; `&&` becomes `\|\|` |
| breadth-10 | hard | radix-coercion-drop + argument-swap | value misuse | radix dropped; range arguments swapped |

`trivial-prone` operators (constant ±1, remove loop, empty block/arrow) are
restricted to the easy tier and excluded from discrimination scoring
(`catalog/operators.ts`; plan WB-2.2). Only breadth-04 uses one.

## Validation-filter evidence (R6 digest §2)

Each case's authoritative record is `fixtures/breadth-NN.FAULT.json` — a
sibling FILE, outside the materialized fixture directory, so the runner's
`cpSync(join(repoRoot, c.fixture), workspace)` never copies it. The record
carries the canonical fix (`validation.fix`), the F2P/P2P test titles, the
single-statement-deletion adequacy target, and the adversarial tell audit.

`test/breadth.test.ts` runs the filter chain for every case: static schema +
catalog checks, a materialization reachability guard (the canonical fix is not
readable from the worker workspace), F2P (stored fault is red), the
100%-green baseline (canonical fix is green), determinism ×3 in both states,
and the single-statement-deletion adequacy check. The static typecheck gate is
the repo's own `npm run typecheck`, which includes `fixtures/**/*.ts`; the
faults are runtime logic only (no type-error operator class in v1).

The `tell_audit` rows are honest: cases 07, 08, and 09 are marked `told` (a
reader who sees the one-token diff can name the mutation) and breadth-10 is
`not-told`. They stay in the corpus because the tier measures locating and
repairing the fault in a multi-module package, not concealment; the
per-operator tell rate is recorded rather than hidden (digest §2, SWE-Mutation
down-weighting is F3's scoring step).

## Contamination posture

No public-benchmark instances are included or adapted. The HumanEvalFix
`bug_type` enum is copied (MIT); no HumanEvalPack instances are vendored. The
SWE-smith operator list is a strategy reference only — its Python modifiers are
not ported and no code is vendored. StrykerJS (Apache-2.0), ts-morph (MIT) and
Babel (MIT) are devDependencies, used as generators, never shipped into a
worker workspace.
