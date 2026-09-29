# Final-profile G1 native handoff

Run the TypeScript entrypoint with Node's transform-types loader:

```sh
node --experimental-transform-types runner/native/run-final-profile-g1.ts /private/generated/runtime.mjs
```

Node 24.21.0 rejects parameter properties in imported TypeScript under `--experimental-strip-types`; that loader is not supported for this entrypoint. The native file also has a transform-types shebang for direct execution.

The runner does not dispatch a model by itself. The parent must first freeze and pass the distinct final-profile-G1 admission receipt. Native source pins include the runtime and preparation modules, imported dependency closure, oracle-manifest dependencies, and the public final-profile inputs file. Recompute and preregister the resulting source pin after any boundary runtime or public-input change, including the broker asset-volume identity update.

For candidate capture, finalization must return a typed publication receipt with the canonical runSuite workspace, exact staged baseline commit/tree, `hostUnchanged`, `afterTeardown`, and `captureEligible` all verified. Native checks the receipt against the staged baseline and checks that the published workspace inventory still matches the stopped export before it returns a successful worker result. Missing or mismatched evidence fails closed.

The 240-second assignment timer is a decision cutoff, not proof that every judge or other late promise has stopped. Reports state `wholeAssignmentResourceLifetimeEnforced: false`; such a run is not eligible for a frozen lane.
