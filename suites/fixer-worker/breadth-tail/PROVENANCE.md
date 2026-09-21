# Provenance — suites/fixer-worker/breadth-tail

## Authorship

The 28-case long tail (plan WB-2.5). Generated deterministically from six clean substrates (`catalog/substrates/{textkit,ledger,schedule,graph,validate,queue}`) by `catalog/generate-cases.ts`; no public-benchmark content.

## Tier mix

| Tier | Cases | Count |
| --- | --- | --- |
| easy | 16-17, 21-22, 26-27, 31-32, 36-37 | 10 |
| medium | 13-14, 18-19, 23-24, 28-29, 33-34, 38-39 | 12 |
| hard | 15, 20, 25, 30, 35, 40 | 6 |

## Case table

| Case | Tier | Operator(s) | bug_type | Origin | Fault |
| --- | --- | --- | --- | --- | --- |
| breadth-13 | medium | `arithmetic-swap` | operator misuse | operator-catalog | averageWordLength returns a value far larger than the average word length. |
| breadth-14 | medium | `chain-break` | operator misuse | lm-injected | wordCount counts surrounding whitespace as extra words. |
| breadth-15 | hard | `method-swap+equality-boundary` | function misuse | lm-injected | toKebabCase returns uppercase letters, and truncate shortens text that already fits the limit. |
| breadth-16 | easy | `equality-boundary` | operator misuse | operator-catalog | isOverdrawn reports a zero balance as overdrawn. |
| breadth-17 | easy | `constant-delta` | value misuse | operator-catalog | formatCents divides the amount by the wrong factor. |
| breadth-18 | medium | `arithmetic-swap` | operator misuse | operator-catalog | applyPercent increases the amount instead of subtracting the percentage. |
| breadth-19 | medium | `arithmetic-swap` | operator misuse | lm-injected | withTax subtracts the rate instead of adding it. |
| breadth-20 | hard | `arithmetic-swap+equality-boundary` | operator misuse | diff-replay | addCents subtracts instead of adds, and isOverdrawn reports a zero balance as overdrawn. |
| breadth-21 | easy | `constant-delta` | value misuse | operator-catalog | isWeekend does not recognise Sunday as a weekend day. |
| breadth-22 | easy | `constant-delta` | value misuse | operator-catalog | formatDuration reports the wrong hour count. |
| breadth-23 | medium | `logical-swap` | operator misuse | operator-catalog | overlaps reports back-to-back slots as overlapping. |
| breadth-24 | medium | `operand-swap` | variable misuse | lm-injected | sortByStart orders slots from latest to earliest. |
| breadth-25 | hard | `operand-swap+equality-boundary` | variable misuse | diff-replay | minutesBetween returns a negative duration, and overlaps reports back-to-back slots as overlapping. |
| breadth-26 | easy | `constant-delta` | value misuse | operator-catalog | degree undercounts a node's neighbours by one. |
| breadth-27 | easy | `argument-swap` | variable misuse | operator-catalog | hasEdge looks for the wrong endpoint. |
| breadth-28 | medium | `equality-boundary` | operator misuse | operator-catalog | reachable reports an unreachable target as reachable. |
| breadth-29 | medium | `method-swap` | function misuse | lm-injected | hasSelfLoop only reports a self-loop when every node has one. |
| breadth-30 | hard | `argument-swap+equality-boundary` | variable misuse | diff-replay | hasEdge looks for the wrong endpoint, and reachable reports an unreachable target as reachable. |
| breadth-31 | easy | `method-swap` | function misuse | operator-catalog | clamp pushes a value out of range instead of keeping it inside. |
| breadth-32 | easy | `equality-boundary` | operator misuse | operator-catalog | requireFields lists the present fields instead of the missing ones. |
| breadth-33 | medium | `radix-coercion-drop` | value misuse | operator-catalog | parseAmount parses a hex-looking string as base sixteen. |
| breadth-34 | medium | `argument-swap` | variable misuse | lm-injected | clamp swaps the bounds, pushing a value out of range. |
| breadth-35 | hard | `equality-boundary+radix-coercion-drop` | operator misuse | lm-injected | requireFields lists the present fields instead of the missing ones, and parseAmount parses a hex-looking string as base sixteen. |
| breadth-36 | easy | `equality-boundary` | operator misuse | operator-catalog | shouldRetry retries once past the attempt limit. |
| breadth-37 | easy | `constant-delta` | value misuse | operator-catalog | nextState leaves a queued task queued instead of advancing it. |
| breadth-38 | medium | `chain-break` | operator misuse | operator-catalog | successRate always reports one, ignoring failures. |
| breadth-39 | medium | `operand-swap` | variable misuse | lm-injected | enqueue puts the new value at the front of the queue. |
| breadth-40 | hard | `operand-swap+equality-boundary` | variable misuse | lm-injected | enqueue puts the new value at the front of the queue, and shouldRetry retries once past the attempt limit. |

## Validation-filter evidence (R6 digest §2)

Every case's authoritative record is the sibling file `fixtures/<id>.FAULT.json` (outside the materialized fixture directory; it carries the canonical fix). `catalog/pipeline.ts` is the runnable filter chain: static annotation gate (FAULT.json schema/catalog rules, exact declared `it()` titles, fix present and faulted-different, adequacy target present) → reachability gate (a materialized worker workspace cannot reach the record or its fix) → F2P gate (stored faulted state red) → 100%-green baseline (canonical fix green) → determinism ×3 both states → per-title F2P/P2P via the vitest JSON reporter → P2P adequacy (single-statement deletion red) → format/tell pass (the diff is operator-sized and carries no operator signature). The static typecheck gate is the repo's own `npm run typecheck` (it includes `fixtures/**/*.ts`); type-error faults are excluded in v1.

The 30 F3 cases (breadth-11..40) are generated deterministically from `catalog/substrates/` by `catalog/generate-cases.ts` (`--check` proves the committed corpus still matches the recipes). The F2 seed cases (breadth-01..10) are hand-authored and carried forward with unchanged ids.

## Contamination posture

No public-benchmark instances are included or adapted. The HumanEvalFix `bug_type` enum is copied (MIT); no HumanEvalPack instances are vendored. The SWE-smith operator list is a strategy reference only. StrykerJS (Apache-2.0), ts-morph (MIT), and Babel (MIT) are devDependencies used as generators, never shipped into a worker workspace.

## Runtime projection

The verified tier's ≤ 20 min serial per cell is a **projection** at the digest's ~90 s/case assumption, not a measurement — F1 re-baselines it once a real fixer cell produces outcomes.
