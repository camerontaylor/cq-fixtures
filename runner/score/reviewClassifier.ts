import type { WorkerResult } from '@camerontaylor/cq-toolkit';
import type { ScoreOutcome } from './fixerWorker.ts';

export type { ScoreOutcome };

/**
 * The toolkit's classifyThreads verdict vocabulary. `classifyThreads` itself
 * is not on the toolkit's public export surface, so the runner mirrors the
 * same five values that schema/suite.schema.json constrains `probe.expected`
 * to — one source of truth at the schema, restated here for scoring.
 */
const VERDICTS = new Set(['actionable', 'responded', 'resolved', 'blocked', 'skip']);

/** Structural shape of an expected-verdict case (suite.schema.json, narrowed by loadSuite). */
interface ExpectedVerdictCase {
  probe: { kind: 'expected-verdict'; expected: string };
}

/**
 * Score a review-classifier case by comparing the classifier's verdict — read
 * from the WorkerResult's structuredOutput ({verdict: string}) — against the
 * probe's expected verdict. Missing or unparseable structuredOutput scores 0
 * with diagnostics and never throws: an unparseable answer is evidence of
 * failure, not a reason to abort the run (I9).
 */
export function scoreReviewClassifier(
  suiteCase: ExpectedVerdictCase,
  workerResult: WorkerResult,
): ScoreOutcome {
  if (suiteCase.probe.kind !== 'expected-verdict') {
    throw new Error(
      `scoreReviewClassifier: probe kind must be 'expected-verdict', got '${suiteCase.probe.kind}'`,
    );
  }
  const expected = suiteCase.probe.expected;
  const structured = workerResult.structuredOutput;
  const verdict =
    typeof structured === 'object' && structured !== null && 'verdict' in structured
      ? (structured as { verdict: unknown }).verdict
      : undefined;
  if (typeof verdict !== 'string') {
    return {
      score: 0,
      passed: 0,
      total: 1,
      observed: null,
      diagnostics: `missing or unparseable structuredOutput.verdict (expected '${expected}')`,
    };
  }
  if (!VERDICTS.has(verdict)) {
    return {
      score: 0,
      passed: 0,
      total: 1,
      observed: verdict,
      diagnostics: `verdict '${verdict}' is outside the classifyThreads vocabulary (expected '${expected}')`,
    };
  }
  const passed = verdict === expected;
  return {
    score: passed ? 1 : 0,
    passed: passed ? 1 : 0,
    total: 1,
    // F4: the observed verdict rides along so the runner can capture it
    // into the row's probes[] — the confusion matrix is computed from
    // rows.jsonl, and the outcome triple alone cannot supply it.
    observed: verdict,
    ...(passed ? {} : { diagnostics: `verdict '${verdict}' did not match expected '${expected}'` }),
  };
}
