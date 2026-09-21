// Per-suite token-cap arithmetic (WB-1.6).
//
// WHY: the matrix passed a FLAT `--max-tokens 200000`, but that cap is per
// SUITE INVOCATION — a 40-case suite therefore got ~5k tokens/case before the
// governor gated its tail into honest "no row" absences (plan §7). The
// workflow now passes a per-CASE budget (`--max-tokens-per-case`) and this
// module multiplies it by the suite's actual case count, so the cap scales
// with suite size by construction — a future breadth suite needs no second
// cap edit.
//
// The governor counts ALL FOUR Usage fields (input + output + cacheRead +
// cacheWrite; BudgetGovernor.totalTokensOf), so the per-case budget is
// denominated in that same fold.

/**
 * Absolute per-invocation token cap = per-case budget × dispatched cases.
 *
 * `caseCount` is the number of cases the invocation will dispatch (the
 * loaded suites' cases summed — B4 allows one suite per role per
 * invocation). `extraTokens` carries a non-case reservation (the ACP
 * preflight probe's conservative reserve, review-debt #14) so that
 * reservation is never silently deducted from the cases' budget.
 *
 * No floor is applied: the workflow's per-case budget is derived so that
 * the smallest real suites already exceed the retired flat 200000 cap
 * (micro: 5 × 60000 = 300000 fixer, 10 × 60000 = 600000 classifier), and a
 * floor would make the multiplier untestable at small values.
 */
export function perSuiteTokenCap(perCaseTokens: number, caseCount: number, extraTokens = 0): number {
  return perCaseTokens * caseCount + extraTokens;
}
