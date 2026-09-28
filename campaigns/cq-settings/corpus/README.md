# CQ settings workflow corpus handoff

This is visible local calibration material. It contains no held-out task or oracle, and no native-route isolation claim.

## Runnable task entrypoints

- Review repair: `createReviewLoopRepairTask(modelSpec)` and `executeReviewLoopRepairTask(task, driver)` in `review-loop-task.ts`. The runSuite bundle and host-pinned judge are in `runner/workflow-corpus/review-loop-suite.ts` and `review-loop-judge.ts`.
- Analyze/remediate: `createAnalysisRemediationTask(variant, modelSpec)` and `executeAnalysisRemediationTask(task, driver)` in `operation-tasks.ts`. Variants are whitespace-only settings and Unicode code-point limit. The caller's `ModelSpec` is passed to the exported remediation operation. The semantic oracle executes the candidate module in a bounded child process.
- Quality ratchets: `createRatchetTask(variant)` and `executeRatchetTask(task)` in `operation-tasks.ts`. Variants cover lower-is-better error counts and higher-is-better coverage. This toolkit path has no model Driver role; these are deterministic operation tasks, not model samples.
- Merge conflicts: `createMergeConflictTask(variant, modelSpec)` and `executeMergeConflictTask(task, driver)` in `integration-tasks.ts`. Local `MergeEffects` drive the exported resolver; variants test Unicode length and reserved prefixes.
- Fleet sweep: `createFleetSweepTask(variant)` and `executeFleetSweepTask(task)` in `integration-tasks.ts`. Variants use distinct nested test-package ownership trees and actual committed Git changes.

Each task materializes a fresh local Git repository and records the complete seeded commit SHA. Analysis tasks also expose a fixture content SHA. The manifests `operation-oracle-pins.json` and `integration-oracle-pins.json` pin task/executor sources and host semantic judges by SHA256; factory construction fails closed if a pinned dependency drifts. The runSuite review adapter separately carries its baseline commit and review oracle pin into host scoring.

## Counts and boundaries

`workflows.json` distinguishes 23 named/expanded workflow test cases, thirteen local substrates, and nine independently judged task substrates (one review, two analyze/remediate, two ratchet, two merge, and two fleet). Review, analyze/remediate, and merge tasks inject local Drivers; ratchet and fleet are deterministic operation tasks, not model samples. Test-fix remains an integration check without a role call. Its plan exposes a package-wide source staging leak; do not treat it as a safe task until a test-only stage allowlist is verified. Its exact toolkit operation remains exercised in `test/campaign-workflows.test.ts`.

Test-fix boundary reproduction uses the exported `buildTestFixPlan` anchored at `src/plans/test-fix.ts` and the `makePlanSweep` phase-A plan. For the fixture's `packages/settings` package, the test target is `packages/settings/test/settings.test.ts` while product source is `packages/settings/src/settings.ts`; the generated `^packages/settings/` path admits both. The test asserts this exact serialized plan and confirms no product-fix job is created. It writes only to a temporary fixture and never stages or mutates a checkout. Until the toolkit exposes a test-only stage allowlist, there is no valid repair task/oracle to score under this family.

All delivered tasks are calibration. Held-out family names in `workflows.json` are reservations only; no held-out artifact has been materialized or proven inaccessible. The task count is not an adequacy or power claim. The new task substrates do not represent nine independent workflow families.

No model service, paid route, public repository, or remote merge/push is used by these corpus tests. Merge effects remain local mocks.
