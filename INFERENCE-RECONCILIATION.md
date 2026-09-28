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
cluster design effect. Its original required-substrate count ranged from 4,000 to
5,351 across the grid (median 4,432). The variance correction below leaves
the range unchanged and raises the current legacy median to 4,572. The precision component uses the familywise weighted
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
to produce the explicit `Observation` safely. At that earlier commit, the S1 integration adapter was
waiting on that task-outcome and assignment mapping contract. The new S1 join
is implemented below; no S1 files were edited here.

Before launch, persist the frozen registration and analysis version. Final
analysis consumes only that roster. Additional work starts a separately
preregistered cohort and never enlarges a completed cohort. Do not publish
inferential claims from calibration data or failed simulation gates.

The prior full-suite run stalled in existing `test/runner.test.ts` during a
workspace-write case and was stopped; it is not evidence for this module. A
full-suite rerun is deferred to later integration with bounded runner-specific
logs. This change uses only the bounded focused statistics and toolkit smoke
tests plus the build.

## S6 precision escalation (2026-09-29)

The earlier bootstrap-only failure and Hoeffding evidence above remain historical
and unchanged in `validation-evidence.json`. A separately preregistered analytic
candidate is now available through `analyzePrecisionSample`, an explicit opt-in
extension to the standalone analysis. It does not silently replace the legacy
bootstrap or label an analytic adjustment as bootstrap max-statistic inference.
No campaign outcomes, paid evaluations, credentials or public effects were used.

The preregistration is `runner/statistics/precision-preregistration.json`, committed
before completed simulations: `9c951d8` (initial), `0344df3` (+5pp coverage),
`414a2d2` (partial-null supplement). Two initial executions per track aborted on numerical
boundary checks, before emitting gate reports. Their logs, with local workspace prefixes redacted, remain under
`runner/statistics/precision-*-initial-run.log` and `*-second-run.log`; a feasible
Bernoulli boundary needed floating-point tolerance, and task averaging needed
roundoff clipping to [-1,1]. No failed statistical stratum was removed or tuned
away after inspection. The candidate's 1.15 critical-value inflation was frozen
in the initial recipe, before simulation. It is a calibration choice, not a
published theorem or a fitted campaign parameter.

### Estimand, sampling unit and procedure

For task i on substrate g, first average R repeated binary assigned-strategy
outcomes separately for contender and baseline. Let d_i be the paired difference,
w_i the frozen task weight, W_g=sum(w_i) within substrate, D_g=sum(w_i d_i)/W_g,
and a_g=W_g/sum(W_g). The estimate is sum(a_g D_g), the weighted TASK-success
contrast. It equals the equally weighted cluster-average contrast only when
cluster masses match. Repeats do not multiply task weight. W_g is an estimand
weight, not an inverse-variance weight. The target is expected assigned-strategy
success on the frozen weighted roster under the declared independent-substrate
sampling/outcome model; this is not a claim of representativeness of all future
software tasks. Shared templates, codebases or tasks cannot be renamed into
independent substrates. Task or repeat dependence within substrates is retained.

The candidate computes an intercept-only weighted HC3 sandwich variance:
`Vhat=sum(a_g^2 (D_g-estimate)^2/(1-a_g)^2)`. Its degrees of freedom are
`1/sum(a_g^2)-1`, an effective-count approximation, NOT a CR2/Satterthwaite
implementation. The radius is `1.15*t_df(1-.05/(2K))*sqrt(Vhat)` for K=3.
Bonferroni controls multiplicity without assuming independent contrasts if the
underlying marginal tail approximation is adequate. Simulation checks that
approximation; it is not a finite-sample distribution-free guarantee. Both
reported marginal and family intervals use this conservative family radius,
so the marginal interval has at least the intended nominal confidence under
the validated model. Zero variance suppresses the whole family, never produces
an inferential zero-width interval. Numerical Student-t quantiles are tested
against reference values, including df=1 and df=10.

### Supported simulation envelope and results

