# Reproduction — suites/fixer-worker/breadth-verified

Plan WB-2.5: every verified fault is independently reproduced from `FAULT.json` by a second
author, with the agreement recorded (tier κ ≥ 0.80 target). "From `FAULT.json` alone" means the
author's recipe and notes are withheld; the second author necessarily also reads the fixture
`src/` and `test/` files the record names.

## Protocol

Two independent passes:

1. **Second-author pass (static).** A fresh agent that did not author the cases reads, for each of
   `breadth-01..12`, only `fixtures/breadth-NN.FAULT.json` plus the fixture `src/` and `test/`
   files it names, and confirms: (a) the recorded `operator`/`bug_type` match the faulted-vs-fix diff; (b) each
   declared `f2p` title depends on the mutated behaviour and would fail on the stored faulted
   state; (c) each declared `p2p` title is unaffected; (d) the recorded `adequacy.delete` is a
   load-bearing statement in the fixed source. No tests are run in this pass.
2. **Mechanical execution pass (CI).** `catalog/pipeline.ts` (`full: true`), driven by
   `test/breadth.test.ts` in the `static` CI job, proves for every verified case: F2P (stored
   faulted state red), 100%-green baseline (canonical fix green), determinism ×3 both states,
   per-title F2P/P2P via the vitest JSON reporter, single-statement-deletion adequacy, and the
   format/tell pass. This is the buggy→red / fix→green evidence the second-author pass reasons
   about without executing.

## Second-author result

Method: for breadth-01..12, read `fixtures/breadth-NN.FAULT.json`, the faulted
`fixtures/breadth-NN/src/*` and `fixtures/breadth-NN/test/*` only. No tests executed, no repo files
edited.

| Case | Verdict | Evidence |
| --- | --- | --- |
| breadth-01 | PASS | faulted `w + h` vs fix `w * h` = arithmetic-swap/operator misuse; f2p 3×4=12 (faulted 7) and 200,50cm=1 (faulted 2.5) fail; p2p toMetres unaffected; `const area = w * h;` load-bearing |
| breadth-02 | PASS | faulted `page > totalPages-1` vs fix `>=` = equality-boundary/operator misuse; f2p isLastPage(2,3)=true (faulted false) fails; p2p isLastPage(0,3)=false, pageCount, pageLabel unaffected |
| breadth-03 | PASS | faulted `isMember ? 0 : 0.1` vs fix `? 0.1 : 0` = ternary-swap/operator misuse; both f2p arms flip; p2p applyDiscount rounding unaffected |
| breadth-04 | PASS | faulted `BACKOFF_FACTOR=3` vs fix `=2` = constant-delta/value misuse; f2p backoffDelay(100,3)=800 (faulted 2700) and factor==2 fail; p2p attempt-0, retryPlan[0], nowMs unaffected |
| breadth-05 | PASS | faulted `some` vs fix `every` = method-swap/function misuse; f2p allInStock(with one out)=false (faulted true) fails; p2p single-in-stock, totalPrice, catalog length unaffected |
| breadth-06 | PASS | faulted memoize missing `cache.set` vs fix has it = remove-assignment/missing logic; f2p repeat-arg count==1 (faulted 2) fails; p2p distinct-args count==2 and keyOf unaffected |
| breadth-07 | PASS | faulted `retries?: number` + cast vs fix `retries: number = 3` = default-param-removal/value misuse; f2p withDefaults({})={retries:3} (faulted undefined) fails; p2p explicit-5, parseBool×2, isValidRetries×2 unaffected |
| breadth-08 | PASS | faulted `profile!.address?.city` vs fix `profile?.address?.city` = non-null-overreach/function misuse; f2p cityOf(undefined)='unknown' (faulted throws) fails; p2p missing-address, present-city, displayName unaffected |
| breadth-09 | PASS | faulted `return stock` + `paid \|\| shipped` vs fix `[...stock]` + `&&` = shared-reference-return+logical-swap/variable misuse; both f2p fail; p2p stock-rows, paid&shipped→complete, auditLine unaffected; adequacy covers the inventory fault |
| breadth-10 | PASS | faulted `parseInt(text)` + `formatRange(to, from)` vs fix radix + `(from, to)` = radix-drop+argument-swap/value misuse; both f2p fail; p2p '42', direct formatRange, isPositive×2 unaffected |
| breadth-11 | PASS | faulted `length < max` vs fix `<=` = equality-boundary/operator misuse; f2p truncate('hello',5)='hello' (faulted 'hello…') fails; p2p wordCount, toKebabCase, averageWordLength unaffected |
| breadth-12 | PASS | faulted `toUpperCase()` vs fix `toLowerCase()` = method-swap/function misuse; f2p toKebabCase('Hello Big World')='hello-big-world' (faulted uppercase) fails; p2p wordCount, truncate-at-limit, averageWordLength unaffected |

**Agreement: 12/12 (κ = 1.00, target ≥ 0.80).** No operator, `bug_type`, `f2p`, `p2p`, or
adequacy mismatches. Noted: the two hard cases record a single adequacy target (one of their two
faults) — the recorded delete is present and load-bearing, and per-fault adequacy belongs to F7's
static gate.

## Runtime projection

The verified tier's ≤ 20 min serial per cell is a **projection** at the digest's ~90 s/case
assumption, not a measurement — F1 re-baselines it once a real fixer cell produces outcomes.
