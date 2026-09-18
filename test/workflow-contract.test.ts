import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Workflow-contract tripwire (J4 round-1 review): `.github/workflows/suite.yml`
// carries load-bearing honesty mechanics that no unit test executes — the
// I1 rc-exit discipline of the smoke loop and the matrix eval cells (rc>=2 is
// infrastructure and MUST hard-fail; rc 0/1 are eval outcomes and stay green),
// the snapshot job's post-failure guard, and — J5 — the five-cell axes
// matrix, the unit-test-tree excision, and the acp preflight skip wiring.
// This file reads the workflow AS TEXT and asserts the substrings those
// mechanics are spelled with.
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
 * The 0-based line of a step's `name:` line in the workflow text. Throws
 * when the step is missing, so a restructuring of suite.yml fails the
 * tripwire loudly instead of asserting against a missing step.
 */
function stepLine(namePrefix: string): number {
  const at = text.split('\n').findIndex((l) => l.startsWith(`      - name: ${namePrefix}`));
  if (at === -1) {
    throw new Error(`workflow-contract tripwire: step '${namePrefix}' not found in suite.yml — was the workflow restructured?`);
  }
  return at;
}

/**
 * Slice one step's YAML chunk out of the workflow text: from the line
 * `      - name: <namePrefix>` to the next step marker (`      - name:`) or
 * the next two-space-indented job key, whichever comes first. Deliberately
 * naive — see the prose-coupling note above.
 */