`precision-validation-native-v1.json` and `precision-validation-diagnostic-v1.json`
record EVERY stratum: 720 per track, 2,000 independent datasets per stratum,
1,440,000 datasets per track. The finite grid includes independent substrate
counts 40/80/160/320/640, baseline probabilities .2/.5/.8, paired discordance
.15/.35, paired-difference substrate ICC 0/.3/.6, effects 0/.02/.05 and mixed
families [0,.02,.05]. Design modes are one task/one repeat/equal masses, or
three tasks/three repeats/cyclic masses 1:2:3 with equal task weights within a
substrate. Each paired vector shares the baseline across contrasts. The generator
copies one joint vector across an entire substrate with probability rho;
otherwise task/repeat vectors are independent. This supplies genuine persistent
paired-difference dependence with ICC rho, rather than merely changing success
propensities. Weights are fixed and independent of outcomes.

| Track | Minimum coverage lower95 | Maximum null-family error upper95 | Stronger simultaneous MC coverage lower | Stronger simultaneous MC error upper |
|---|---:|---:|---:|---:|
| Native | .948844 | .032807 | .933414 | .046101 |
| Diagnostic | .950493 | .029404 | .935236 | .042239 |

Each coverage count is the dataset-level event that ALL family intervals cover
their respective truths. Each error count is the dataset-level event that ANY
true-null contrast rejects, including partial-null families. Per-contrast counts
also retain dataset denominators. No gate pools contrasts or scenarios into
independent Bernoulli trials. Every core stratum passes coverage lower95>=.93
and error upper95<=.07. The stronger MC bounds use z=4.5 across all 1,080
coverage/error summaries per track and also pass. Monte Carlo uncertainty is
uncertainty about these simulations, not achieved campaign precision.

The 30 stress strata per track remain in the same evidence files. Fourteen
fail per track. They include 20 clusters, rare discordance .05, saturated
baselines .01/.98 with discordance .02, perfect dependence, and a dominant
cluster mass of 100. All are outside candidate eligibility, including stress
points that happened to pass. No blanket support for "20 or more clusters",
all weights, all ICCs, arbitrary cluster distributions, informative cluster
weights, heterogeneous effects correlated with weights, larger contrast
families, arbitrary repeats, or interval interpolation between grid points is
claimed. The paired-copy mixture is a sensitivity model, not evidence that a
real role follows it. Its applicability must be justified from visible
calibration before held-out launch; if unknown, use the conservative/descriptive
legacy output. The candidate cannot turn a finite simulation grid into a theorem
for all real task populations or establish equivalence.

The explicit extension freezes recipe hash, ordinary design hash, calibration
artifact path and SHA-256, and generator/design point. Output retains extension,
recipe and validation hashes. The implementation rechecks counts and gates for
EVERY stratum, the track, exact roster, repeat/task/cluster counts and validated
mass multiset. Missingness or degeneracy suppresses the entire precision family.
The effect field identifies the pre-run sensitivity-model point; it is never
selected using held-out estimated effects. Caller-side calibration applicability
remains a scientific responsibility; the adapter cannot prove it from a hash.

Four additional missingness strata per track, each with 2,000 datasets, use
40/80 clusters and paired 5% or contender-only 15% absence, conditioned on at
least one missing assignment. All 8,000 datasets per track suppress inference.
These are operational checks, not coverage successes or eligible FWER trials.
Evidence is in `precision-missingness-<track>-v1.json`.

### Five-point power and MDE forecast

`precision-power-native-v1.json` and `precision-power-diagnostic-v1.json` preserve
all 72 forecast cells per track. Each cell uses 2,000 power datasets and four
separate 2,000-dataset coverage/error runs (null, +2pp, +5pp, partial-null), with
baseline .5, discordance .15/.35, ICC 0/.3/.6, three tasks and three repeats,
equal or cyclic 1:2:3 masses, and n=80/160/320/640/1280/2560. All point gates
pass. Worst forecast-point coverage lower95 is .965501 native / .964939
diagnostic; worst null error upper95 is .031109 / .031675. The optional fifth
argument to `analyzePrecisionSample` accepts this evidence and rechecks the
ENTIRE 72-cell grid plus its four validations per cell. The base 720-stratum
validation is still mandatory. This permits exactly these additional design
points, including 3x3 equal masses and 1280/2560 clusters; unknown points or a
failed cell suppress the extension. It does not extrapolate a grid point to
other populations or sample counts. The output also hashes forecast evidence.

