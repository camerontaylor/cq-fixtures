# Provenance — suites/fixer-worker/breadth-verified

## Authorship

The 12 human-reviewed, independently reproduced cases (plan WB-2.5). breadth-01..10 are the F2 seed (hand-authored, 2026-09-21); breadth-11..12 are generated from `catalog/substrates/textkit`. Every case is a zero-dependency multi-module TypeScript package; nothing is copied or adapted from an external corpus.

## Tier mix

| Tier | Cases | Count |
| --- | --- | --- |
| easy | 01-04, 11-12 | 6 |
| medium | 05-08 | 4 |
| hard | 09-10 | 2 |

## Case table

| Case | Tier | Operator(s) | bug_type | Origin | Fault |
| --- | --- | --- | --- | --- | --- |
| breadth-01 | easy | `arithmetic-swap` | operator misuse | operator-catalog | Rectangle area comes out as width plus height, so a 3x4 rectangle reports 7 square metres instead of 12. |
| breadth-02 | easy | `equality-boundary` | operator misuse | operator-catalog | The final page is never reported as the last page; a three-page document says page index 2 is not final. |
| breadth-03 | easy | `ternary-swap` | operator misuse | lm-injected | Members are charged the full price and non-members get the ten-percent discount; the membership branch is inverted. |
| breadth-04 | easy | `constant-delta` | value misuse | lm-injected | Backoff delays grow threefold per attempt instead of doubling, so the third retry waits 2700ms rather than 800ms. |
| breadth-05 | medium | `method-swap` | function misuse | operator-catalog | allInStock reports true as soon as a single item is in stock, so a catalog with an out-of-stock row still reads as fully stocked. |
| breadth-06 | medium | `remove-assignment` | missing logic | operator-catalog | The memoizer recomputes every call: two calls with the same argument run the expensive function twice instead of once. |
| breadth-07 | medium | `default-param-removal` | value misuse | lm-injected | withDefaults leaves retries undefined when the caller omits it, instead of defaulting to three. |
| breadth-08 | medium | `non-null-overreach` | function misuse | diff-replay | Looking up the city of a missing profile throws a TypeError instead of reporting unknown. |
| breadth-09 | hard | `shared-reference-return+logical-swap` | variable misuse | operator-catalog | Two independent faults: snapshot() hands out the live internal stock array (a caller's push leaks back in), and an order that is paid but not shipped already reads as complete. |
| breadth-10 | hard | `radix-coercion-drop+argument-swap` | value misuse | operator-catalog | Two independent faults: amounts are parsed without a radix (so '0x10' becomes 16), and range labels print the bounds reversed ('range 7-3' for rangeLabel(3, 7)). |
| breadth-11 | easy | `equality-boundary` | operator misuse | operator-catalog | truncate returns a shortened string even when the text already fits the limit. |
| breadth-12 | easy | `method-swap` | function misuse | operator-catalog | toKebabCase returns uppercase letters instead of a lowercase slug. |

## Reproduction

Every verified fault is independently reproduced from FAULT.json alone by a second author pass (buggy→red, fix→green, annotation confirmed); the per-case record and the agreement tally (tier κ ≥ 0.80 target) are in `REPRODUCTION.md`.

## Validation-filter evidence (R6 digest §2)

Every case's authoritative record is the sibling file `fixtures/<id>.FAULT.json` (outside the materialized fixture directory; it carries the canonical fix). `catalog/pipeline.ts` is the runnable filter chain: static annotation gate (FAULT.json schema/catalog rules, exact declared `it()` titles, fix present and faulted-different, adequacy target present) → reachability gate (a materialized worker workspace cannot reach the record or its fix) → F2P gate (stored faulted state red) → 100%-green baseline (canonical fix green) → determinism ×3 both states → per-title F2P/P2P via the vitest JSON reporter → P2P adequacy (single-statement deletion red) → format/tell pass (the diff is operator-sized and carries no operator signature). The static typecheck gate is the repo's own `npm run typecheck` (it includes `fixtures/**/*.ts`); type-error faults are excluded in v1.

The 30 F3 cases (breadth-11..40) are generated deterministically from `catalog/substrates/` by `catalog/generate-cases.ts` (`--check` proves the committed corpus still matches the recipes). The F2 seed cases (breadth-01..10) are hand-authored and carried forward with unchanged ids.

## Contamination posture

No public-benchmark instances are included or adapted. The HumanEvalFix `bug_type` enum is copied (MIT); no HumanEvalPack instances are vendored. The SWE-smith operator list is a strategy reference only. StrykerJS (Apache-2.0), ts-morph (MIT), and Babel (MIT) are devDependencies used as generators, never shipped into a worker workspace.

## Runtime projection

The verified tier's ≤ 20 min serial per cell is a **projection** at the digest's ~90 s/case assumption, not a measurement — F1 re-baselines it once a real fixer cell produces outcomes.
