# Local review-loop corpus slice

`review-loop-task.ts` exports a typed task factory and an executor for the
selected toolkit's `makeFixReviewItem` operation. The caller supplies the
`ModelSpec`; the acceptance tests inject a deterministic `Driver` and never
contact a model provider. The task pins source, baseline, and oracle IDs as
literal types and seeds a fresh temporary Git repository with the known bug.

`review-loop-judge.ts` is a host-side exported oracle. The visible task tree
contains only the package source and public test. The judge verifies the
recorded baseline contents, checks candidate behavior over ordinary values,
whitespace, astral characters, and combining sequences, verifies that display
preserves the original Unicode input, runs the visible regression test, and
checks that only `src/settings.mjs` differs from the baseline. Its patch SHA256
identifies the candidate bytes; it does not compare against a reference patch.
`identity` separately records the full candidate commit, baseline ancestry,
clean Git state, and patch hash. A behaviorally correct but dirty candidate
can therefore pass conformance while failing candidate identity.

`review-loop-suite.ts` exports `toReviewLoopSuiteCase()` and
`createReviewLoopRunSuiteBundle()`, adapting the task to the current runner's
typed `FixerSuiteCase`/`Suite` contract. The adapter keeps the host oracle
outside the copied fixture and routes the supplied model spec into runSuite.

## Selected toolkit test-fix scope finding

The installed package came from immutable toolkit commit
`dd247ca059f7bb183a74d7a3ed17cb17cebd2bef`; the original selected checkout has
since been removed. These source anchors are read directly from that commit's
Git objects in `/Volumes/offload/neptune/repos/cq-toolkit`, without checking
out or changing that repository:

- `src/plans/test-fix.ts:64-66` calls `buildSweepPlan` with only
  `{ proposeOnly: true }`; it does not supply `stagePathAllowlist`.
- `src/plans/sweep.ts:213-251` defines the default unit allowlist. For a
  package at `packages/settings`, it emits `^packages/settings/`.
- `src/plans/sweep.ts:392-395,417-418` selects that default whenever the
  overlay has no explicit allowlist and writes it onto each unit job.
- The source blob identities at the pinned commit are
  `873ebb615df89d59946537129f17a523ffe540e1` (`test-fix.ts`) and
  `6139c6c0dd2d4d9336dfdac3e74f473dc29f4728` (`sweep.ts`).

The reproducible local evidence is
`npx vitest run test/campaign-workflows.test.ts -t 'baseline test-fix phase'`,
the focused test `builds the baseline test-fix phase with test-only scope` in
`test/campaign-workflows.test.ts`. It builds a package containing both a
product source file and a test file, calls the exported planner and
`buildTestFixPlan`, then observes the broad `^packages/settings/` pattern in
the generated plan. This confirms the current plan also admits product source
under the test-fix package and fails a strict test-only staging requirement.
This finding is limited to the selected package revision; this task does not
modify toolkit source.

## Corpus limits

This is one visible calibration substrate with one executable correctness
oracle. The other workflow families remain operation-integration scenarios,
not independently judged campaign tasks. The held-out family names in
`campaigns/cq-settings/corpus/workflows.json` are reservation metadata only;
no held-out task is materialized and no isolation or role-adequacy claim is
made.
