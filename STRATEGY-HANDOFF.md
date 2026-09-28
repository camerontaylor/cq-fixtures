# S4 strategy engine handoff

This branch owns `runner/strategies/`, `test/campaign-strategies.test.ts`, and
this handoff. The strategy engine is standalone and intentionally does not edit
`runner/index.ts`, the native transport layer, shared schemas, or package
metadata. It can be reconciled with S1/S2 by implementing the injected
`StageExecutor` seam described below.

## Entry points

- `runStrategy(task, recipe, tier, executor)` runs one frozen recipe at one
  per-task tier.
- `runStrategyTiers(task, recipe, tiers, executor)` requires at least three
  unique, valid tiers and returns one independently identified assignment per
  tier.
- `recipeHash(recipe)` exposes the recipe-only digest. Each result's
  `recipeHash` also binds `evaluationTrack` (`native` or `diagnostic`), so the
  tracks cannot share the same strategy identity.
- `defineBudgetTiers(...)` validates and freezes the matrix's configured
  tiers. Numeric tier values are campaign calibration inputs; this module does
  not silently invent them.

Recipes cover one-shot, same-model verify/repair, candidate selection, mixed
model verify/repair, and cheap-first escalation. Candidate selection may use a
frozen rule, a separately accounted judge stage, or a separately accounted
model route. Selection requests explicitly prohibit external effects.

## Executor contract and S1/S2 mapping

`StageExecutor.execute(request)` is called once per stage, including
draft/repair/escalation, scaffold verification, candidate selection, and the
independent final oracle. It should:

1. Dispatch only the requested configured route/settings and honor the supplied
   `AbortSignal` by stopping the native process tree.
2. Persist raw transport evidence with the immutable `assignmentId`, `stageId`,
   `attemptId`, and `recipeHash` from the request. Do not reuse IDs on retry.
3. Return per-counter `UsageObservations`; unknown/unavailable counters remain
   `null`. `tokenTotal` must follow the provider's observed semantics and must
   not be recomputed from input/output/cache counters.
4. Return `launched: false` for confirmed prelaunch failure, `true` for a
   confirmed launch, and `null` when dispatch cannot be determined. A launched
   no-candidate bounded failure is a task failure; an unlaunched transport
   failure remains operational missingness.
5. For `verify`, return only scaffold feedback in `verification`. For
   `independent-judge`, return `judgement` and do not reveal that result to any
   later model stage. Oracle identity, pristine restoration, exact patch
   selection, and judge artifacts remain responsibilities of the parent
   executor/S1 artifact layer.
6. For `select`, choose only among `inputCandidates` and report the chosen
   candidate ID. Selection usage/time is returned as a normal stage. No remote
   writes, PR actions, replies, or other external effects are allowed.

`captureCandidate(request, { result, error })` is called in `finally` after
both a return and a throw. S2 should make it read the assigned workspace before
cleanup and return a content-addressed candidate when recoverable. If capture
and execution both return a candidate, the captured workspace candidate takes
precedence. This keeps edits available for the independent oracle after a
transport exception.

The current contract is deliberately fixtures-local. The S1 adapter should
project each `StageRecord` to its versioned observation envelope, preserving
`null` usage and synthetic compatibility values as non-measurements. The
parent runner should persist those envelopes and independent judgement before
workspace cleanup; it should not sum only successful final attempts.

## Accounting and bounds

Every executor stage is recorded and charged to end-to-end time. Model routes
consume cumulative `maxAttempts`; selection, verifier, repair and retry stages
also consume `maxStages`. Candidate work stops before the reserved
`judgementAllowanceMs`; the independent oracle has the remaining end-to-end
wall-clock window. The executor must terminate child processes when the signal
fires; the engine also races execution/capture against the hard deadline.

For each usage counter, known observations are retained in
`knownUsageSubtotals`. The full strategy counter is the sum only when every
contributing stage reported it; otherwise it stays `null`. Token totals remain
separate from component counters. A hard token cap is sent only to a route
whose native conformance says `tokenEnforcement: 'hard'`, and later caps become
advisory when prior cumulative token use is unknown. Unsupported routes are
explicitly marked and never receive a fabricated hard cap.

`candidateCorrectness`, `assignedStrategySuccess`, and `operationalStatus` are
separate fields. A launched bounded run with no candidate is a failure. A
candidate with unavailable independent judgement has unknown correctness and
unknown strategy success. A recovered candidate can be correct even when its
transport stage failed; the transport failure remains in the stage record and
`incompleteReasons`.

## Integration steps for parent

1. Reconcile `StageExecutor` against the final S1 observation envelope and S2
   process/capture interface. Add a narrow adapter module outside this owned
   directory; keep the public toolkit `Driver` unchanged.
2. Bind task/workspace identity and native/diagnostic track from the campaign
   assignment. Ensure each configured route declares token-cap enforcement
   conformance and supported effort/settings before dispatch.
3. Persist each stage and candidate immutably at the campaign assignment path.
   Preserve every failed attempt, verification, selector, and oracle stage.
4. Integrate `StrategyResult` with row/table validators and nullable campaign
   aggregates. Do not map `null` to zero or merge tracks into a model-only key.
5. Keep this engine's fake tests and add adapter-level `runSuite` conformance
   tests in the S1/S2 integration lane. Broad comparisons still require all
   three native routes' G1 conformance; this engine makes no transport or
   evaluation-boundary equivalence claim.

Verification completed by this change: offline `npm ci`, focused strategy fake
tests, TypeScript build, and focused ESLint. No paid provider calls are part of
this implementation.
