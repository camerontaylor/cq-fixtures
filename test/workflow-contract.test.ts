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
    const smoke = stepChunk('Fake-driver smoke over the micro and breadth suites');
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
    // Axis-1 spread: deepseek-flash exactly once, glm-5.3-flash on the other
    // four cells, ai-sdk exactly twice (one per model) — and the fixed
    // served id's ai-sdk point is ONE cell, not one per axis.
    expect(models.filter((m) => m === 'deepseek-flash')).toHaveLength(1);
    // WB-1.5a served-id rule: the deepseek cell requests the id the wire
    // serves, not the pre-2026-09-18 `deepseek-chat` request.
    const deepseekCell = cells.find((c) => c.includes('provider: deepseek'));
    expect(deepseekCell, 'the deepseek model-axis cell exists').toBeDefined();
    expect(deepseekCell).toContain('model: deepseek-flash');
    expect(cells.some((c) => c.includes('model: deepseek-chat'))).toBe(false);
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
    expect(excision).toContain('rm -rf test/ .git');
    expect(excision).toContain('review-debt #11');
    expect(excision, 'the excision runs in every cell (no if:)').not.toContain('if:');
    // Cycle-2 review: the worktree copy alone is not enough — the shallow
    // clone's object store holds the HEAD tree's blobs, so .git must go too.
    expect(excision).toContain('.git');
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
    // Cycle-2 review, exit-status discipline: ONLY the confirmed
    // no-agent-output class (3, with the timeout's 124 mapped in) skips —
    // every other non-zero is a hard step failure, never a silent lane
    // omission.
    expect(preflight, 'timeout maps into the skip class').toContain('if [ "${rc}" -eq 124 ]; then');
    expect(preflight, 'only rc 3 reaches the skip path').toContain('if [ "${rc}" -eq 3 ]; then');
    expect(preflight, 'other failures propagate, loud').toContain('::error::acp preflight failed');
    expect(preflight, 'other failures propagate, loud').toContain('exit 1');
    // Round-1 review hardening: auth-OK must be a JSON-RPC message, never a
    // bare stdout line (a login-blocked harness narrates to stdout), a dying
    // stdin must not EPIPE-crash the probe into the hard-fail branch, and
    // the skip must be visible to the snapshot job so a skipped run MERGES
    // into the dated dir instead of clearing earlier same-day acp tables.
    // Round-1 review hardening: auth-OK must be the agent's own reply
    // (agent_message_chunk), never a bare or protocol stdout line (a
    // login-blocked harness narrates to stdout; the harness streams
    // bookkeeping with zero credentials), a dying stdin must not
    // EPIPE-crash the probe into the hard-fail branch.
    expect(preflight, 'auth-OK is the agent reply only').toContain('upd.sessionUpdate === "agent_message_chunk"');
    expect(preflight, 'no unhandled EPIPE on stdin').toContain('child.stdin.on("error"');
    // Round-2 review: the skip rides the ARTIFACT (a marker file), never a
    // matrix job output — outputs merge last-writer-wins across legs, so
    // the four non-acp legs would erase the acp leg's skip and the
    // snapshot's clear-on-success would wipe earlier same-day acp tables.
    // The 124 timeout keeps its own honest diagnosis (blocked, cause not
    // established) instead of claiming credentials.
    expect(text, 'no racy job-output transport').not.toContain('acp_skipped');
    expect(preflight, 'the skip marker rides the artifact').toContain('touch reports/eval/ACP-SKIPPED');
    expect(preflight, 'timeout keeps its own honest wording').toContain('no agent output within 150s');
    expect(stepChunk('Commit report snapshots')).toContain('reports/eval/ACP-SKIPPED');
  });

  it('the auth-OK probe leaves a record the eval cell accounts against the token cap (review-debt #14)', () => {
    // The preflight probe IS a real model request before the runner exists —
    // without this wiring its spend sits outside the cell --max-tokens
    // governor and the NDJSON journal with no usage recorded. The record
    // rides the eval artifact beside ACP-SKIPPED (never a job output, same
    // last-writer-wins rationale) and the snapshot ignores it.
    const preflight = stepChunk('ACP headless auth preflight');
    expect(preflight, 'auth-OK writes the probe record').toContain('writeFileSync("reports/eval/ACP-PROBE.json"');
    expect(preflight, 'the record carries the probe facts').toContain('acp-auth-preflight');
    expect(preflight, 'the record carries the probe facts').toContain('Reply with the single word ready.');
    expect(preflight, 'auth-OK without a record hard-fails').toContain('! -f reports/eval/ACP-PROBE.json');
    const evalCell = stepChunk('Eval cell —');
    expect(evalCell, 'the acp cell passes the record into the runner').toContain('--probe-record reports/eval/ACP-PROBE.json');
    expect(evalCell, 'the flag is acp-only').toContain('if [ "${MATRIX_DRIVER}" = "acp" ]');
    expect(stepChunk('Commit report snapshots'), 'F6: the snapshot publishes the predictions + manifest beside the tables').toContain("-name '*.table.json'");
    expect(stepChunk('Commit report snapshots'), 'F6: rows.jsonl (regrade input) is published').toContain("-name 'rows.jsonl'");
    expect(stepChunk('Commit report snapshots'), 'F6: run.json (toolkit.lock/suite-SHA manifest) is published').toContain("-name 'run.json'");
    expect(stepChunk('Commit report snapshots'), 'F6: worker patches are published').toContain("-path '*/patches/*'");
    expect(stepChunk('Commit report snapshots'), 'F6: classifier outputs are published').toContain("-path '*/outputs/*'");
  });

  it('the eval step dispatches the CELL driver and nests out dirs by model/driver (G7)', () => {
    const evalCell = stepChunk('Eval cell —');
    expect(evalCell).toContain('MATRIX_DRIVER: ${{ matrix.cell.driver }}');
    expect(evalCell).toContain('--driver "${MATRIX_DRIVER}"');
    expect(evalCell).toContain('--driver-name "${MATRIX_DRIVER}"');
    // Same-model driver cells must never collide on one table; the snapshot
    // identity nests <date>/<model>/<driver>/<variant?>/<role>/<suite>/ off
    // this path (F6/CQ-4 adds the <variant?>/ segment only when non-default).
    expect(evalCell).toContain('out_dir="reports/eval/${MATRIX_MODEL}/${MATRIX_DRIVER}/${variant_prefix}${rel_dir}"');
    expect(evalCell, 'F6: the variant segment is empty for the default posture').toContain('if [ "${variant}" != "default" ]; then variant_prefix="${variant}/"; fi');
    expect(evalCell, 'F6: an unsafe variant fails the cell loudly').toContain('invalid variant');
    expect(evalCell, 'F6: the variant rides the suite.json the runner loads').toContain('${suite_dir}/suite.json');
    // DD-9: a token cap binds alone on every cell — never a USD cap.
    // WB-1.6: the cap is PER CASE and the runner scales it by the suite's
    // case count; the retired flat per-invocation cap must not return.
    expect(evalCell).toContain('--max-tokens-per-case 60000');
    expect(evalCell, 'the flat per-invocation cap is gone').not.toContain('--max-tokens 200000');
    expect(evalCell, 'DD-9: no USD cap rides the cells').not.toContain('--max-usd');
    // The worklist rides stdin; the driver must never eat it.
    expect(evalCell).toContain('< /dev/null');
  });

  it('driver-cause classification: a non-model cause publishes a loud dispatch-only absence via run.json (F1b/WB-1)', () => {
    // F1b removed the static skip_roles pre-skip (the F1 workaround): every
    // cell dispatches and the RUNNER classifies each driver error from its
    // class token — an unparseable structured output is a real scored-miss
    // row, any other cause publishes no row. The eval step reads the
    // runner's run.json absences[] and renders the loud absence (warning +
    // step summary + marker) that the old pre-skip used to.
    const cells = matrixCells();
    for (const cell of cells) {
      expect(cell, 'the static role skip is gone — the runner classifies').not.toContain('skip_roles:');
      expect(cell, 'the static skip reason is gone').not.toContain('skip_reason:');
    }
    const evalCell = stepChunk('Eval cell —');
    expect(evalCell, 'the SKIP_ROLES env is gone').not.toContain('SKIP_ROLES');
    expect(evalCell, 'the SKIP_REASON env is gone').not.toContain('SKIP_REASON');
    expect(evalCell, 'the pre-runner role skip is gone').not.toContain('skipped (dispatch-only)');
    // The runner invocation is unconditional now (the pre-skip `continue`
    // before it is gone): each discovered suite dispatches.
    const runnerAt = evalCell.indexOf('node --experimental-strip-types runner/index.ts');
    expect(runnerAt, 'the eval cell invokes the runner').toBeGreaterThan(-1);
    // The absence rendering reads the runner's manifest ...
    expect(evalCell).toContain('${out_dir}/run.json');
    expect(evalCell).toContain('absences');
    expect(evalCell).toContain('::warning::');
    expect(evalCell).toContain('${GITHUB_STEP_SUMMARY}');
    expect(evalCell).toContain('DISPATCH-ONLY-');
    // ... and drops the marker AFTER the runner ran (it used to precede it).
    expect(evalCell.indexOf('DISPATCH-ONLY-')).toBeGreaterThan(runnerAt);
    // The discovery count still advances exactly once per suite.
    expect(evalCell.match(/suite_count=\$\(\(suite_count \+ 1\)\)/g)).toHaveLength(1);
    // The marker dir must exist before the loop.
    expect(evalCell.indexOf('mkdir -p reports/eval')).toBeGreaterThan(-1);
    expect(evalCell.indexOf('mkdir -p reports/eval')).toBeLessThan(evalCell.indexOf('DISPATCH-ONLY-'));
    // The snapshot job must not clear a same-day dir that held real data.
    const snapshotStep = stepChunk('Commit report snapshots');
    expect(snapshotStep).toContain('DISPATCH-ONLY-*');
    // ... and it must withhold an empty-but-valid table whose run.json
    // records dispatch-only absences: the absence belongs in run.json, not
    // in a zero-cell table that reads as "0 cases" (CodeRabbit cycle 1).
    expect(snapshotStep).toContain('run.json');
    expect(snapshotStep).toContain('absences');
    expect(snapshotStep).toContain('.table.json');
    expect(snapshotStep).toContain('skipping empty dispatch-only table');
    // CodeRabbit App thread 4: bind the `continue` to the dispatch-only
    // skip branch by ORDER (an unrelated `continue` elsewhere in the step
    // must not satisfy it): the skip `if` precedes its diagnostic, which
    // precedes the `continue`, whose very next token is that branch's `fi`.
    const skipBranchAt = snapshotStep.indexOf('if [ "${table_fate}" = "skip" ]; then');
    const skipNoteAt = snapshotStep.indexOf('skipping empty dispatch-only table');
    const skipContinueAt = snapshotStep.indexOf('continue', skipNoteAt);
    expect(skipBranchAt, 'the table_fate skip branch exists').toBeGreaterThan(-1);
    expect(skipNoteAt, 'the diagnostic sits inside the skip branch').toBeGreaterThan(skipBranchAt);
    expect(skipContinueAt, 'the continue follows the diagnostic').toBeGreaterThan(skipNoteAt);
    expect(
      snapshotStep.slice(skipContinueAt + 'continue'.length).trimStart().startsWith('fi'),
      'the continue is the last statement of the skip branch',
    ).toBe(true);
    // CodeRabbit App thread 1: an unreadable/malformed sibling run.json now
    // FAILS the step (::error:: + exit 1) instead of publishing the table.
    expect(snapshotStep, 'a bad manifest fails the snapshot step').toContain(
      '::error::snapshot: cannot read run.json beside',
    );
    expect(snapshotStep).toContain('exit 1');
    expect(snapshotStep, 'no warn-and-keep fallback remains').not.toContain('manifest-error');
    // F1b r1: the untrusted endpoint cause text is HTML-escaped before it
    // reaches the markdown step summary (the raw text stays in ::warning::).
    expect(evalCell, 'the summary absence line is HTML-escaped').toContain('escaped="$(printf');
    expect(evalCell).toContain('s/&/\\&amp;/g');
    expect(evalCell).toContain('- dispatch-only absence: ${escaped}');
    // F1b r2: the ::warning:: annotation separately escapes workflow-command
    // `%` sequences (a literal %0A/%0D/%25 in endpoint cause text must not be
    // decoded into annotation line breaks), and BOTH node run.json helpers fail
    // closed on a valid-JSON-but-wrong-shape manifest (`runs` not an array)
    // instead of reading it as absence-free.
    expect(evalCell, 'the annotation escapes workflow-command % sequences').toContain('s/%/%25/g');
    expect(evalCell, 'the eval manifest read guards its shape').toContain('Array.isArray(doc.runs)');
    expect(snapshotStep, 'the snapshot manifest read guards its shape').toContain('Array.isArray(manifest.runs)');
    // F1b r3: a malformed manifest read in the EVAL step fails the cell loudly
    // (::error:: + hard_fail) instead of a bare `set -e` exit with no
    // diagnostic, and the snapshot's table-shape read guards `cells` too.
    expect(evalCell, 'the eval absence read fails loud with a diagnostic').toContain(
      'cannot read ${out_dir}/run.json — absence records unknown',
    );
    expect(evalCell, 'the eval absence read sets hard_fail').toMatch(/hard_fail=1\n\s+absent_lines=""/);
    expect(snapshotStep, 'the snapshot table read guards its shape').toContain('Array.isArray(table.cells)');
  });

  it('deprecated/ suites are excluded from matrix discovery (F2, WB-2.1)', () => {
    // Retirement moves a case to a sibling deprecated/ suite, never renumbers
    // it — and a retired suite must never spend weekly tokens. The discovery
    // find must drop any path carrying a deprecated/ segment, so widening the
    // roots later cannot silently re-enable a retired suite.
    const evalCell = stepChunk('Eval cell —');
    expect(evalCell, 'the suite find drops deprecated/ suites').toContain("-not -path '*/deprecated/*'");
    expect(evalCell, 'the exclusion rides the suite.json discovery find').toMatch(/-name suite\.json -not -path/);
  });

  it('the dispatch profile selects the discovery roots (F3, WB-2.5)', () => {
    // `verified` runs only the breadth-verified suites; `full` (the default,
    // and the weekly schedule's value) runs every suite. Scope the assertions
    // to the workflow_dispatch.inputs.profile block so unrelated text (suite
    // paths elsewhere) cannot satisfy them.
    const profileIdx = text.indexOf('\n      profile:\n');
    expect(profileIdx, 'profile input declared under workflow_dispatch.inputs').toBeGreaterThan(-1);
    const profileBlock = text.slice(profileIdx, text.indexOf('\n  schedule:', profileIdx));
    expect(profileBlock, 'profile is a choice input').toContain('type: choice');
    expect(profileBlock, 'profile options include full').toContain('- full');
    expect(profileBlock, 'profile options include verified').toContain('- verified');
    expect(profileBlock, 'profile defaults to full').toContain('default: full');
    const evalCell = stepChunk('Eval cell —');
    expect(evalCell, 'eval step reads the profile').toContain("MATRIX_PROFILE: ${{ github.event.inputs.profile || 'full' }}");
    expect(evalCell, 'verified root').toContain('suites/fixer-worker/breadth-verified');
    expect(evalCell, 'tail root').toContain('suites/fixer-worker/breadth-tail');
    expect(evalCell, 'unknown profiles fail loud').toContain('unknown profile');
  });

  it('zero suite discovery hard-fails the matrix cell (F3)', () => {
    // An empty discovery (removed/broken root) must not let the cell succeed
    // with no tables — the snapshot's full-success path would clear the day.
    const evalCell = stepChunk('Eval cell —');
    expect(evalCell, 'zero discovery is a hard error').toContain('matrix discovery found no suites for profile');
    expect(evalCell, 'count drift stays a warning').toContain('matrix discovery found ${suite_count} suites (expected ${expected_count}');
  });

  it('the smoke loop exercises breadth-verified too (F3, WB-2.5)', () => {
    const smoke = stepChunk('Fake-driver smoke over the micro and breadth suites');
    expect(smoke, 'breadth-verified is smoked').toContain('suites/fixer-worker/breadth-verified');
    expect(smoke, 'per-suite out dirs avoid role collisions').toContain('out_dir="reports/smoke/${role}/${suite_name}"');
  });

  it('lane installs are conditional: subprocess claude-code pinned, acp pinned 0.43.3, claude-agent none', () => {
    const sub = stepChunk('Install the subprocess lane CLI');
    expect(sub).toContain("if: matrix.cell.driver == 'subprocess'");
    // WB-1.2 (F0 triage Lane 3): npm blocks lifecycle scripts by default,
    // so the package's postinstall never ran and every spawn exited 1 at
    // zero usage. The install must allow exactly this package's script.
    expect(sub).toContain('npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.276');
    // A silent postinstall failure must fail HERE, not as driver-error zeros.
    const subVerify = stepChunk('Verify the subprocess lane CLI is installed');
    expect(subVerify).toContain("if: matrix.cell.driver == 'subprocess'");
    expect(subVerify).toContain('claude --version');
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
      { label: 'smoke', chunk: stepChunk('Fake-driver smoke over the micro and breadth suites') },
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
      { label: 'smoke', chunk: stepChunk('Fake-driver smoke over the micro and breadth suites'), marker: '::notice::' },
      { label: 'matrix eval cell', chunk: stepChunk('Eval cell —'), marker: '::warning::' },
    ] as const;
    for (const { label, chunk, marker } of cases) {
      const benign = benignBranch(chunk);
      expect(benign, `${label}: -eq 1 branch must carry ${marker}`).toContain(marker);
      expect(benign, `${label}: -eq 1 branch must NOT set hard_fail=1 (rc 1 is green)`).not.toContain('hard_fail=1');
    }
  });
});
