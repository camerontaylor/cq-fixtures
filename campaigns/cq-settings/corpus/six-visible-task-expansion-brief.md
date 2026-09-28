# Bounded brief: six additional visible workflow tasks

## Goal and gate

Add six visible, local calibration tasks across review, analyze/remediate,
merge-conflict, and fleet-sweep operations. Each needs its own defect-bearing
substrate, immutable source/baseline/oracle IDs, and a host-owned semantic
oracle independent of task text and candidate output formatting. These are
not six role-adequacy claims and must not be produced by renaming current
variants.

**Execution is gated.** The whole-workflow G2 blocker is the existing
host-side `execFileSync(node)` execution of candidate code. Wait for the
boundary owner's protected judge-child implementation, then adapt corpus
callers to its typed API. Do not edit `runner/boundary`, shared runner judges,
oracles in `runner/workflow-corpus`, and do not run model/candidate evaluations
before that integration is available. Never pass reference code, hidden tests,
oracle data, or raw protected-child stdout into the task or model context.

## Six substrate designs

| ID / family | Exported operation and intended task | Independent semantic oracle |
|---|---|---|
| `review-role-scope-01` / `campaign-role-permission-v1` | `createReviewLoopRepairTask(modelSpec)` plus `makeFixReviewItem`; fresh module for campaign edit authorization. Seed the bug where owner access works but an administrator with the documented grant is rejected. Keep this separate from label validation. | Host truth table over owner, granted admin, unrelated user, and missing identity; verify no privilege for unrelated users, permitted role cases, and unchanged display/serialization behavior. Require only the task-owned source path to change. |
| `review-label-nfc-01` / `campaign-label-canonicalization-v1` | `createReviewLoopRepairTask(modelSpec)` plus `makeFixReviewItem`; distinct label-normalization module. Seed canonically equivalent composed/decomposed Unicode labels that compare unequal. | Host vectors for NFC-equivalent, different accents, surrounding whitespace, empty, and ordinary ASCII values. Check canonical comparison while preserving the original display bytes. Require independent visible baseline test red and corrected alternatives green. |
| `analysis-safe-integer-setting-01` / `numeric-setting-contract-v1` | `createAnalysisRemediationTask(variant, modelSpec)` plus exported `clusterErrorsOp` and `makeAgenticRemediation`; new structured analysis fixture for an integer configuration setting currently accepting fractional, unsafe, or out-of-range values. | Oracle the proposal contract against boundary vectors: minimum, maximum, one outside each bound, fractional, unsafe integer, numeric string, and non-number. Accept equivalent proposal wording only when it names the actual defect and a behaviorally sufficient remediation; this is a proposal oracle, not a source-patch identity check. |
| `analysis-origin-policy-01` / `remote-origin-config-v1` | Same exported analyze/remediate operations; separate origin-policy fixture where a scheme/host policy incorrectly accepts credential-bearing or non-HTTPS production URLs while still needing localhost development support. | Independent URL truth table for HTTPS production, credentials, wrong scheme, malformed input, and explicit localhost development. Judge structured proposal meaning; no expected prose substring as the correctness oracle. |
| `merge-origin-precedence-01` / `merge-source-precedence-v1` | `createMergeConflictTask(variant, modelSpec)` plus `makeResolveConflictOp`; fresh main/feature intent files and a merge conflict over configuration precedence (environment override, file default, built-in fallback). | Run exported operation with injected local `MergeEffects`; bounded oracle checks all three precedence cases, preservation of both branch intentions, exact allowed source diff, and candidate ancestry from the captured seed. Accept alternative implementations. |
| `fleet-test-unit-repair-01` / `fleet-test-helper-contract-v1` | Add a task factory alongside `createFleetSweepTask`; call exported `makeSweepUnitOp` with a fresh local worktree, injected `Driver`, deterministic check runner, and no push binding. A failing package test documents an incorrect helper return for missing/null input. | Independently execute the committed candidate behavior for null, missing, valid, and malformed input through the protected judge-child after it lands. Separately verify the captured seed ancestry, exact package/test path allowlist, local commit identity, and no remote effects. |

The review tasks use separate modules, APIs, and fault mechanisms; analysis
tasks exercise distinct configuration domains; merge exercises conflict
intent reconciliation; fleet exercises the unit execution path rather than
repeating package-owner selection. Keep each substrate and oracle family ID
unique and immutable in the corpus manifest.

## Ownership for an isolated implementation

Own only:

- `campaigns/cq-settings/corpus/review-loop-task.ts`
- `campaigns/cq-settings/corpus/operation-tasks.ts`
- `campaigns/cq-settings/corpus/integration-tasks.ts`
- new task-local oracle modules under `campaigns/cq-settings/corpus/`
- `campaigns/cq-settings/corpus/operation-oracle-pins.json`
- `campaigns/cq-settings/corpus/integration-oracle-pins.json`
- `campaigns/cq-settings/corpus/workflows.json` and `README.md`
- `test/campaign-workflows.test.ts`

Use only published toolkit exports from the selected dependency. Do not edit
toolkit source, package pins, runner/native/transport/boundary/shared-judge
code, or other campaign files. Keep all effects local/mocked; no push, forge,
webfront, public repository, or paid call.

## Acceptance evidence

- Each task factory creates a fresh temporary Git repository and records the
  complete seeded baseline SHA before the operation runs.
- The operation uses the existing exported toolkit operation and receives
  the caller's `ModelSpec` and injected deterministic test `Driver` where the
  operation has a Driver seam. Fleet uses `makeSweepUnitOp` with local-only
  bindings and a fake check runner.
- The oracle is outside the materialized task tree and pins every semantic
  dependency by content hash. It checks behavior, scope, baseline ancestry,
  and candidate identity as separate facts; patch SHA records bytes but does
  not define correctness.
- Baseline behavior is red under both a public regression check and the
  independent semantic oracle. At least two behaviorally distinct correct
  implementations pass where the task edits source. No-op, invalid output,
  throw-after-edit, and misleading worker claims cannot turn incorrect
  behavior green.
- Any candidate code execution goes only through the boundary owner's
  committed protected judge-child API. Keep its stdout private/untrusted,
  parse bounded results, and send only host booleans or sanitized diagnostics
  to reporting code.
- Update scenario/substrate counts only after tests discover and run the new
  cases. Keep them visible calibration; make no held-out isolation or power
  claim.

## Fresh-worker sequence

1. Wait for the boundary owner to commit the protected executor and publish
   its exact caller contract; do not poll the full corpus suite or begin
   model evaluation while it is pending.
2. Implement one substrate per row using only the ownership list above.
3. Add baseline-red, alternative-green, scope, outcome-fault, and immutable
   identity tests to `test/campaign-workflows.test.ts`.
4. Recompute the owned oracle pin manifests after oracle content is stable.
5. Run only focused task tests and report any still-blocked G2 evidence
   precisely. No full-suite pass is claimed without a complete fresh run.
