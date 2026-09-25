// Per-suite cap arithmetic: tokens (WB-1.6) and USD (W6.2, the accepted D9
// per-case envelope).
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

/**
 * W6.2: the accepted D9 envelope's per-case USD caps (RS-9
 * `rs9-eval-statistics.md` @ `dfe66be` §0.3, owner-accepted per the v11
 * board's D9 row), keyed by EXACT cell — the (driver lane, served model id)
 * pair the row schema and the ADR-0001 axes dispatch on:
 *
 *   - `$0.05` on the ai-sdk flash cells (the weekly incumbent/challenger
 *     axis: `glm-5.3-flash`, `deepseek-flash`);
 *   - `$0.10` on the claude-agent / subprocess / acp GLM lanes (the
 *     driver axis, all on the fixed served id);
 *   - `$1.00` on the frontier Claude cell (`claude-agent @
 *     claude-opus-5-5`, the ceiling reference — the CLI's ADR-0001 axis
 *     guard still refuses that model on a non-ai-sdk lane today, so the
 *     entry documents the envelope rather than opening the lane).
 *
 * An EXACT table, not a `*-flash` pattern, on purpose: a pattern would
 * silently grant a cap to any future model id, and an unmapped cell must
 * fail CLOSED (the caller refuses the run) until the envelope is extended
 * deliberately — that is the whole point of "fail closed when missing".
 * The caps are cell-scoped in the accepted envelope; the ROLE (fixer vs
 * classifier) never changes the amount.
 */
export const D9_PER_CASE_USD: Readonly<Record<string, number>> = {
  'ai-sdk/glm-5.3-flash': 0.05,
  'ai-sdk/deepseek-flash': 0.05,
  'claude-agent/glm-5.3-flash': 0.1,
  'subprocess/glm-5.3-flash': 0.1,
  'acp/glm-5.3-flash': 0.1,
  'claude-agent/claude-opus-5-5': 1.0,
};

/**
 * W6.2: the D9 per-case USD cap for one cell, or undefined when the cell is
 * unmapped — undefined means the caller must fail closed (an explicit
 * --max-usd-per-case is then the only way to run the cell), never run
 * uncapped.
 */
export function d9PerCaseUsd(driver: string, model: string): number | undefined {
  return D9_PER_CASE_USD[`${driver}/${model}`];
}

/**
 * W6.2: absolute run USD cap = per-case budget × that suite's cases — the
 * USD mirror of `perSuiteTokenCap` (WB-1.6). The run governor counts
 * modeled cost cumulatively, so this is what turns a per-case budget into
 * an admission gate for lanes whose driver ignores `Budget.maxUsd`
 * (ai-sdk, acp): once cumulative modeled spend reaches the cap, further
 * cases are refused and become explicit budget-stop absences.
 *
 * USD is fractional, so the inputs validate as finite non-negative numbers
 * (not integers) and the product rounds to 6 decimals — 0.05 × 40 must be
 * exactly 2, never 2.0000000000000004, so the cap a manifest records is the
 * cap the governor compares against. There is no `extraTokens` analog: the
 * pre-runner probe reserves TOKENS only and observes no cost.
 */
export function perSuiteUsdCap(perCaseUsd: number, caseCount: number): number {
  if (!Number.isFinite(perCaseUsd) || perCaseUsd < 0) {
    throw new RangeError(`perSuiteUsdCap: perCaseUsd must be a finite non-negative number, got ${String(perCaseUsd)}`);
  }
  if (!Number.isSafeInteger(caseCount) || caseCount < 0) {
    throw new RangeError(`perSuiteUsdCap: caseCount must be a non-negative safe integer, got ${String(caseCount)}`);
  }
  return Math.round(perCaseUsd * caseCount * 1e6) / 1e6;
}
