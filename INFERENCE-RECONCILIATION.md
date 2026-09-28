# S6 inference reconciliation

This adds standalone fixed-sample inference under `runner/statistics/` and a
focused test at `test/campaign-statistics.test.ts`. It reuses no shared
aggregate schema: inspection found the existing aggregate is descriptive and
has no paired task/substrate inferential pipeline. The explicit observation
interface prevents accidental reinterpretation of shared aggregate rows.

## Method and guards

- Each cohort is analyzed from a frozen roster with exact task, substrate,
  repeat, strategy, track and frozen task weight identities. Cohorts and tracks
  cannot be pooled. Repeats are averaged within task before the weighted task
  means are combined within substrate.
- Pairing requires exact assignment and weight parity. Missing or unknown
  statuses, absent assignments, unregistered strategies, empty rosters,
  malformed numeric evidence and incomplete paired coverage fail closed or
  suppress inference. Launched exhaustion remains a measured failure;
  operational absence remains null and descriptive.
- The bootstrap resamples paired substrates and is diagnostic for the chosen
  interval. Its marginal and max-statistic intervals are expanded by a
  weighted Hoeffding radius for bounded substrate differences. The radius uses
  the actual normalized frozen cluster weights, so its coverage argument does
  not depend on equal weights, task counts per substrate, or a particular
  bootstrap resample count. Resamples must be at least 199; changing their
  number cannot shrink the analytic envelope. Counts are bounded from 199 to
  10,000 for runtime control. This is why the validation recipe hash pins the
  envelope and resample range instead of the
  simulation's unit task weights. Bootstrap-only results are separately
  measured and never enable claims.
- The fixed validation recipe covers 24 substrates, three repeats, three
  contrasts and ten declared scenario classes. More or fewer repeats or
  contrasts do not match its validation hash. The analytic envelope remains
  conservative under arbitrary positive frozen task weights and task-count
  distributions for the supported binary complete-pair estimand. This does
  not extend validation to different outcome types, sample selection, or
  missingness assumptions.
- Inferential labels and the max-statistic adjustment require at least 20
  independent, nondegenerate substrates, complete pairs, matching evidence,
  and passing gates. Few clusters, parity failures, degeneracy and missingness
  return descriptive or inconclusive results. No five-point resolution or
  campaign quota is promised.

## Coverage validation

Validation uses 2,000 datasets per track, not 6,000 independent intervals.
Every contrast has a 2,000-dataset coverage denominator and a Bonferroni
simultaneous one-sided Wilson lower bound across the three contrasts. The
report also records the fraction of datasets where all three contrasts are
covered and its Wilson lower bound. The coverage gate uses the minimum of the
joint lower bound and all simultaneous per-contrast lower bounds. FWER uses
dataset-level rejection and its 95% Wilson upper bound on complete-coverage
global-null eligible datasets only. Missingness scenarios verify suppression
and are not counted as max-statistic eligible. The gates remain lower coverage
bound >= .93 and FWER upper bound <= .07.

Scenario generation has separate substrate probability shifts, task-level
probability shifts shared across repeats, and repeat-specific probability
jitter shared by paired strategies. The reported substrate ICC is a propensity
ICC estimate, not an outcome ICC target: across each dataset it is the variance
of substrate mean baseline success probabilities divided by `mean(p) *
(1 - mean(p))`; the evidence reports its average by scenario. Those scenarios
cover baseline saturation, task imbalance, effects of zero or two percentage
points, and symmetric/asymmetric operational missingness. They do not claim
to calibrate a particular campaign's ICC.

The candidate bootstrap-only intervals are empirically checked against the
same dataset-level coverage and eligible global-null FWER gates. They are not
selected for inference if either bound fails; the current supported procedure
continues to use the analytic expansion. In this run, the candidate fails:
joint coverage was .815 native / .783 diagnostic and its FWER upper bound was
.0933 on 600 eligible datasets per track. The analytic expansion covered all
2,000 datasets per track; its simultaneous marginal lower bound was .9977 and
FWER upper bound .00636. Its mean marginal interval width was about 1.14 on a
[-1, 1] scale, so this passes coverage but is not practically precise for a
five-point effect. Deterministic seeded evidence is stored in
[validation-evidence.json](runner/statistics/validation-evidence.json).

## Five-point planning forecast

`power.ts` gives each role a deterministic 162-scenario planning grid for a
five-percentage-point paired contrast, at 80% approximate power and a five-
point half-width target. It varies baseline success (.2/.5/.8), discordance
(.08/.25/.45, clipped to feasible Bernoulli margins), paired-difference ICC
(0/.3/.6), tasks per substrate (1/2/4), and repeats (1/3). The power component
uses a normal approximation to paired Bernoulli variance with the specified
cluster design effect. Its required-substrate count ranges from 4,000 to
5,351 across the grid (median 4,432). The precision component uses the familywise weighted
Hoeffding radius for three contrasts, so it can dominate the power count and
require thousands of independent substrates. Forecasts are assumptions for
planning, not role-calibrated data or promises of feasible runtime/quota;
unequal weights and missingness can increase requirements. The generated
forecasts identify both `fixer-worker` and `review-classifier`, with no
quota/runtime estimate.

## S1 adapter boundary

The read-only S1 contract at
`/Users/ctaylor/.paseo/worktrees/2q79f86l/cq-settings-contracts/CONTRACT.md`
defines the invocation-level `NativeObservation`, native identity handoff, raw
usage/model/artifact/capture/timing evidence, and worker result. It does not
define the task-level independent binary outcome or its judgement mapping,
strategy-to-assignment mapping, repeat and frozen-weight roster, or the
cohort/track/role/budget preregistration mapping. Those mappings are necessary
to produce the explicit `Observation` safely. The S1 integration adapter is
therefore waiting on that task-outcome and assignment mapping contract; no S1
files were edited here.

Before launch, persist the frozen registration and analysis version. Final
analysis consumes only that roster. Additional work starts a separately
preregistered cohort and never enlarges a completed cohort. Do not publish
inferential claims from calibration data or failed simulation gates.

The prior full-suite run stalled in existing `test/runner.test.ts` during a
workspace-write case and was stopped; it is not evidence for this module. A
full-suite rerun is deferred to later integration with bounded runner-specific
logs. This change uses only the bounded focused statistics and toolkit smoke
tests plus the build.
