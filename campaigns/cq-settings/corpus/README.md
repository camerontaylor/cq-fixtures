# CQ settings workflow corpus handoff

This is visible local calibration material. It contains no held-out task or oracle, and no native-route isolation claim.

## Runnable task entrypoints

- Review repair: `createReviewLoopRepairTask(modelSpec)` and `executeReviewLoopRepairTask(task, driver)` in `review-loop-task.ts`. The runSuite bundle and host-pinned judge are in `runner/workflow-corpus/review-loop-suite.ts` and `review-loop-judge.ts`.
- Analyze/remediate: `createAnalysisRemediationTask(variant, modelSpec)` and `executeAnalysisRemediationTask(task, driver)` in `operation-tasks.ts`. Variants are whitespace-only settings and Unicode code-point limit. The caller's `ModelSpec` is passed to the exported remediation operation. The semantic oracle executes the candidate module in a bounded child process.
- Quality ratchets: `createRatchetTask(variant)` and `executeRatchetTask(task)` in `operation-tasks.ts`. Variants cover lower-is-better error counts and higher-is-better coverage. This toolkit path has no model Driver role; these are deterministic operation tasks, not model samples.
- Merge conflicts: `createMergeConflictTask(variant, modelSpec)` and `executeMergeConflictTask(task, driver)` in `integration-tasks.ts`. Local `MergeEffects` drive the exported resolver; each fresh repo contains separate main/feature intent files, and variants test Unicode length and reserved prefixes.
- Fleet sweep: `createFleetSweepTask(variant)` and `executeFleetSweepTask(task)` in `integration-tasks.ts`. Variants use distinct nested test-package ownership trees and actual committed Git changes.

Each task materializes a fresh local Git repository and records the complete seeded commit SHA. Analysis tasks also expose a fixture content SHA. The manifests `operation-oracle-pins.json` and `integration-oracle-pins.json` pin task/executor sources and host semantic judges by SHA256; factory construction fails closed if a pinned dependency drifts. The runSuite review adapter separately carries its baseline commit and review oracle pin into host scoring.

## Counts and boundaries

`workflows.json` distinguishes 23 named/expanded workflow test cases, thirteen local substrates, and nine independently judged task substrates (one review, two analyze/remediate, two ratchet, two merge, and two fleet). Review, analyze/remediate, and merge tasks inject local Drivers; ratchet and fleet are deterministic operation tasks, not model samples. Test-fix remains an integration check without a role call. Its selected-pin and in-flight source behavior are reconciled below; it is not counted as a safe test-fix campaign task.

Test-fix boundary reproduction uses the exported `buildTestFixPlan` anchored at `src/plans/test-fix.ts` and the `makePlanSweep` phase-A plan. For the fixture's `packages/settings` package, the test target is `packages/settings/test/settings.test.ts` while product source is `packages/settings/src/settings.ts`; the generated `^packages/settings/` path admits both. The test asserts this exact serialized plan and confirms no product-fix job is created. It writes only to a temporary fixture and never stages or mutates a checkout.

### Test-fix source reconciliation

The campaign package remains immutable at toolkit source commit
`dd247ca059f7bb183a74d7a3ed17cb17cebd2bef` (`toolkit.lock`); its selected
tarball SHA256 is
`90cc17ea030f96c83d6f77f35fbf0af1f6df7c893b65853928b7e2a60d176c9c`.
At this pin, `src/plans/test-fix.ts:64-66` supplies `{ proposeOnly: true }`
and no `stagePathAllowlist` (blob
`873ebb615df89d59946537129f17a523ffe540e1`). In
`src/ops/sweep/unit.ts:1092-1110,1165-1169`, any nonempty staged set in
propose-only mode becomes `needs-human` before commit/push. That prevents
automatic publication, but it does not validate a test-only path boundary;
the proposal can include product source. This is distinct from enforcement
of a test-only staged set.

The separately observed in-flight source epoch is
`915f2b6301e2fae5c52d9c9616ad45134ee3f1bd` (`lane/p4-integration`). Its
ancestor `9879eb6a188c8936b934c59f51c3e28f90092d82` adds
`TEST_FIX_STAGE_PATH_ALLOWLIST` from the gates lane's test-file patterns and
passes it from `buildTestFixPlan` (`src/plans/test-fix.ts:32-40,73-75`, blob
`ccd4a0a48a8c2c22347c55a62e90b2e282c3e1ab`). The sweep unit checks staged
paths before commit (`src/ops/sweep/unit.ts:755-788`, blob
`c95ef953d2e56744788854ebcdc6104a6df9309f`). In-flight e2e cases cover a
production-file edit and a production-to-test rename
(`test/e2e/sweep/sweep.e2e.test.ts:652-700,779-807`). These establish a
test-file scope boundary in that source epoch, not in the selected package.

