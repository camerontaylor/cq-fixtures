# W6.7 dispatch after toolkit publication

Dependency: W7.1 publishes the toolkit version, and the fixtures flip PR installs that exact published version. A `toolkit.lock` SHA or local tarball does not satisfy W6.7. Record the published version, registry integrity, fixtures flip commit and toolkit release tag in the snapshot header.

1. Verify the published version exists in the registry, then run `scripts/flip-to-published.sh <published-version>` on a fresh fixtures branch. Inspect the package and lockfile diff; run `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test`. Review and merge the flip under the normal PR gates.
2. Check the D9 ledger before dispatch. Stop at $24 monthly, $2 invoiced, 30,000 Z.AI raw credits, or the Claude subscription utilisation gate. Reserve up to $3 for the weekly profile; use the exact cell-level USD and token caps. Run model cells off peak and inspect billed versus modeled spend after each bounded dispatch.
3. Dispatch the W6.5 repeat profile from the merged fixtures commit against the published version. Keep the eval-root allowlist, answer key, sentinel check, and outputs outside the worker checkout. Preserve all `repeat-N/` artifacts and run the snapshot comparison analyzer on the copied snapshot before citing differences.
4. Verify that every compared cell has the same suite SHA, published toolkit version, served model identity, three complete repeats and coverage parity. Otherwise label its difference descriptive. Record the minimum detectable effect and noise band beside any claimed difference.
5. Append a `(model, driver)` keyed row to `reports/model-role-assignments.md` for the fixer role, even when the decision is hold. Cite the new published-version snapshot. Retract the WB1 “model fidelity” note because its old fixer evidence was workspace-unbound. Commit the W6.7 snapshot and log update for review.

The exact workflow dispatch inputs and run ID are filled from the merged W6.5 workflow at execution time; this file deliberately records the required evidence and gates before a version exists.
