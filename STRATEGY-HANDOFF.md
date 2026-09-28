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

## Screening catalog

`runner/strategies/screening-catalog.ts` exports `createScreeningCatalog`,
`freezeScreeningDesign`, and `createScreeningComparisonArtifact`. The catalog
is a set of **planned candidates**, not run results. Its pinned profile snapshot
comes from Paseo profile/model/provider inspection at
`2026-09-28T21:58:19Z`:

- GPT-6 Sol: configured `codex` profile, full-access, profile-requested low;
  provider model inventory exposes low/medium/high/xhigh/max/ultra.
- GPT-6 Luna: available through the Codex provider, but no named Luna profile;
  provider model inventory exposes low/medium/high/xhigh/max. The catalog
  records the discovered full-access route as the launch mode.
- GLM-5.3-Flash: configured ZCode profile, yolo, requested high; model inventory
  exposes low/high/max.
- Space Bunny: configured Pi/OpenCode profile at
  `opencode-go/space-bunny-free`, requested high. Its underlying model stays
  anonymous and the model inventory exposes no effort list, so the catalog
  marks high as profile-requested and unverified rather than an effort contrast.

The native screen covers each exposed effort with one-shot baselines at all
three caller-supplied tiers, then uses representative high-effort scaffold
cells, four directed mixed-model pipelines, and low-to-high escalation only
where both levels are exposed. A smaller diagnostic screen mirrors all five
recipe families on `shared-diagnostic` identities. It is separate from native
cells and makes no claim that diagnostic harness conformance has been proven.
This is a covering design rather than a Cartesian product. It currently
generates 114 planned cells (90 native, 24 diagnostic).

Callers must supply three or more pilot-derived bounded tiers and frozen
boundary, tools/assistance, source, corpus, and judge identities. This catalog
does not invent numeric pilot limits. Native token enforcement is explicitly
`unsupported` in the screening inventory; tiers with token budgets or
`hard-required` policy fail closed. Each candidate identity binds track,
participants and selected effort, profile evidence, boundary and assistance
hashes, recipe, all configured tiers, and a charged stage envelope. The
envelope accounts for candidate drafts, verification, repair, selection,
escalation, final judging, cumulative wall time, shutdown, observation, and
capture reserves. Any candidate that could hit the stage or attempt ceiling is
marked as possible bounded truncation.

Freeze the screening design before outcomes, with distinct calibration and
held-out cohort/manifest hashes, pilot references, and numeric promotion and
uncertainty rules. Its comparison-artifact constructor accepts a single
calibration track, requires every planned row (including missing/unscreened
cells), and keeps held-out outcome hashes null. The design forbids post-hoc
cohort pooling and retains individual-model baselines by policy.

The native G1 entrypoint remains the priority and does not depend on this
catalog. No native adapter changes are required for the catalog work. When
mapping routes, use the route's `selectedEffort` (also copied into every
`StageRequest.effort`) with its configured profile/model and transport; the
native adapter does not need to parse effort out of a string ID. Keep
`profile-requested` Space Bunny distinct from verified model effort, and do
not send a token cap for these unsupported routes.

## Visible review-loop strategy runner

`runner/strategies/visible-screening.ts` wires the bounded same-model
verify/repair recipe to the real review-loop `runSuite` path. The final
independent S1 run produces the `TaskOutcome`, row, tables, and artifact; model
stage observations remain in the S4 stage ledger and count toward full
pipeline usage.

Each draft starts from an isolated worktree with the exact pinned seed commit
and tree. Repair and verification also start from that seed, with the captured,
content-hash checked candidate patch applied. The runner freezes three finite
tiers, a 120-second model stage limit, and the S1 60-second host-check limit.
Whole-pipeline wall time, whole-judge time, and token hard caps remain
unenforced pending native supervisor support, so this runner makes no hard
total-bound claim. Caller configuration must attest route effort and supply
the already admitted driver and native supervisor. The runner performs no
credential resolution or public calls, and it has no held-out cohort input.

The focused test uses a fake model driver while exercising the real artifact
store and S1 `runSuite`/host oracle. The corpus expansion currently has nine
substrates across five families, but only five model-call task types:
review-loop (one), analyze (two), and merge (two). Ratchet and fleet are
deterministic operation samples and do not increase that model-call count.
This runner intentionally screens review-loop only; expand task coverage after
parent verification.

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