function stepChunk(namePrefix: string): string {
  const lines = text.split('\n');
  const start = stepLine(namePrefix);
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

/**
 * The matrix `cell:` block: from the `cell:` key (eight spaces) to the
 * `steps:` key (four spaces). Deliberately naive like every helper here —
 * throws when either anchor is missing so a restructuring fails loudly.
 */
function matrixChunk(): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === '        cell:');
  // The FIRST `steps:` key AFTER the cell block — the smoke job's own
  // `steps:` sits earlier in the file and must not bound the slice.
  const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && l === '    steps:');
  if (start === -1 || end === -1) {
    throw new Error('workflow-contract tripwire: matrix cell block not found in suite.yml — was the workflow restructured?');
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Each matrix cell as a raw entry chunk: every entry begins at
 * `- axis:` (ten spaces) and runs to the next entry or the block end.
 */
function matrixCells(): string[] {
  const lines = matrixChunk().split('\n');
  const starts = lines.flatMap((l, i) => (l.startsWith('          - axis:') ? [i] : []));
  if (starts.length === 0) {
    throw new Error('workflow-contract tripwire: no `- axis:` entries found under cell: — was the workflow restructured?');
  }
  return starts.map((s, n) => lines.slice(s, n + 1 < starts.length ? starts[n + 1] : lines.length).join('\n'));
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

  it('the matrix is the J5 five-cell axes matrix (ADR-0001 revised 2026-09-14)', () => {
    // Axis 1 — models vary on ai-sdk; axis 2 — the driver lanes vary on the
    // FIXED served GLM id over Z.AI only. The ai-sdk@glm-5.3-flash cell
    // carries BOTH axes' evidence and runs ONCE: 2 model cells + 3 driver
    // cells = 5.
    const cells = matrixCells();
    expect(cells).toHaveLength(5);
    const lanes = ['ai-sdk', 'claude-agent', 'subprocess', 'acp'];
    const drivers = cells.map((c) => c.match(/driver: (\S+)/)?.[1]);
    const models = cells.map((c) => c.match(/model: (\S+)/)?.[1]);
    for (const cell of cells) {
      const axis = cell.match(/axis: (\S+)/)?.[1];
      const driver = cell.match(/driver: (\S+)/)?.[1];
      expect(['model', 'driver'], `cell axis must be model|driver, got '${axis}'`).toContain(axis);
      expect(lanes, `cell driver must be a toolkit lane, got '${driver}'`).toContain(driver);
      if (driver !== 'ai-sdk') {
        // Axis-2 discipline: a non-ai-sdk lane pins the fixed served id on
        // Z.AI only (the runner's axis guard enforces the same pairing).
        expect(cell.match(/model: (\S+)/)?.[1], 'non-ai-sdk cell pins glm-5.3-flash').toBe('glm-5.3-flash');
        expect(cell.match(/provider: (\S+)/)?.[1], 'non-ai-sdk cell runs on zai').toBe('zai');
        expect(axis, 'a non-ai-sdk lane IS the driver axis').toBe('driver');
      }
    }
    // Axis-1 spread: deepseek-chat exactly once, glm-5.3-flash on the other
    // four cells, ai-sdk exactly twice (one per model) — and the fixed
    // served id's ai-sdk point is ONE cell, not one per axis.
    expect(models.filter((m) => m === 'deepseek-chat')).toHaveLength(1);
    expect(models.filter((m) => m === 'glm-5.3-flash')).toHaveLength(4);
    expect(drivers.filter((d) => d === 'ai-sdk')).toHaveLength(2);
    expect(cells.filter((c) => c.includes('driver: ai-sdk') && c.includes('model: glm-5.3-flash'))).toHaveLength(1);
    // One cell's hard failure must not kill the others' evidence.
    expect(text).toContain('fail-fast: false');
  });

  it('the unit-test tree is excised before any model-facing step (review-debt 11)', () => {
    // test/micro.test.ts carries the micro suites' reference fixes: a
    // model-driven worker with host-privileged tools must not be able to
    // read them from the checkout it works in (answer lookup). The step must
    // actually remove test/, run in EVERY cell (no if:), and precede the
    // eval step; the runner is self-contained under runner/, so nothing else
    // needs the tree.
    const excision = stepChunk('Excise the unit-test tree');
    expect(excision).toContain('rm -rf test/');
    expect(excision).toContain('review-debt #11');
    expect(excision, 'the excision runs in every cell (no if:)').not.toContain('if:');
    expect(stepLine('Excise the unit-test tree')).toBeLessThan(stepLine('Eval cell —'));
  });

  it('the acp lane is gated by the auth preflight and skips LOUDLY but green', () => {
    // Credential asymmetry: the other four cells' keys are repo secrets
    // (absence = misconfiguration = runner hard-fail pre-dispatch); the acp
    // lane's credentials are agent-side and legitimately cannot exist in CI
    // today. A blocked lane must warn, hit the step summary, and set
    // skip=true — and the eval step must condition on that output — so the
    // lane is honestly absent from the run, never published as data.
    const preflight = stepChunk('ACP headless auth preflight');
    expect(preflight).toContain('id: acp_preflight');
    expect(preflight).toContain("if: matrix.cell.driver == 'acp'");
    expect(preflight, 'the probe is bounded').toContain('timeout 150');
    expect(preflight).toContain('::warning::acp cell blocked');
    expect(preflight).toContain('GITHUB_STEP_SUMMARY');
    expect(preflight, 'the skip flag drives the eval gate').toContain('echo "skip=true" >> "${GITHUB_OUTPUT}"');
    expect(stepChunk('Eval cell —')).toContain(
      "if: matrix.cell.driver != 'acp' || steps.acp_preflight.outputs.skip != 'true'",
    );
  });

  it('the eval step dispatches the CELL driver and nests out dirs by model/driver (G7)', () => {
    const evalCell = stepChunk('Eval cell —');
    expect(evalCell).toContain('MATRIX_DRIVER: ${{ matrix.cell.driver }}');
    expect(evalCell).toContain('--driver "${MATRIX_DRIVER}"');
    expect(evalCell).toContain('--driver-name "${MATRIX_DRIVER}"');
    // Same-model driver cells must never collide on one table; the snapshot
    // identity nests <date>/<model>/<driver>/<role>/<suite>/ off this path.
    expect(evalCell).toContain('out_dir="reports/eval/${MATRIX_MODEL}/${MATRIX_DRIVER}/${rel_dir}"');
    // DD-9: a token cap binds alone on every cell — never a USD cap.
    expect(evalCell).toContain('--max-tokens 200000');
    // The worklist rides stdin; the driver must never eat it.
    expect(evalCell).toContain('< /dev/null');
  });

  it('lane installs are conditional: subprocess claude-code pinned, acp pinned 0.43.3, claude-agent none', () => {
    const sub = stepChunk('Install the subprocess lane CLI');
    expect(sub).toContain("if: matrix.cell.driver == 'subprocess'");
    expect(sub).toContain('npm install -g @anthropic-ai/claude-code@2.1.276');
    const acp = stepChunk('Install the acp lane harness');
    expect(acp).toContain("if: matrix.cell.driver == 'acp'");
    // PINNED to the probed version (2026-09-19): >=0.43 moved the stdio ACP
    // bridge into the `server` subcommand — the version the runner's
    // explicit argv (runner/cli.ts ACP_COMMAND) invokes must be this line.
    expect(acp).toContain('npm install -g zcode-acp-server@0.43.3');
    // The claude-agent lane installs nothing: its optional peer ships as a
    // devDependency (npm ci provides it). No step may gate on that driver.
    expect(text).not.toContain("if: matrix.cell.driver == 'claude-agent'");
    expect(text).toContain('@anthropic-ai/claude-agent-sdk ships as a devDependency');
  });

  it('the per-cell artifact coupling holds: cell-scoped name, pattern download, merge-multiple', () => {
    // These three substrings are ONE contract: the matrix cells upload under
    // a cell-scoped artifact name (upload-artifact v4 requires unique names;
    // J5: the name is model+driver, the cell's full identity — same-model
    // driver cells must not share a name), and the snapshot job re-joins the
    // cells via a pattern + merge-multiple download (its eval-reports-* glob
    // still matches the longer names). A drift in any of them degrades
    // SILENTLY — the download zero-matches (v4 succeeds on zero matches),
    // the push guard turns the snapshot into a no-op — and snapshots stop
    // publishing while every job stays green.
    expect(text).toContain('name: eval-reports-${{ matrix.cell.model }}-${{ matrix.cell.driver }}');
    expect(text).toContain('pattern: eval-reports-*');
    expect(text).toContain('merge-multiple: true');
  });

  it('I4 holds: unfiltered on:, job-level event ifs, persist-credentials discipline', () => {
    // The `on:` block stays free of filter keys (the denylist self-test's
    // workflow sanity scan reads the same shape); the matrix and snapshot
    // jobs carry the dispatch/schedule restriction at the JOB level — the
    // one allowed restriction — and model-driven code never sees persisted
    // checkout credentials (only the snapshot job, a pure data operation,
    // persists them).
    // Anchors are validated before slicing: a missing or misordered anchor
    // fails loudly instead of yielding an oversized slice that could mask a
    // filter key living outside the real on: block.
    const onBlock = (() => {
      const start = text.indexOf('\non:\n');
      const end = text.indexOf('\npermissions:', start);
      expect(start, 'on: anchor exists').toBeGreaterThanOrEqual(0);
      expect(end, 'permissions: anchor follows on:').toBeGreaterThan(start);
      return text.slice(start, end);
    })();
    for (const banned of ['paths:', 'paths-ignore:', 'branches:', 'branches-ignore:', 'tags:', 'tags-ignore:']) {
      expect(onBlock, `on: block must stay filter-free (${banned})`).not.toContain(banned);
    }
    for (const event of ['push:', 'pull_request:', 'workflow_dispatch:', 'schedule:']) {
      expect(onBlock, `on: declares ${event}`).toContain(event);
    }
    const matrixJob = text.slice(text.indexOf('\n  matrix:\n'), text.indexOf('\n  snapshot:\n'));
    expect(matrixJob).toContain("if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'");
    expect(matrixJob).toContain('persist-credentials: false');
    const snapshotJob = text.slice(text.indexOf('\n  snapshot:\n'));
    expect(snapshotJob).toContain('persist-credentials: true');
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
