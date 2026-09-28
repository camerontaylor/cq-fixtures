# S0 source and dependency reconciliation

Date: 2026-09-29 (Australia/Melbourne)

## Selected source snapshot

The fixtures checkout is at the requested base `746a100cd6a6e29e66499147793a8a1d398b18ec`. The selected toolkit worktree was clean at `dd247ca059f7bb183a74d7a3ed17cb17cebd2bef`; it was read and packed without modifying it. Read-only `git ls-remote` checks at `2026-09-28T20:21:20Z` showed those same commits at the `main` heads of cq-fixtures and cq-toolkit. The immutable pins therefore match the observed upstream heads at selection time.

The comparison trace used toolkit `130f77d2a6abf13b41f92e91c0e8abb3c3ef3c19` and reported fixtures' old installed toolkit pin `5e5270724df9bf72d7834c4461074f9ab0b62413`. This checkout's lock was still at that older `5e527072...` pin. `toolkit.lock` now selects the approved immutable `dd247ca...` commit. The package remains version `1.0.1`; its public API does not require a version bump for this fixture-side dependency pin.

## Packed package identity

`scripts/pack-toolkit.sh` packed the selected local toolkit source using the existing commit-SHA workflow and verified the checked-out SHA before building. The installed package was resolved from this checkout's `node_modules` and exercised by `test/toolkit-package-smoke.test.ts` through exported `makeAgenticRemediation` and an injected offline fake `Driver`.

| Evidence | Value |
|---|---|
| Toolkit source commit | `dd247ca059f7bb183a74d7a3ed17cb17cebd2bef` |
| Package | `@camerontaylor/cq-toolkit@1.0.1` |
| Tarball | `vendor/cq-toolkit-1.0.1.tgz` (local build artifact; ignored, not committed) |
| Tarball SHA256 | `90cc17ea030f96c83d6f77f35fbf0af1f6df7c893b65853928b7e2a60d176c9c` |
| Lock resolution | `file:vendor/cq-toolkit-1.0.1.tgz` |
| Lock integrity | `sha512-tNZBhcGB0NQAFWrjivXv1OuAM4wOUUzkYRHuF+nZYdEV3k5EgWAObiVOJW6czyDmf/lcLLDM5kjJ2zGMBHlEGw==` |
| Fixture/corpus source | `746a100cd6a6e29e66499147793a8a1d398b18ec` |

`campaign-source-manifest.json` records these pins, the toolkit archive and lock identities, and the suite files at the selected fixtures snapshot. The smoke test recomputes SHA256 and SHA512 from the packaged tarball, matches the SHA512 to `package-lock.json` and the manifest, confirms the installed package metadata, then verifies the real exported operation builds a read-only invocation, calls the injected Driver exactly once, and returns its result. No real provider or model is used.

## Existing W6.5 findings

The v1.1 hardening plan still marks W6.5 `[O]` (open). At this fixtures base, the following foundations are implemented and reusable:

- **W6.2 coverage and stop accounting:** result rows retain expected case counts and budget-stop causes; aggregation calculates expected/covered cases and coverage. `isAtCoverageParity` requires both cells to have complete coverage (`coverage === 1`). It does not compare case identities across distinct suites or validate matched subsets below full coverage.
- **W6.3 leakage controls:** the runner can execute from an allowlist-built eval root, with answer-key handling and a sentinel scan; dedicated scripts, tests, and CI steps cover the boundary.
- **W6.4 operational accounting:** case budgets, explicit budget-stop/absence evidence, unattended ceiling checks, and non-fatal ACP lane recording are present.
- **Patch and judgement reuse:** snapshots retain patches and outputs; the regrade path can judge the persisted patch independently of its original run.

Those pieces do **not** implement W6.5's statistical or repeat contract. The runner has no repeat identity/aggregation for experiment cohorts, no paired case-clustered uncertainty estimator, no minimum detectable effect (MDE) calculation, and no noise-band analysis. Coverage parity is a validity gate, not paired inference. Snapshot model identity is not a versioned served-model provenance contract for each repeat. The existing W6.5 planning row calls for k-repeats, paired case-clustered uncertainty and reported MDE, descriptive labels below parity, noise bands, a model axis, per-snapshot patches/outputs, and served-model versions; those should be completed as part of the campaign's single W6.5 inference path rather than treated as already delivered.

RS9 contributes a historical k=3 micro pilot and methodology, including evidence that naive per-case uncertainty understated clustered uncertainty. It used an older modified harness and is not current three-model campaign evidence, not a five-percentage-point precision claim, and not a substitute for the fixed-sample design in the approved campaign plan.

W6.6's classifier-role decision and W6.7's post-publication package rerun are adjacent open work, not W6.5 implementation. This S0 change does not alter runner, aggregation, budget, CLI, schema, or workflow contracts; those belong to their designated campaign workstreams. In particular, S0 makes no claim that the legacy D9 budget defaults have been reconciled for native subscription routes.

## Execution boundary

This change is S0 dependency reconciliation and offline consumer verification only. No campaign/provider calls, paid calls, webfront reads, reset redemption, public effects, or toolkit-source edits were made. The selected toolkit checkout and all other checkouts were left untouched.
