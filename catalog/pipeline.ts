// Validation pipeline (plan WB-2.3; R6 digest §2). This is the runnable filter
// chain the lane used to produce and freeze every breadth case, and the module
// CI executes for both-states verification:
//
//   static annotation gate  — FAULT.json schema/catalog rules, exact declared
//                             `it()` titles, fix files present and faulted-different
//   reachability gate       — a materialized worker workspace cannot reach the
//                             record or its canonical fix (review-debt #11 class)
//   F2P gate                — the stored faulted state is red
//   100%-green baseline     — applying `validation.fix` is green
//   determinism ×N          — both states repeat identically (full mode)
//   P2P adequacy            — deleting the recorded statement from the fixed
//                             source is red (full mode)
//   format/tell pass        — the faulted→fixed diff carries no operator
//                             signature and is operator-sized (full mode)
//
// `full: false` runs the both-states subset (annotation, reachability, one
// faulted + one fixed run) — the every-case CI floor. `full: true` adds
// determinism ×3, the per-title JSON check, adequacy, and the tell pass.
//
// The pipeline never edits a fixture: `validation.fix` is applied to a
// materialized tmpdir copy, and the pristine fixture under repoRoot is never
// touched.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFaultFix, faultRecordAbsPath, loadFaultForFixture, type FaultRecord } from './fault.ts';
import { checkOperatorAssignment } from './operators.ts';
import { isFixerCase, loadSuite } from '../runner/suite.ts';

export const PIPELINE_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROBE_TIMEOUT_MS = 120_000;

