# S6 inference reconciliation

This adds a standalone fixed-sample inference module at `runner/statistics/` and
the focused test at `test/campaign-statistics.test.ts`. It does not change or
duplicate `runner/aggregate.ts`: that module remains the existing descriptive
row/table aggregator. Inspection found no paired task/substrate inference
implementation to reuse.

## Method and guardrails

- Every analysis consumes an immutable `frozen: true` preregistration with a
  cohort, track, role, budget, assignment seed, expected repeats, exact task /
  substrate / repeat identities, positive frozen task weights, contrast family,
  bootstrap seed/count and analysis version.
- Repeated binary outcomes are averaged inside task first. Frozen task weights
  are then used within substrate, and the paired substrate means are resampled
  together for each contrast. Tracks and cohorts cannot be pooled.
- Pairing checks compare exact assignment identities and exact weights. A
  missing assignment or outcome, including two equal-sized but different
  missing subsets, makes the result descriptive. This interface has no
  unregistered missing-at-random correction.
- A launched budget exhaustion/no-candidate is supplied as `status: measured,
  success: false, cause: 'budget-exhausted'`; it stays in the outcome. An
  operational absence uses `status: operational-missing, success: null` and is
  retained in coverage diagnostics.
- Marginal intervals use paired substrate bootstrap quantiles expanded to a
  bounded-cluster Hoeffding envelope. Simultaneous intervals use the bootstrap
  maximum statistic and a familywise Hoeffding envelope. The envelope is
  deliberately conservative and can be wide, especially near 20 substrates.
- Inferential labels and family adjustment require at least 20 nondegenerate
  independent substrates, complete paired coverage, and passing validation
  evidence matching the track / repeat / contrast-count recipe. Otherwise the
  output is descriptive or inconclusive and the max-statistic adjustment is
  withheld. A zero-width interval is never a dominance/equivalence claim.

## Validation envelope

The simulation exercises 2,000 fixed datasets per track, 24 substrates, three
repeats per task and a three-contrast family. Its ten scenario classes vary
baseline saturation, ICC, task imbalance, repeat noise, effects of zero or two
percentage points, symmetric operational missingness and asymmetric missingness
fallback stress. It reports Wilson confidence bounds for marginal coverage and
global-null familywise error. The automatic gates are lower 95% coverage bound
at least .93 and upper 95% FWER bound at most .07. Seeded results are recorded
in [validation-evidence.json](runner/statistics/validation-evidence.json); the
run log was `/tmp/cq-campaign-statistics-evidence.log`. Each track passed the
marginal gate on 6,000 contrast intervals (coverage 1.000; lower bound
0.99936). The familywise gate passed on 600 adjustment-eligible global-null
datasets (zero rejections; upper bound 0.00636). Missingness scenarios exercised
the descriptive/fallback path and were excluded from adjustment eligibility.

Supported claims are limited to the track whose simulation evidence passes,
with the frozen recipe, binary task outcomes, at least 20 independent
substrates, no degenerate contrast variance, exact paired assignment/weight
parity, and complete operational coverage. This validation does not establish
adequate power or five-point resolution; the report makes no such claim.
It does not validate other contrast-family sizes, confidence levels, repeat
counts, selection rules, missingness models, continuous metrics, post-hoc
cohort pooling, or outcome-dependent sample extension. Native and diagnostic
tracks need separate evidence and remain separate results.

## Required S1 integration adapter

S1 owns the shared observation envelope and aggregate/schema changes. Its
adapter must map the authoritative persisted observations to `Observation`
without converting unknown outcomes to failures or synthetic counters to
measurements. It must emit one row per preregistered strategy assignment,
preserve launched budget failures as measured false outcomes, mark operational
absence as null, preserve cohort/track/task/substrate/repeat IDs, and carry the
exact preregistered weight. No adapter is included here by scope.

Before each fixed cohort launches, persist the frozen `Preregistration` and
analysis version. Final analysis reads only that roster; additional quota can
start a separately preregistered cohort and cannot enlarge this one. Do not
publish inferential claims from calibration data or failed simulation gates.

## Verification command

```sh
npx vitest run test/campaign-statistics.test.ts test/toolkit-package-smoke.test.ts
```

The simulation is deterministic from its declared seeds and is bounded by the
test's 180-second timeout. The checked-in evidence records this run's metrics;
an empty or failed future log is not evidence that validation gates passed.