The corrected variance is
`(q-delta^2) * [rho + (1-rho)/(tasks*repeats)]` per substrate. The first term
persists under arbitrarily many repeats. For normalized masses a_g, sampling
variance is this quantity times `sum(a_g^2)`. The former forecast incorrectly
shrunk the entire variance with repeats; the legacy Hoeffding count remains
4,000–5,351 (new median 4,572) because its distribution-free radius dominates.
This correction is shared by the new simulation's MDE approximation and the
legacy planning function, with a meaningful regression test.

Choose the first TESTED count whose specified-contender power lower95 is >=.80,
rather than treating the simulation point estimate as certain power. Both tracks
select the same counts below. The grid is coarse: a jump from 640 to 1280 does
not imply that every intervening count would fail. MDE is a normal approximation
at the declared variance; detection power and width are simulated separately.

| Paired discordance | Persistent difference ICC | Equal masses | Cyclic masses 1:2:3 |
|---|---:|---:|---:|
| .15 | 0 | 160 | 160 |
| .15 | .3 | 320 | 640 |
| .15 | .6 | 640 | 640 |
| .35 | 0 | 320 | 320 |
| .35 | .3 | 1280 | 1280 |
| .35 | .6 | 1280 | 2560 |

Thus the conditional sensitivity forecast requires 160–2560 independent
substrates per role (median 640), 480–7680 distinct tasks at three per substrate,
and 1440–23040 repeated task assignments PER strategy at three repeats. With
three contenders plus baseline this is 5760–92160 assignment outcomes per role,
before extra scaffold stages/retries. At these selected counts, mean family
interval widths are approximately .055–.073 and approximate 80%-power MDEs
.036–.048. At 80 clusters, core mean family widths span .087–.374, so small
samples still often cannot distinguish a five-point effect. These are much
more usable than the earlier Hoeffding envelope under the declared model, but
substantial independence/diversity requirements remain.

Both `fixer-worker` and `review-classifier` are named in each forecast. Identical
sensitivity assumptions are intentionally used; no role-specific pilot variance
has been estimated. These are method-calibrated model sensitivities, not
role-calibrated forecasts, achieved campaign power, quota/runtime estimates,
or promises that the corpus can supply the required independent substrates.
Visible role calibration must estimate discordance, persistent task/substrate
variation, weight structure, saturation and missingness, then justify and freeze
applicability before held-out launch. The current statistical candidate cannot
resolve unsupported corpus diversity or a failed G2 boundary.

### S1 task-outcome join is now implemented

Read the authoritative sibling `CONTRACT.md` and `runner/experiment.ts` at
S1 commit `e5702c7`. `task-outcome-adapter.ts` accepts a structural projection
compatible with exported `TaskOutcome`, avoiding a dependency on a sibling
worktree or edits to shared contracts. Freeze an `OutcomeJoinRegistration` with
the full strategy/task/repeat roster, campaign/experiment/assignment identity,
substrate mapping, exact weight, judge ID/version/pin and base design hash.
`adaptTaskOutcomes` consumes `assignedStrategySuccess` from the explicitly
selected immutable judgement; it never chooses a best retry, newest regrade,
or substitutes candidate correctness or format conformance. An unavailable
judgement preserves a null operationally missing/interrupted outcome, or a
canonical S1 measured failure with unknown candidate correctness, no judgement
and retained invocation evidence (the mechanical no-candidate budget-stop
case). This uses the authoritative S1 mapping, not a fabricated candidate
correctness judgement.
Absent TaskOutcomes also remain absent in the frozen roster and suppress inference.

