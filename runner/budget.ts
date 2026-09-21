// Per-suite token-cap arithmetic (WB-1.6).
//
// WHY: the matrix passed a FLAT `--max-tokens 200000`, but that cap is per
// SUITE RUN — a 40-case suite therefore got ~5k tokens/case before the
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
 * Absolute token cap for ONE suite run = per-case budget × that suite's cases.
 *
 * `caseCount` is the number of cases in the suite being run. The CLI
 * allocates EACH suite its own cap (`runner/cli.ts`), so a multi-suite
 * invocation's allowance is non-overlapping rather than every runSuite
 * resetting to an invocation-wide total. `extraTokens` carries a non-case
 * reservation (the ACP preflight probe's conservative reserve, review-debt
 * #14) so that reservation is never silently deducted from the cases'
 * budget.
 *
 * Validation + saturation (I9): a non-integer, negative, or unsafe-integer
 * input would make the governor's cap NaN/Infinity — `NaN > cap` is false
 * and `Infinity` silently unbounds the run, either of which fails OPEN. The
 * function therefore throws on invalid inputs and saturates an overflowing
 * product/sum at `Number.MAX_SAFE_INTEGER` (fail loud or fail closed, never
 * fail open).
 *
 * NO FLOOR, deliberately: the smallest real suite (micro fixer, 5 cases) at
 * the workflow's 60000/case already yields 300000 — above the retired flat
 * 200000 — and a hypothetical 1-case suite gets 60000, still ~6× the worst
 * observed per-case spend (10441), so the per-case budget itself is the
 * guard. A floor would also make the multiplier untestable at small values.
 */
export function perSuiteTokenCap(perCaseTokens: number, caseCount: number, extraTokens = 0): number {
  const fields: ReadonlyArray<readonly [string, number]> = [
    ['perCaseTokens', perCaseTokens],
    ['caseCount', caseCount],
    ['extraTokens', extraTokens],
  ];
  for (const [name, value] of fields) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `perSuiteTokenCap: ${name} must be a non-negative safe integer, got ${String(value)}`,
      );
    }
  }
  const product = perCaseTokens * caseCount;
  if (!Number.isSafeInteger(product)) return Number.MAX_SAFE_INTEGER;
  const total = product + extraTokens;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}
