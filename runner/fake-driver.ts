import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';

/**
 * Deterministic offline Driver for plumbing smoke and CI. It stands in for a
 * real toolkit lane (pass --driver-name to label the row with the lane it
 * impersonates — the row schema's driver enum only accepts the four toolkit
 * lanes) so the runner's wiring — suites, governor, journal, scorers,
 * aggregation — can be exercised with zero network and zero spend.
 *
 * HONESTY NOTES (this fake does not pretend to be real):
 *  - It echoes the REQUESTED model id back as the observed served id; a real
 *    driver reports what the wire actually served.
 *  - It carries NO costUSD: cost derivation is the runner's job via the
 *    toolkit price map (DD-9), and the fake must never pretend to be billed
 *    or priced.
 *  - It cannot fix fixtures: a fixer-worker case scored against it fails
 *    unless the seeded check already passes on the untouched fixture. That is
 *    correct plumbing-smoke behavior, NOT a scored eval result.
 */
export class FakeDriver implements Driver {
  async run(opInvocation: OpInvocation): Promise<WorkerResult> {
    // A tiny delay keeps wallTimeMs nonzero and the await boundary real.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      model: opInvocation.modelSpec.model,
      structuredOutput: { verdict: 'resolved' },
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete',
    };
  }
}