The remaining test gap is factory wiring coverage: those e2e cases pass the
allowlist directly through the sweep test helper instead of invoking
`buildTestFixPlan`. The `test/plans/sweep.test.ts:314-330` factory test covers
prep mode and fixer identity but does not assert that the generated unit
inputs contain the allowlist. Record this as a direct-factory coverage gap,
not as evidence that the in-flight source lacks the wiring. The old campaign
archive and pin remain unchanged; any future package claim must name a new
source epoch.

## Six additional visible calibration tasks

`six-visible-task-expansion-brief.md` defines six distinct local substrates
across review, analyze/remediate, merge-conflict, and fleet-sweep operations.
Factories and task-local oracle definitions are in place. The six entries in
`workflows.json` passed nine focused synthetic checks, including both new
analysis variants through the existing operation and a local injected Driver.
They remain excluded from the validated counts pending complete acceptance
evidence. `npm run typecheck` also passes. The protected judge-child API is
integrated with the judge-ownership source closure at runner HEAD
`95a1462281f8f01b6a11db89560acd7cd1687eae`. Active review, operation, and
integration oracle manifests pin the exact closure bytes, including
`judge-ownership.ts`, `docker-control.ts`, and the public closure manifest.
Task-local behavior judges keep protected stdout private and untrusted. The
run-16 through run-19 reports and original oracle pins remain unchanged. No
model calls were made for this pin refresh.

The active review-loop task is v2 (`settings/module.js` and
`settings/display.js`); the v1 oracle manifest is archived with its original
actual-run evidence. The six expansion tasks remain additive to v2.

All delivered tasks are calibration. Held-out family names in `workflows.json` are reservations only; no held-out artifact has been materialized or proven inaccessible. The task count is not an adequacy or power claim. The new task substrates do not represent nine independent workflow families.

No model service, paid route, public repository, or remote merge/push is used by these corpus tests. Merge effects remain local mocks.

## Review expansion scope and identity facts (PK11 attempt 2)

`review-task-oracles.ts` now carries three facts that were previously absent
rather than merely untested:

- Each expansion contract declares `allowedPaths` naming the single task-owned
  source path, matching the "change only this file" wording of the six-task brief.
- `judgeReviewTaskCandidateIdentity` decides scope, baseline ancestry, tree
  cleanliness and non-empty patch bytes entirely on the host, by delegating to
  the same `judgeLocalCandidateIdentity` used by the merge and fleet families.
  It never executes candidate code, so these facts stay exact even when the
  protected judge child is unavailable.
- `judgeReviewTaskSubmission` composes behavior and identity while keeping them
  separate, and populates the previously unpopulated `candidatePatchSha256`
  through `reviewCandidatePatchSha256`, which had no call site. The review and
  shared identity oracles must agree on that digest.

`integration-task-oracles.ts` and `operation-workflow-judges.ts` now name an
ancestry violation instead of letting a non-zero `merge-base --is-ancestor`
exit escape into a shared catch. Previously a rewritten candidate was
indistinguishable from a scope violation or an environment failure; a candidate
that is still red is still red, but the reason is now attributable. The residual
catch is reserved for unreadable repository state.

`review-loop-pin.ts` is the source-generated review oracle dependency list. It
now covers the full transitive **runtime** import closure of the host judge.
`assignment-supervisor-owner.ts` and `g2-daemon-contract.ts` were omitted even
though pinned boundary modules value-import them; `g2-daemon-contract.ts` binds
the dedicated daemon identity the protected child asserts.
`assignment-supervisor.ts` remains deliberately unpinned because it is reached
only through an `import type` edge and is therefore compile-time only.

These three generator additions, and the changed bytes of the PK11 oracle
modules themselves, make the generated pin disagree with the committed
`review-loop-oracle-pin.json` and with the operation/integration manifests. That
disagreement is intentional and is the conductor's pin transaction to complete:
PK00 owns those JSON manifests and this packet does not edit them.
