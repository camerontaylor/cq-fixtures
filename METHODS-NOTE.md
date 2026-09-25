# W6.1 methods note

## Binding

- For each fixer case, the runner materializes the pristine fixture as before, then creates a toolkit `SessionStore` record whose workspace is that exact copy.
- The fixer `OpInvocation` carries the returned `sessionRef`; all three toolkit drivers consume that binding when they construct their execution cwd.
- The session store is under the materialized workspace and is removed with that scratch copy after scoring. The pristine fixture is never bound.

## Evidence and spend

- The new tests use only the synthetic micro-1 and micro-2 fixtures; no breadth, live-provider, or regrade run is included.
- Round trip: the bound driver edits the materialized source and the existing micro-1 check must pass (both fixer probes, 2/2).
- Isolation: two fixer dispatches receive distinct session ids and distinct materialized workspace paths; neither session can name the other workspace.
- Spend: $0.00 for this lane. This is implementation evidence, not a regrading of the historical snapshots; the strict replay validation in PR #31 remains authoritative for existing `workspace-unbound` rows.

## Verification note

The worktree did not contain the ignored `vendor/cq-toolkit-1.0.1.tgz`, and no local `node_modules`; the first verification attempt (`npm test -- --run test/micro.test.ts`) therefore stopped at the missing Node type definition before tests started. The diff passes `git diff --check`.
