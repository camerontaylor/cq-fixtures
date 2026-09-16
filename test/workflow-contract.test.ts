import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Workflow-contract tripwire (J4 round-1 review): `.github/workflows/suite.yml`
// carries load-bearing honesty mechanics that no unit test executes — the
// I1 rc-exit discipline of the smoke loop and the matrix eval cells (rc>=2 is
// infrastructure and MUST hard-fail; rc 0/1 are eval outcomes and stay green),
// and the snapshot job's post-failure guard. This file reads the workflow AS
// TEXT and asserts the substrings those mechanics are spelled with.
//
// PROSE-COUPLING, admitted up front: this is a tripwire, not a parser. It
// does not parse YAML or evaluate GitHub expressions — reformatting the
// workflow (or changing quoting styles) can false-negative it, and the CI
// run itself remains the only ground truth. What it buys: the failure modes
// these strings prevent (zeros-while-green, a snapshot publish over no
// artifact) fail loudly here on the next `npm test` instead of silently on
// the next dispatch.

const SUITE_YML = fileURLToPath(new URL('../.github/workflows/suite.yml', import.meta.url));
const text = readFileSync(SUITE_YML, 'utf8');

/**
 * Slice one step's YAML chunk out of the workflow text: from the line
 * `      - name: <namePrefix>` to the next step marker (`      - name:`) or
 * the next two-space-indented job key, whichever comes first. Deliberately
 * naive — see the prose-coupling note above. A missing step throws, so a
 * restructuring of suite.yml fails the tripwire loudly instead of asserting
 * against an empty chunk.
 */
function stepChunk(namePrefix: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`      - name: ${namePrefix}`));
  if (start === -1) {
    throw new Error(`workflow-contract tripwire: step '${namePrefix}' not found in suite.yml — was the workflow restructured?`);
  }
  const end = lines.findIndex((l, i) => i > start && (l.startsWith('      - name:') || /^  \S/.test(l)));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

/** The three substrings that together spell the rc-exit discipline (I1). */
const RC_EXIT_DISCIPLINE = ['|| rc=$?', '-ge 2', 'exit "${hard_fail}"'] as const;

describe('suite.yml workflow contract (text tripwire, not a parser)', () => {
  it('the smoke loop hard-fails on rc>=2 (rc capture, -ge 2 branch, exit "${hard_fail}")', () => {
    const smoke = stepChunk('Fake-driver smoke over the micro suites');
    for (const marker of RC_EXIT_DISCIPLINE) {
      expect(smoke, `smoke step must carry '${marker}'`).toContain(marker);
    }
  });

  it('the matrix eval cell carries the same rc>=2 hard-fail shape', () => {
    const evalCell = stepChunk('Eval cell —');
    for (const marker of RC_EXIT_DISCIPLINE) {
      expect(evalCell, `matrix eval cell must carry '${marker}'`).toContain(marker);
    }
  });

  it("the snapshot job's if: requires !cancelled() AND needs.matrix.result != 'skipped'", () => {
    // Scope to the snapshot JOB so a stray match in another job's comments
    // cannot satisfy the guard: the first four-space `if:` after the
    // `  snapshot:` job key is the job-level condition.
    const start = text.indexOf('\n  snapshot:\n');
    expect(start, 'snapshot job section exists').toBeGreaterThan(-1);
    const ifLine = text.slice(start).split('\n').find((l) => l.startsWith('    if:'));
    expect(ifLine, 'snapshot job declares a job-level if:').toBeDefined();
    expect(ifLine).toContain('!cancelled()');
    expect(ifLine).toContain("needs.matrix.result != 'skipped'");
  });
});