The adapter rejects duplicate assignment outcomes, reused invocation evidence,
identity/weight drift, missing measured-judgement selection, invalid evidence
hashes and conflicting projections. Every stage/retry and judgement reference
is returned for audit; retries do not increase statistical n. Artifact bytes
and provenance authenticity remain S1's immutable persistence responsibility.
The e5702c7 contract has no detailed budget terminal cause or track field.
A later read-only inspection of S1 `ed54581` found additive identity `track`
and `substrateId` fields; the adapter also accepts and validates those when
provided. For the original contract track comes from the frozen experiment
join, and the specific budget-stop count
cannot be reconstructed here. Assigned failure/missingness denominators remain
correct; do not interpret the generic operational cause as proof of zero budget
stops. Native invocation observations alone never produce success measurements.

### Sources and alternative-method assessment

- [MacKinnon and White, HC covariance estimators](https://qed.econ.queensu.ca/working_papers/papers/qed_wp_537.pdf)
  motivates leverage/jackknife corrections. The original PDF endpoint timed out
  on direct fetch; the Queen's indexed primary working-paper entry was available.
- [Pustejovsky and Tipton, small-sample CRVE](https://jepusto.com/files/Pustejovsky-Tipton-201601.pdf)
  and [official clubSandwich documentation](https://jepusto.github.io/clubSandwich/reference/vcovCR.html)
  explain working-model BRL/CR2 and Satterthwaite alternatives. Our simpler
  effective-count HC3 procedure does not inherit their exact correction or claims.
- [MacKinnon, Nielsen and Webb, jackknife and bootstrap methods](https://arxiv.org/abs/2301.04527)
  considers studentized/jackknife/wild alternatives. It supports investigating
  these methods, not assuming they validate this binary weighted design.
- [MacKinnon and Webb, wild bootstrap with few treated clusters](https://econ.queensu.ca/faculty/mackinnon/working-papers/qed_wp_1364.pdf)
  documents failure regimes in its own treatment-cluster setting. That setting
  differs from paired all-substrate strategy contrasts; it is a caution against
  unconditional bootstrap-validity claims, not evidence that our design fails.
- [Efron, better bootstrap confidence intervals](https://statistics.stanford.edu/technical-reports/better-bootstrap-confidence-intervals)
  is the primary BCa source. BCa skewness/bias corrections and studentization are
  plausible future candidates, but neither BCa nor wild bootstrap was implemented
  or validated in this bounded escalation. The retained 199-resample percentile
  method already fails, and no source confers finite-sample protection on it.

### Reproduction and integration

Copy the exact ignored `vendor/cq-toolkit-1.0.1.tgz` from integration before
`npm ci --offline`; SHA-256 is
`90cc17ea030f96c83d6f77f35fbf0af1f6df7c893b65853928b7e2a60d176c9c`.
Build, then use these bounded entry points with fresh output filenames (exclusive
create prevents evidence overwrites). Commands take no provider credentials:

```sh
npm run build
node dist/statistics/run-precision-validation.js native /tmp/native-validation.json
node dist/statistics/run-precision-validation.js diagnostic /tmp/diagnostic-validation.json
node dist/statistics/run-precision-missingness.js /tmp/native-validation.json /tmp/native-missingness.json
node dist/statistics/run-precision-power.js /tmp/native-validation.json /tmp/native-power.json
```

Run the missingness and power commands independently for diagnostic evidence too.
Frozen seeds are recorded in preregistration and outputs. The focused statistics
suite includes parity, repeat aggregation, numerical quantiles, every-stratum
validation gating, conditional precision activation, missingness suppression,
persistent variance, frozen-judge selection, duplicate retries and S1 outcome
mapping. Statistics lint and build pass; toolkit package smoke passes. Full
repository typecheck remains blocked by three pre-existing errors in
`test/campaign-strategies.test.ts:105` (missing `FakeExecutor.captureCandidate`
and two implicit-any parameters), outside this task's owned paths. No full suite
was run. Source changes stay inside statistics, its test, and this document.

## Independent-review integrity and accounting correction

The independent Flash review at research/research-20260929-cq-settings-execution/evidence/flash-precision-review-fe64f6f.md reproduced the frozen counts and found no statistical bug. This correction changes evidence admission and reporting, not the HC3/t recipe, simulation outcomes, envelope, gates, or sample forecast. Every historical v1 evidence file, preregistration, and evidence manifest remains byte-for-byte unchanged. No precision validation, forecast, or missingness simulations were rerun for this correction; the focused regression suite still exercises its existing bounded legacy simulation tests.

Evidence activation now requires the preregistered per-track seed **and** an expected canonical SHA-256 pinned in `evidence-pins.ts` / `precision-authenticity-v1.json`, followed by the existing exact-grid/count/gate checks. These pins derive from the previously frozen, independently reproduced archives, never from caller-provided hashes. Hashing arbitrary input alone cannot authenticate it. Canonical hashing permits object-key order changes but rejects changed counts, widths, seeds, metadata, or recipe. Changing the recipe requires a new preregistered evidence release and pins; an apparently passing replacement cannot activate v1.

Use `loadPrecisionValidation(path)` and `loadPrecisionForecast(path)` from `evidence-loader.ts` for archived evidence. Each first verifies exact file bytes against the frozen v1 manifest SHA. Historical forecasts lacked a `recipeHash`; the loader adds the current hash only after exact archived-byte verification, and the resulting full forecast content must match its separate frozen canonical pin. The analysis API requires that hash as well. Power/missingness CLIs and simulation functions reject failed or unpinned base validation before generating any datasets or output; simulation functions also require the preregistered forecast/missingness seed offset.

`precision-monte-carlo-{native,diagnostic}-v1.json` supplements the historical reports using their original counts. It reports three per-contrast covered counts, dataset denominators, proportions, and simultaneous Wilson lower bounds per stratum, alongside unchanged joint coverage and FWER bounds. The original z=4.5 now covers 3,240 one-sided bounds per track (720 joint + 2,160 contrast + 360 null-error); its union-bound tail remains below .012. This is reporting only: no outcomes selected, no gates retuned, no contrast-pooled Monte Carlo denominator. The supplement manifest binds both new reports to their source archive SHA and validation-content SHA.

The standalone S1 adapter now validates the complete preregistration before building any Map, so duplicate assignment identities and zero/negative weights fail immediately. Its optional structural `execution` seam follows the parent-agreed additive S1 contract: launched boolean/null, terminal cause, and source invocation IDs joining retained stage evidence. A terminal budget failure requires launched=true, cause=budget-exhausted, and retained source evidence; stages/retries do not multiply the count. Other known launched terminal causes or a known non-launched prelaunch failure contribute zero. Assigned success remains the frozen independent judgement boolean/null.

This supersedes the earlier adapter budget-counter limitation: if any relevant measured assigned failure lacks authoritative cause evidence (absent execution, null launch, unknown cause, or unavailable sources), `launchedBudgetFailures` is **null**, not a fabricated zero. `knownLaunchedBudgetFailures` reports the observed subtotal. Historical TaskOutcomes remain compatible and honest about unknown accounting. Legacy direct observations retain their existing explicit `cause` handling. The S1 shared implementation was pending when this correction was prepared; no shared contract/source edits were made here. The precision forecast remains conditional on its finite generator grid and visible role calibration; this integrity correction adds no statistical or campaign claims.

Correction validation: build passed; 22 focused statistics tests and 3 toolkit package smoke tests passed; the extended accounting test passed after its final assertions; owned-path ESLint and git diff whitespace checks passed. All 11 historical JSON/log/preregistration hashes in the frozen evidence manifest were rechecked unchanged. No full suite or campaign/provider calls were run. The previously documented unrelated repository typecheck blockers remain outside this scope.
