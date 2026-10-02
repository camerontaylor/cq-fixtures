# W6.7 postpublication dispatch preparation

## Current state

W6.7 is **prepared, not dispatchable**. The canonical release is `@camerontaylor/cq-toolkit@0.2.0`; the registry check on 2026-10-02 returned only version `0.0.0`, and no `v0.2.0` release tag was found. W7.1 publication is owner-controlled. Do not run the flip script, tag, or dispatch until the exact `0.2.0` registry artifact and integrity are verified and the fixtures flip has passed its review and gates.

The existing `w65-pilot` workflow is not the complete W6.7 matrix. It selects two ai-sdk model cells over five fixer micro cases and three repeats. W6.7 requires the published toolkit, merged W6.5 statistics and FG governance, interleaved model/driver evidence, and the accepted coverage and uncertainty reporting. Do not claim W6.7 complete from `w65-pilot` alone. FG runner integration also waits for J's promoted governed-driver integration and the W2.4 lock contract.

## Release and flip sequence

1. Verify `npm view @camerontaylor/cq-toolkit@0.2.0 version dist.integrity --json` against the owner-published release and toolkit `v0.2.0` tag. Record the registry URL, integrity, release URL, and source SHA. A `toolkit.lock` SHA or local tarball does not satisfy this requirement.
2. On a fresh fixtures branch from current main, run `scripts/flip-to-published.sh 0.2.0`. Inspect `package.json` and `package-lock.json`; verify `toolkit.lock` is removed as prescribed. Then run `scripts/prepare-toolkit.sh`, `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, and the required full test gate. Open a normal review PR. Record its merged SHA and fixtures release tag only after the required gates pass.
3. At the merged flip SHA, confirm the workflow's provenance guard accepts package version `0.2.0` and registry integrity. Capture the exact workflow ref/SHA, profile, and inputs before dispatch. Keep the full W6.7 matrix design aligned with the accepted plan; do not silently substitute the narrower `w65-pilot` profile.

## Paid-run admission — currently blocked

No paid dispatch is authorized by this preparation. Before any provider request, reconcile D9 from current external billing evidence: $3/week; $30/month with a $24 stop; $2 invoice stop; 30,000 off-peak Z.AI raw-credit stop; and the $12 Claude subscription behind its seven-day gate. Apply the canonical 80% stop and per-case caps of $0.05 for ai-sdk flash cells and $0.10 for GLM driver cells. Reserve worst-case cell caps across concurrent evaluators, including retry/probe spend. If remaining invoice, credits, or subscription quota cannot be established, remain offline and do not infer headroom or a reset.

Keep modeled USD, actual billed USD, and provider/subscription credits separate. The historical #30 artifact's modeled `$0.1430376` is not billed-spend or credit evidence; actual billed USD and credits remain unknown. Do not subtract the modeled amount from either D9 ledger.

## W6.7 evidence to preserve

For every admitted cell, record the fixtures SHA, published toolkit version and registry integrity, served model identity, driver, repeat ordinal, expected/scored/absence coverage, outcome, modeled cost, actual billing/credit evidence when available, and elapsed time. Preserve each repeat's raw rows, run manifest, patches, outputs, and journals. Run the paired case-clustered analysis; report the minimum detectable effect and noise band. Mark comparisons below coverage parity descriptive. Record the served-model version for each snapshot.

Include fixer and prospective classifier role tables. Demonstrate conformance for at least two functioning toolkit drivers without inventing an expensive all-model grid. Record acp as not-provisioned/non-fatal when that remains its state. Append a `(model, driver)` row to `reports/model-role-assignments.md`, including a hold verdict if appropriate, and retract the WB1 “model fidelity” note where it appears. Preserve #30 as prior binding/health evidence only; it predates publication and its GLM claude-agent job failed.

The weekly matrix remains paused until W6.1, W6.3, W6.4, slice F, and the workflow's W6.7 re-enable condition are satisfied. Passing those conditions does not override paid-run admission or authorize publication.
