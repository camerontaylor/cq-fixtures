# CQ settings workflow corpus handoff

This is visible local calibration material. It contains no held-out task or oracle, and no native-route isolation claim.

## Runnable task entrypoints

- Review repair: `createReviewLoopRepairTask(modelSpec)` and `executeReviewLoopRepairTask(task, driver)` in `review-loop-task.ts`. The runSuite bundle and host-pinned judge are in `runner/workflow-corpus/review-loop-suite.ts` and `review-loop-judge.ts`.
- Analyze/remediate: `createAnalysisRemediationTask(variant, modelSpec)` and `executeAnalysisRemediationTask(task, driver)` in `operation-tasks.ts`. Variants are whitespace-only settings and Unicode code-point limit. The caller's `ModelSpec` is passed to the exported remediation operation. The semantic oracle executes the candidate module in a bounded child process.
- Quality ratchets: `createRatchetTask(variant)` and `executeRatchetTask(task)` in `operation-tasks.ts`. Variants cover lower-is-better error counts and higher-is-better coverage. This toolkit path has no model Driver role; these are deterministic operation tasks, not model samples.

Each task materializes a fresh local Git repository and records the complete seeded commit SHA. Analysis tasks also expose a fixture content SHA. The operation oracle manifest `operation-oracle-pins.json` pins the task/executor source and host semantic judge by SHA256; factory construction fails closed if either dependency drifts. The runSuite review adapter separately carries its baseline commit and review oracle pin into host scoring.

## Counts and boundaries

`workflows.json` distinguishes 19 named/expanded workflow test cases, nine local substrates, and five independently judged task substrates (one review, two analyze/remediate, two deterministic ratchet). Only review and analyze/remediate invoke a model Driver. The merge-conflict, fleet-sweep, and test-fix scenarios remain local operation integration checks without role calls. The current test-fix plan exposes a package-wide source staging leak; do not treat it as a safe task until a test-only stage allowlist is verified. Its exact toolkit operation remains exercised in `test/campaign-workflows.test.ts`.

All delivered tasks are calibration. Held-out family names in `workflows.json` are reservations only; no held-out artifact has been materialized or proven inaccessible. The task count is not an adequacy or power claim. The five new/expanded task substrates are not five independent workflow families.

No model service, paid route, public repository, or remote merge/push is used by these corpus tests. Merge effects remain local mocks.
