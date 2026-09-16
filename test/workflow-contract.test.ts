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

/**
 * The BENIGN leg of the rc taxonomy: the `-eq 1` branch body — bounded at
 * whichever comes first after the marker: the closing `fi` of the branch
 * (first line that is exactly `fi`, however indented) or a following `-ge 2`
 * marker (a reorder guard). Bounding at the `fi` — instead of end-of-chunk —
 * matters for the matrix chunk: its zero-discovery warning sits AFTER the
 * loop, OUTSIDE the branch, and an unbounded slice would let that outside
 * warning satisfy the branch assertion.
 */
function benignBranch(chunk: string): string {
  const start = chunk.indexOf('-eq 1');
  expect(start, "chunk carries a '-eq 1' branch").toBeGreaterThan(-1);
  // Absolute offset of the branch's closing `fi` line within the chunk.
  let fiAbs = -1;
  let acc = start;
  for (const line of chunk.slice(start).split('\n')) {
    if (line.trim() === 'fi') {
      fiAbs = acc;
      break;
    }
    acc += line.length + 1;
  }
  const bounds = [chunk.indexOf('-ge 2', start), fiAbs].filter((i) => i > start);
  const end = bounds.length > 0 ? Math.min(...bounds) : chunk.length;
  return chunk.slice(start, end);
}

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

  it('rc 1 is trusted only with an emitted table: both loops carry the table-existence guard', () => {
    // cliMain's exit 1 CONFLATES a scored-zero run (benign — tables emitted)
    // with a run-phase throw mid-scoring/journal/validation (tables missing
    // or partial). The workflow must not take rc 1's word for it: after the
    // rc branch, each loop re-checks that the suite's per-role table
    // actually landed before treating the run as benign — otherwise a suite
    // dying mid-emit on the last suite reports success and the snapshot's
    // full-success path replaces complete data with incomplete data.
    for (const { label, chunk } of [
      { label: 'smoke', chunk: stepChunk('Fake-driver smoke over the micro suites') },
      { label: 'matrix eval cell', chunk: stepChunk('Eval cell —') },
    ] as const) {
      expect(chunk, `${label}: table-existence guard`).toContain('-f "${out_dir}/${role}.table.json"');
      expect(chunk, `${label}: guard names the run-phase failure`).toContain('run-phase failure, not a scored outcome');
    }
  });

  it('the per-cell artifact coupling holds: cell-scoped name, pattern download, merge-multiple', () => {
    // These three substrings are ONE contract: the matrix cells upload under
    // a cell-scoped artifact name (upload-artifact v4 requires unique
    // names), and the snapshot job re-joins the cells via a pattern +
    // merge-multiple download. A drift in any of them degrades SILENTLY —
    // the download zero-matches (v4 succeeds on zero matches), the push
    // guard turns the snapshot into a no-op — and snapshots stop publishing
    // while every job stays green.
    expect(text).toContain('name: eval-reports-${{ matrix.cell.model }}');
    expect(text).toContain('pattern: eval-reports-*');
    expect(text).toContain('merge-multiple: true');
  });

  it('the BENIGN leg stays benign: the -eq 1 branch notices/warns and never sets hard_fail', () => {
    // rc 1 (scored zero / budget-gated) is GREEN by design (I1): the branch
    // must surface its own marker — ::notice:: on the smoke loop, ::warning::
    // on the matrix eval cell — and must NOT touch hard_fail, so a benign
    // outcome can never be reclassified into a job failure (nor a hard fail
    // hidden as a warning).
    const cases = [
      { label: 'smoke', chunk: stepChunk('Fake-driver smoke over the micro suites'), marker: '::notice::' },
      { label: 'matrix eval cell', chunk: stepChunk('Eval cell —'), marker: '::warning::' },
    ] as const;
    for (const { label, chunk, marker } of cases) {
      const benign = benignBranch(chunk);
      expect(benign, `${label}: -eq 1 branch must carry ${marker}`).toContain(marker);
      expect(benign, `${label}: -eq 1 branch must NOT set hard_fail=1 (rc 1 is green)`).not.toContain('hard_fail=1');
    }
  });
});
