# S4 strategy engine handoff

This branch owns `runner/strategies/`, `test/campaign-strategies.test.ts`, and
this handoff. It does not edit the shared runner, transport implementations,
schemas, or dependency metadata. The engine is fixtures-local and takes an
injected `StageExecutor`; the S1/S2 parent supplies the adapter.

## Entry points and identity

- `runStrategy(task, recipe, tier, executor)` runs one recipe at one configured
  per-task tier. `runStrategyTiers(...)` requires at least three tiers.
- A campaign `task` carries a frozen `campaignIdentity` with profile inventory,
  evaluation boundary, and scaffold assistance hashes, plus optional source,
  corpus, and judge pins. The recipe hash binds these values, task prompt and
  track, the full recipe, and the selected tier/settings.
- `independentJudgeRoute` pins the parent-owned oracle route and its token
  enforcement. It participates in whole-pipeline token-mode validation and the
  strategy hash; judging and oracle data remain parent-executor responsibilities.
- Campaign callers pass the roster's `assignmentId`. Stage and attempt IDs use
  deterministic keys under that assignment and recipe hash. Without an
  assignment ID, generated IDs support isolated local use.
- Deadline values sent to adapters include both a monotonic timestamp
  (`deadlineMonotonicMs`, using the same clock as `monotonicNowMs`) and a native
  epoch timestamp (`deadlineEpochMs`, milliseconds since Unix epoch). Elapsed
  durations always use the monotonic clock.

Recipes cover one-shot, same-model verify/repair, candidate selection,
mixed-model verify/repair, and cheap-first escalation. Verification must return
`status: completed` and a valid boolean result. Repair recipes spend another
verification stage after the final allowed repair. Candidate-selection drafts
receive independent workspaces and empty candidate context; duplicate content
hashes are deduplicated for selection while every generation attempt remains
charged. Selection may use a frozen rule, separately accounted judge, or model
route, and cannot create external effects.

## Adapter contract

`StageExecutor` is the campaign seam. Its responsibilities are:

1. `execute(request)` dispatches the configured native/diagnostic route and
   settings, carrying the immutable assignment/stage/attempt identity into S1.
   Route transport is explicit (`codex-exec`, `pi-json`, `pi-rpc`, `zcode-acp`,
   `shared-diagnostic`, or `fake`). Do not send settings outside the route's
   declared inventory. Diagnostic routes cannot enter native tasks.
2. `stopAndWait(request, execution, cause)` aborts the complete child process
   tree and resolves only after it proves both `stopped` and
   `executionSettled`. At the stage deadline the engine aborts first and waits
   within the tier's shutdown reserve. If proof is missing, it quarantines the
   workspace and suppresses capture and judging. Parent cleanup must follow
   the same stop proof for all outstanding processes.
3. `getObservation(request)` retrieves the authoritative S1 envelope after
   success, throw, cancellation, or timeout. Map launch evidence, service time,
   nullable counters, and inclusion/overlap semantics. This retrieval replaces
   fallback result counters so measured usage from failed outcomes survives.
   Keep `tokenTotal` authoritative; never infer it by summing counters.
4. `captureCandidate(request, state)` is a bounded read of the settled assigned
   workspace. It runs only after process settlement and within the distinct
   capture reserve. Return immutable content identity (`sha256`), candidate
   ID, workspace ID, and opaque workspace/branch handle. Do not reuse a
   candidate ID for different content or workspaces. The engine validates and
   freezes this identity before selection or judging.
5. `createCandidateWorkspace(request, index)` creates a pristine workspace for
   each candidate draft. In the review-loop corpus adapter, seed each one from
   `ReviewLoopRepairTask.baselineCommit`; the task provides `worktreePath`,
   `operationInput`, and visible tests but no judge data. Do not pass a prior
   draft's candidate or working tree into the next independent draft. For
   repair, use the selected candidate's workspace handle.
6. `verify` returns scaffold feedback only. The independent oracle stage uses
   a pristine evaluation path and returns `correctness`, `taskSuccess`, and
   `formatCompliance` separately. Never feed oracle output to a later model
   stage. Parent/S1 owns pristine restoration, exact patch selection, oracle
   identity, artifacts, and persistence before cleanup.
7. Selection stages report only a choice among the supplied candidates and
   return their own usage and timing. Do not create PRs, replies, remote writes,
   or other public effects.

The corpus worker's `executeReviewLoopRepairTask(task, driver)` is a useful
native operation adapter target: each strategy stage should provide a
route-configured `Driver`, invoke that task operation in the requested
workspace, and map the returned or thrown toolkit result into S1 evidence.
The corpus helper itself stays outside this branch's ownership.

## Bounds and outcome fields

Every stage, including selector, verifier, repair, escalation, and oracle, is
recorded. Model invocations consume `maxAttempts`; every stage consumes
`maxStages`. A tier reserves separate time for candidate work, process-tree
shutdown, observation retrieval, capture, and final judgement. No executor launch occurs after
cancellation or a reached monotonic deadline. The judge gets an independent
signal so it can grade an already captured candidate after cancellation.

Token caps are sent only when the full pipeline is configured for hard
enforcement and prior authoritative token totals are known. A hard-required
tier fails closed when a route cannot enforce the cap. Advisory or unsupported
pipelines send no misleading stage-level hard cap. Counter accounting keeps
per-stage observations and separate per-counter subtotals. Inclusion semantics
remain attached to each observation; the engine never folds
input/output/cache/reasoning into a common total. A whole-pipeline counter
remains `null` when any stage did not report that counter.

`recipeCompleted` reports whether the configured state machine completed.
`candidateCorrectness` reports the independent mechanical verdict.
`formatCompliance` and `assignedStrategySuccess` report final conformance and
assigned outcome separately. `authorizedBudgetStop` and `operationalStatus`
preserve whether a measured budget limit, cancellation, timeout, missing judge,
or operational fault ended the run. A candidate can be mechanically correct
while cancellation/deadline or an omitted required strategy stage makes the
assigned result fail.

## Integration seam for S1/S2

The parent integration should implement one adapter outside this owned
directory, mapping `InvocationIdentity` into S1 `beginInvocation` and
`getObservation(invocationId)`. S1 persists transport evidence; this engine
returns strategy state and nullable accounting. Verify route setting inventories
against the frozen profile pins and carry assignment identity from the campaign
roster. Persist candidate content before workspace cleanup. Keep native and
diagnostic tracks separate in storage and comparison tables.

Focused verification for this follow-up: `npx tsc --noEmit` and
`npx vitest run test/campaign-strategies.test.ts`. No paid provider calls are
part of the strategy fake tests.