export interface GateResult {
  readonly gate: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface CaseReport {
  readonly caseId: string;
  readonly fixture: string;
  readonly difficulty: string;
  readonly gates: readonly GateResult[];
  readonly pass: boolean;
}

export interface PipelineOptions {
  readonly repoRoot?: string;
  readonly determinismRuns?: number;
  readonly full?: boolean;
  readonly timeoutMs?: number;
}

export interface TestOutcome {
  readonly title: string;
  readonly status: string;
}

function gate(gateName: string, pass: boolean, detail: string): GateResult {
  return { gate: gateName, pass, detail };
}

/** The exact set of `it('…')` titles declared by a fixture's test files. */
export function declaredTitles(repoRoot: string, fixtureRef: string): Set<string> {
  const testDir = join(repoRoot, fixtureRef, 'test');
  const titles = new Set<string>();
  for (const file of walkFiles(testDir)) {
    if (!file.endsWith('.test.ts')) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bit(?:\.\w+)?\(\s*(['"`])([\s\S]*?)\1/g)) titles.add(match[2]!);
  }
  return titles;
}

/** Declared `it()` titles that appear more than once (per-title gates need uniqueness). */
export function duplicateTitles(repoRoot: string, fixtureRef: string): string[] {
  const counts = new Map<string, number>();
  for (const file of walkFiles(join(repoRoot, fixtureRef, 'test'))) {
    if (!file.endsWith('.test.ts')) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bit(?:\.\w+)?\(\s*(['"`])([\s\S]*?)\1/g)) {
      counts.set(match[2]!, (counts.get(match[2]!) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([title]) => title);
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** Materialize exactly as runner/index.ts does for a fixer case. */
export function materializeFixture(repoRoot: string, fixtureRef: string): string {
  const workspace = mkdtempSync(join(tmpdir(), 'cq-breadth-ws-'));
  cpSync(join(repoRoot, fixtureRef), workspace, { recursive: true, verbatimSymlinks: true });
  return workspace;
}

/** Spawn the fixture's immutable judge exactly as runner/score/fixerWorker.ts does. */
export function runJudge(repoRoot: string, checkRel: string, workspace: string, timeoutMs: number): { status: number; stderr: string } {
  const res = spawnSync(process.execPath, [join(repoRoot, checkRel)], { cwd: workspace, encoding: 'utf8', timeout: timeoutMs });
  if ((res.error !== undefined && res.error !== null) || res.status === null) {
    throw new Error(
      `judge spawn failed (infrastructure): ${(res.error as Error | undefined)?.message ?? `killed by signal ${res.signal ?? 'unknown'}`}`,
    );
  }
  return { status: res.status, stderr: res.stderr ?? '' };
}

/** Lines present in exactly one of two texts (multiset symmetric difference). */
export function changedLines(a: string, b: string): string[] {
  const counts = new Map<string, number>();
  for (const line of a.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of b.split('\n')) counts.set(line, (counts.get(line) ?? 0) - 1);
  const out: string[] = [];
  for (const [line, n] of counts) for (let i = 0; i < Math.abs(n); i++) out.push(line);
  return out;
}

/**
 * Files in a materialized workspace that leak the fault record: a FAULT.json
 * by name, any file carrying the record's marker key, any file whose full
 * content equals a canonical fix, or any file embedding a fix-side line. An
 * unreadable entry is fail-closed with a labeled leak.
 */
export function scanForFaultLeaks(workspace: string, fixtureRef: string, record: FaultRecord, repoRoot: string): string[] {
  const leaks: string[] = [];
  const fixValues = Object.values(record.validation.fix);
  const secretLines: string[] = [];
  for (const [rel, fixed] of Object.entries(record.validation.fix)) {
    const stored = readFileSync(join(repoRoot, fixtureRef, rel), 'utf8');
    const fixedLines = new Set(fixed.split('\n'));
    for (const line of changedLines(stored, fixed)) {
      if (line.trim().length >= 12 && fixedLines.has(line)) secretLines.push(line);
    }
  }
  for (const file of walkFiles(workspace)) {
    if (/\.FAULT\.json$/.test(file)) {
      leaks.push(`${relative(workspace, file)} (FAULT.json by name)`);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch (e) {
      leaks.push(`${relative(workspace, file)} (unreadable: ${(e as Error).message})`);
      continue;
    }
    if (content.includes('"failure_symptoms"')) leaks.push(`${relative(workspace, file)} (FAULT.json marker)`);
    else if (fixValues.some((fix) => fix === content)) leaks.push(`${relative(workspace, file)} (canonical fix content)`);
    else if (secretLines.some((line) => content.includes(line))) leaks.push(`${relative(workspace, file)} (canonical fix line)`);
  }
  return leaks;
}

/** Run the fixture's vitest suite with the JSON reporter for per-title outcomes. */
export function runVitestJson(
  repoRoot: string,
  workspace: string,
  outFile: string,
  timeoutMs: number,
): { status: number; tests: TestOutcome[] } {
  const res = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--root',
      workspace,
      '--config',
      join(repoRoot, 'fixtures', 'judge.vitest.config.mjs'),
      '--reporter=json',
      `--outputFile=${outFile}`,
    ],
    { cwd: workspace, encoding: 'utf8', timeout: timeoutMs },
  );
  if ((res.error !== undefined && res.error !== null) || res.status === null) {
    throw new Error(
      `vitest run failed (infrastructure): ${(res.error as Error | undefined)?.message ?? `killed by signal ${res.signal ?? 'unknown'}`}`,
    );
  }
  let report: { testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }> };
  try {
    report = JSON.parse(readFileSync(outFile, 'utf8')) as typeof report;
  } catch (e) {
    throw new Error(`vitest JSON report missing/unparseable (infrastructure): ${(e as Error).message}\n${(res.stderr ?? '').slice(-500)}`);
  }
  const tests = report.testResults.flatMap((f) => f.assertionResults.map((a) => ({ title: a.title, status: a.status })));
  return { status: res.status, tests };
}

function outcomeOf(tests: readonly TestOutcome[], title: string): string | undefined {
  return tests.find((t) => t.title === title)?.status;
}

const TELL_MARKERS = /\b(stryker|mutant|FAULT|BUG|TODO|XXX|MUTATION)\b/i;

/**
 * Run the filter chain for one fixture. Returns a per-gate report; the caller
 * decides how to surface it. Never throws for an eval-red case (that is a
 * gate result); throws only on genuinely unexpected infrastructure errors.
 */
export function runCasePipeline(fixtureRef: string, options: PipelineOptions = {}): CaseReport {
  const repoRoot = options.repoRoot ?? PIPELINE_REPO_ROOT;
  const full = options.full ?? false;
  const runs = options.determinismRuns ?? 3;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const gates: GateResult[] = [];
  const record = loadFaultForFixture(repoRoot, fixtureRef);
  const caseId = fixtureRef.split('/').pop() ?? fixtureRef;

  // --- static annotation gate -------------------------------------------
  const titles = declaredTitles(repoRoot, fixtureRef);
  const missingTitles = [...record.validation.f2p, ...record.validation.p2p].filter((t) => !titles.has(t));
  const dupes = duplicateTitles(repoRoot, fixtureRef);
  const bandProblems = record.operator
    .split('+')
    .map((id) => checkOperatorAssignment(id, record.difficulty))
    .filter((c) => !c.ok)
    .map((c) => (c as { reason: string }).reason);
  const fixProblems: string[] = [];
  for (const [rel, fixed] of Object.entries(record.validation.fix)) {
    let stored: string;
    try {
      stored = readFileSync(join(repoRoot, fixtureRef, rel), 'utf8');
    } catch {
      fixProblems.push(`${rel} is missing from the fixture`);
      continue;
    }
    if (stored === fixed) fixProblems.push(`${rel} is not faulted`);
  }
  const adequacyOk =
    record.adequacy !== undefined &&
    Object.keys(record.validation.fix).includes(record.adequacy.file) &&
    record.validation.fix[record.adequacy.file]!.includes(record.adequacy.delete);
  gates.push(
    gate(
      'annotation',
      missingTitles.length === 0 && dupes.length === 0 && bandProblems.length === 0 && fixProblems.length === 0 && adequacyOk,
      missingTitles.length > 0
        ? `missing titles: ${missingTitles.join('; ')}`
        : dupes.length > 0
          ? `duplicate titles: ${dupes.join('; ')}`
          : bandProblems.length > 0
            ? bandProblems.join('; ')
            : fixProblems.length > 0
              ? fixProblems.join('; ')
              : adequacyOk
                ? 'schema, catalog bands, unique titles, faulted-different fix, adequacy present'
                : 'adequacy target missing or not in a fixed file',
    ),
  );

  // --- reachability gate -------------------------------------------------
  const reachWorkspace = materializeFixture(repoRoot, fixtureRef);
  try {
    const leaks = scanForFaultLeaks(reachWorkspace, fixtureRef, record, repoRoot);
    gates.push(gate('reachability', leaks.length === 0, leaks.length === 0 ? 'no FAULT.json/fix leak in workspace' : leaks.join('; ')));
  } finally {
    rmSync(reachWorkspace, { recursive: true, force: true });
  }

  // --- execution gates ---------------------------------------------------
  const workspace = materializeFixture(repoRoot, fixtureRef);
  const reportDir = mkdtempSync(join(tmpdir(), 'cq-breadth-report-'));
  try {
    const checkRel = `fixtures/${caseId}/check.mjs`;
    const faultedRuns = full ? runs : 1;
    let faultedRed = true;
    let faultedDetail = 'stored faulted state is red';
    for (let i = 0; i < faultedRuns; i++) {
      const { status, stderr } = runJudge(repoRoot, checkRel, workspace, timeoutMs);
      for (const marker of ['refusing to judge', 'workspace escape', 'could not execute the vitest run']) {
        if (stderr.includes(marker)) {
          faultedRed = false;
          faultedDetail = `judge failed closed (infrastructure): ${marker}`;
        }
      }
      if (status === 0) {
        faultedRed = false;
        faultedDetail = `faulted run ${i + 1} was green`;
      }
    }
    gates.push(gate('f2p', faultedRed, faultedDetail));

    // Per-title F2P/P2P run in BOTH modes: a swapped f2p/p2p label must not
    // pass on aggregate red/green alone (tail cases included).
    const faultedJson = runVitestJson(repoRoot, workspace, join(reportDir, `${caseId}-faulted.json`), timeoutMs);
    const f2pBad = record.validation.f2p.filter((t) => outcomeOf(faultedJson.tests, t) !== 'failed');
    const p2pBad = record.validation.p2p.filter((t) => outcomeOf(faultedJson.tests, t) !== 'passed');
    gates.push(
      gate(
        'f2p-per-test',
        f2pBad.length === 0,
        f2pBad.length === 0 ? 'every declared f2p title fails in the faulted state' : `not failing: ${f2pBad.join('; ')}`,
      ),
    );
    gates.push(
      gate(
        'p2p-per-test',
        p2pBad.length === 0,
        p2pBad.length === 0 ? 'every declared p2p title passes in the faulted state' : `not passing: ${p2pBad.join('; ')}`,
      ),
    );

    applyFaultFix(record, workspace);
    const fixedRuns = full ? runs : 1;
    let fixedGreen = true;
    let fixedDetail = 'canonical fix is green';
    for (let i = 0; i < fixedRuns; i++) {
      const { status, stderr } = runJudge(repoRoot, checkRel, workspace, timeoutMs);
      for (const marker of ['refusing to judge', 'workspace escape', 'could not execute the vitest run']) {
        if (stderr.includes(marker)) {
          fixedGreen = false;
          fixedDetail = `judge failed closed (infrastructure): ${marker}`;
        }
      }
      if (status !== 0) {
        fixedGreen = false;
        fixedDetail = `fixed run ${i + 1} was red`;
      }
    }
    gates.push(gate('baseline', fixedGreen, fixedDetail));

    const fixedJson = runVitestJson(repoRoot, workspace, join(reportDir, `${caseId}-fixed.json`), timeoutMs);
    const allBad = [...record.validation.f2p, ...record.validation.p2p].filter((t) => outcomeOf(fixedJson.tests, t) !== 'passed');
    gates.push(gate('p2p-fixed', allBad.length === 0, allBad.length === 0 ? 'every declared title passes in the fixed state' : `not passing: ${allBad.join('; ')}`));

    if (full) {
      // adequacy: delete the recorded statement from the fixed source.
      const adequacy = record.adequacy;
      const fixedSource = adequacy !== undefined ? record.validation.fix[adequacy.file] : undefined;
      if (adequacy === undefined || fixedSource === undefined || !fixedSource.includes(adequacy.delete)) {
        gates.push(gate('adequacy', false, 'adequacy target missing or not present in the fixed source'));
      } else {
        const crippled = fixedSource.replace(adequacy.delete, '');
        writeFileSync(join(workspace, adequacy.file), crippled);
        const { status } = runJudge(repoRoot, checkRel, workspace, timeoutMs);
        gates.push(gate('adequacy', status !== 0, status !== 0 ? 'single-statement deletion is red' : 'deletion stayed green'));
      }

      // format/tell: the faulted→fixed diff is operator-sized and signature-free.
      const tellProblems: string[] = [];
      for (const [rel, fixed] of Object.entries(record.validation.fix)) {
        const stored = readFileSync(join(repoRoot, fixtureRef, rel), 'utf8');
        const changed = changedLines(stored, fixed);
        if (changed.length > 6) tellProblems.push(`${rel}: ${changed.length} changed lines`);
        if (TELL_MARKERS.test(changed.join('\n'))) tellProblems.push(`${rel}: operator signature marker`);
      }
      gates.push(gate('format', tellProblems.length === 0, tellProblems.length === 0 ? 'diff is operator-sized and signature-free' : tellProblems.join('; ')));
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
  }

  return {
    caseId,
    fixture: fixtureRef,
    difficulty: record.difficulty,
    gates,
    pass: gates.every((g) => g.pass),
  };
}

/** The FAULT.json sibling path must live outside the materialized fixture dir. */
export function assertRecordOutsideFixture(repoRoot: string, fixtureRef: string): boolean {
  const recordPath = faultRecordAbsPath(repoRoot, fixtureRef);
  const rel = relative(resolve(repoRoot, fixtureRef), recordPath);
  return rel.startsWith('..');
}

function main(argv: readonly string[]): number {
  let suiteDir: string | undefined;
  let full = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--suite') suiteDir = argv[++i];
    else if (flag === '--full') full = true;
    else {
      console.error(`unknown flag '${flag}'`);
      return 2;
    }
  }
  if (suiteDir === undefined) {
    console.error('usage: node --experimental-strip-types catalog/pipeline.ts --suite <dir> [--full]');
    return 2;
  }
  const cases = loadSuite(suiteDir).cases.filter(isFixerCase);
  let failed = 0;
  for (const c of cases) {
    const report = runCasePipeline(c.fixture, { full });
    console.log(`${report.pass ? 'PASS' : 'FAIL'} ${report.caseId} (${report.difficulty})`);
    for (const g of report.gates) if (!g.pass) console.log(`   ${g.gate}: ${g.detail}`);
    if (!report.pass) failed += 1;
  }
  console.log(`${cases.length - failed}/${cases.length} cases pass${full ? ' (full chain)' : ' (both-states)'}`);
  return failed === 0 ? 0 : 1;
}

// Direct-invocation guard: importing this module must stay side-effect free.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
