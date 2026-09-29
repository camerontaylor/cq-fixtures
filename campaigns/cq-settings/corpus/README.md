# CQ settings workflow corpus handoff

This is visible local calibration material. It contains no held-out task or oracle, and no native-route isolation claim.

## Runnable task entrypoints

- Review repair: `createReviewLoopRepairTask(modelSpec)` and `executeReviewLoopRepairTask(task, driver)` in `review-loop-task.ts`. The runSuite bundle and host-pinned judge are in `runner/workflow-corpus/review-loop-suite.ts` and `review-loop-judge.ts`.
- Analyze/remediate: `createAnalysisRemediationTask(variant, modelSpec)` and `executeAnalysisRemediationTask(task, driver)` in `operation-tasks.ts`. Variants are whitespace-only settings and Unicode code-point limit. The caller's `ModelSpec` is passed to the exported remediation operation. The semantic oracle evaluates candidate bytes through `executeProtectedJudgeChild`.
- Quality ratchets: `createRatchetTask(variant)` and `executeRatchetTask(task)` in `operation-tasks.ts`. Variants cover lower-is-better error counts and higher-is-better coverage. This toolkit path has no model Driver role; these are deterministic operation tasks, not model samples.
- Merge conflicts: `createMergeConflictTask(variant, modelSpec)` and `executeMergeConflictTask(task, driver)` in `integration-tasks.ts`. Local `MergeEffects` drive the exported resolver; each fresh repo contains separate main/feature intent files, and variants test Unicode length and reserved prefixes.
- Fleet sweep: `createFleetSweepTask(variant)` and `executeFleetSweepTask(task)` in `integration-tasks.ts`. Variants use distinct nested test-package ownership trees and actual committed Git changes.

Each task materializes a fresh local Git repository and records the complete seeded commit SHA. Analysis tasks also expose a fixture content SHA. The manifests `operation-oracle-pins.json` and `integration-oracle-pins.json` pin task/executor sources, semantic judges, and the protected judge child by SHA256; factory construction fails closed if a pinned dependency drifts. The runSuite review adapter separately carries its baseline commit and review oracle pin into host scoring.

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

## Next visible-task expansion brief

`six-visible-task-expansion-brief.md` is a bounded implementation brief for
six additional, genuinely distinct local substrates across review,
analyze/remediate, merge-conflict, and fleet-sweep operations. It records
entrypoints, owned paths, and independent semantic-oracle requirements. The
tasks remain planned and are not included in current counts.

The semantic oracle callers now execute candidate modules only through the
protected judge-child boundary. Each call stages only the candidate module in
a fresh sanitized Git snapshot; parent-side expected values stay outside that
snapshot, and returned stdout remains private/untrusted. This closes the
post-export candidate-execution blocker. Whole actual-route G2 remains pending:
the final native route, correlated native receipts, authoritative consumed
ledger, distinct actual-route admission, and final-container G1 are not
established by these local oracle tests.

All delivered tasks are calibration. Held-out family names in `workflows.json` are reservations only; no held-out artifact has been materialized or proven inaccessible. The task count is not an adequacy or power claim. The new task substrates do not represent nine independent workflow families.

No model service, paid route, public repository, or remote merge/push is used by these corpus tests. Merge effects remain local mocks.
