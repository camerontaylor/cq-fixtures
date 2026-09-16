import { z } from 'zod';
import type { WorkerResult } from '@camerontaylor/cq-toolkit';
import type { ScoreOutcome } from '../score/fixerWorker.ts';

/**
 * DD-4 (2026-09-16): structured-output fidelity as a SCORED dimension. A
 * fixer-worker case now carries a second probe alongside its check-rerun:
 * the worker must declare its own verdict through the toolkit's structured
 * output channel ({fixed: boolean, notes: string}), and the runner grades
 * whether the model could HOLD that json shape. GLM/DeepSeek structured-
 * output fidelity is exactly what this makes visible — rows are per-model,
 * so a model that cannot hold the shape shows it in its score instead of in
 * a post-hoc anecdote.
 *
 * Scope guards:
 *  - The check-rerun probe and its judge are untouched; this probe is
 *    ADDITIVE (fixer rows move to outcome.total = 2), so per-model fidelity
 *    stays visible per row without changing what the check grades.
 *  - Sweep-agnostic by construction: it reads only the WorkerResult the
 *    driver already returned — no re-dispatch, no toolkit probe machinery.
 */

/**
 * The structured-output shape a fixer-worker dispatch asks the model for.
 * Passed to the driver at construction time (runner/cli.ts, the same F3/G6
 * seam where the classifier gets its verdict schema) and restated as the
 * schema-compliance probe's target below — one shape, two consumers.
 *
 * STRICT by design (cycle-2 CLI review): zod objects default-strip unknown
 * keys, which would let `{fixed, notes, verdict: 'whatever'}` pass
 * compliance while carrying an undeclared field — but DD-4 measures
 * json-SHAPE fidelity, so strictness is the point: any key outside the
 * declared shape fails the probe.
 */
export const FIXER_OUTPUT_SCHEMA = z
  .object({
    fixed: z.boolean(),
    notes: z.string(),
  })
  .strict();

/**
 * Score the schema-compliance probe: PASS (1/1) iff the worker returned a
 * structuredOutput that parses against FIXER_OUTPUT_SCHEMA — both fields
 * present and correctly typed. Anything else (missing structuredOutput,
 * verdict-shaped output, wrong field types) scores 0 with a one-line
 * diagnostic and never throws: an answer that cannot hold the shape is
 * evidence of exactly the failure this dimension measures, not a reason to
 * abort the run (I9 — same posture as scoreReviewClassifier).
 */
export function scoreSchemaCompliance(workerResult: WorkerResult): ScoreOutcome {
  const parsed = FIXER_OUTPUT_SCHEMA.safeParse(workerResult.structuredOutput);
  if (parsed.success) return { score: 1, passed: 1, total: 1 };
  // One line, by contract: the first zod issue names the offending field
  // and why it failed — enough to diagnose without dumping the whole issue
  // list on stderr (the CLI prints only the first line of a diagnostic).
  const issue = parsed.error.issues[0];
  const at = issue !== undefined && issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return {
    score: 0,
    passed: 0,
    total: 1,
    diagnostics:
      `structuredOutput does not match the fixer output schema {fixed: boolean, notes: string} ` +
      `(${at}: ${issue?.message ?? 'unparseable'})`,
  };
}
