import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSuite } from '../runner/index.ts';
import { isFixerCase, loadSuite } from '../runner/suite.ts';
import { applyFaultFix, faultRecordAbsPath, loadFaultForFixture, type FaultRecord } from '../catalog/fault.ts';
import { checkOperatorAssignment } from '../catalog/operators.ts';

// Breadth-suite conformance (F2, plan §5 row F2): the 10 catalog-built cases
// must pass the full validation-filter chain — static schema/catalog checks,
// the FAULT.json materialization reachability guard (the canonical fix must
// not be readable from a worker workspace), F2P (stored fault is red), the
// 100%-green baseline (canonical fix is green), determinism ×3 in both states,
// and the single-statement-deletion adequacy check. The static typecheck gate
// is the repo's own `npm run typecheck` (it includes fixtures/**/*.ts).
//
// These tests run REAL judge processes (a spawned vitest per probe), so the
// per-case tests carry generous timeouts.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BREADTH_SUITE_DIR = join(REPO_ROOT, 'suites', 'fixer-worker', 'breadth');
const PROBE_TIMEOUT_MS = 120_000;

const SMOKE_MODEL = { model: 'glm-5.3-flash', provider: 'zai', driverName: 'subprocess' } as const;

const VITEST_MJS = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const JUDGE_CONFIG = join(REPO_ROOT, 'fixtures', 'judge.vitest.config.mjs');

function runJudgeOrThrow(caseId: string, checkPath: string, workspace: string): number {
  const res = spawnSync(process.execPath, [checkPath], { cwd: workspace, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if ((res.error !== undefined && res.error !== null) || res.status === null) {
    throw new Error(
      `${caseId} judge spawn failed (infrastructure, not an eval signal): ` +
        `${(res.error as Error | undefined)?.message ?? `killed by signal ${res.signal ?? 'unknown'}`}`,
    );
  }
  // The judge fails CLOSED with exit 1 on infrastructure refusals (misuse,
  // workspace escape, an unspawnable vitest) — those are not an eval-red.
  const stderr = res.stderr ?? '';
  for (const marker of ['refusing to judge', 'workspace escape', 'could not execute the vitest run', 'does not resolve (dangling link?)']) {
    if (stderr.includes(marker)) throw new Error(`${caseId} judge failed closed (infrastructure): ${marker}`);
  }
  return res.status;
}

interface TestOutcome {
  title: string;
  status: string;
}

/**
 * Run the fixture's vitest suite directly with the JSON reporter so each
 * declared F2P/P2P title can be checked individually. The workspace is a
 * fresh materialization (pristine tests), and the explicit judge config pins
 * the include glob, so this mirrors the judge's test surface.
 */
function runVitestJson(workspace: string, label: string): { status: number; tests: TestOutcome[] } {
  const outFile = join(wsRoot, `${label}.json`);
  const res = spawnSync(
    process.execPath,
    [VITEST_MJS, 'run', '--root', workspace, '--config', JUDGE_CONFIG, '--reporter=json', `--outputFile=${outFile}`],
    { cwd: workspace, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS },
  );
  if ((res.error !== undefined && res.error !== null) || res.status === null) {
    throw new Error(
      `${label} vitest run failed (infrastructure): ` +
        `${(res.error as Error | undefined)?.message ?? `killed by signal ${res.signal ?? 'unknown'}`}`,
    );
  }
  const report = (() => {
    try {
      return JSON.parse(readFileSync(outFile, 'utf8')) as {
        testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }>;
      };
    } catch (e) {
      // A vitest crash that never writes the report is infrastructure, not a
      // per-title verdict — fail closed with the child's tail for diagnosis.
      throw new Error(
        `${label} vitest JSON report missing/unparseable (infrastructure): ${(e as Error).message}\n${(res.stderr ?? '').slice(-500)}`,
      );
    }
  })();
  const tests = report.testResults.flatMap((f) => f.assertionResults.map((a) => ({ title: a.title, status: a.status })));
  return { status: res.status, tests };
}

/** The status of one declared test title (must exist exactly once). */
function outcomeOf(tests: TestOutcome[], title: string, caseId: string): string {
  const matches = tests.filter((t) => t.title === title);
  expect(matches.length, `${caseId}: declared test '${title}' must exist exactly once`).toBe(1);
  return matches[0]!.status;
}

/** Materialize exactly as runner/index.ts does for a fixer case. */
function materialize(fixtureRef: string): string {
  const workspace = mkdtempSync(join(tmpdir(), 'cq-breadth-ws-'));
  cpSync(join(REPO_ROOT, fixtureRef), workspace, { recursive: true, verbatimSymlinks: true });
  return workspace;
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

/** Lines present in exactly one of two texts (multiset symmetric difference). */
function changedLines(a: string, b: string): string[] {
  const counts = new Map<string, number>();
  for (const line of a.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of b.split('\n')) counts.set(line, (counts.get(line) ?? 0) - 1);
  const out: string[] = [];
  for (const [line, n] of counts) for (let i = 0; i < Math.abs(n); i++) out.push(line);
  return out;
}

/** Concatenated test-source text for a fixture (test titles live here). */
function readTestSources(fixtureRef: string): string {
  const testDir = join(REPO_ROOT, fixtureRef, 'test');
  return walkFiles(testDir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

/** The exact set of `it('…')` titles declared by a fixture's test files. */
function declaredTitles(fixtureRef: string): Set<string> {
  const titles = new Set<string>();
  for (const match of readTestSources(fixtureRef).matchAll(/\bit\(\s*(['"`])([\s\S]*?)\1/g)) {
    titles.add(match[2]!);
  }
  return titles;
}

/**
 * Fix-side lines that carry the answer (a line in the canonical fix that the
 * stored faulted file does not contain). Used to catch a workspace file that
 * embeds a fixed snippet without being byte-identical to the fix.
 */
function fixSecretLines(fixtureRef: string, record: FaultRecord): string[] {
  const out: string[] = [];
  for (const [rel, fixed] of Object.entries(record.validation.fix)) {
    const stored = readFileSync(join(REPO_ROOT, fixtureRef, rel), 'utf8');
    const fixedLines = new Set(fixed.split('\n'));
    for (const line of changedLines(stored, fixed)) {
      if (line.trim().length >= 12 && fixedLines.has(line)) out.push(line);
    }
  }
  return out;
}

/**
 * Files in a materialized workspace that leak the fault record: a FAULT.json
 * by name, any file carrying the record's marker key, any file whose full
 * content equals a canonical fix, or any file embedding a fix-side line.
 */
function scanForFaultLeaks(workspace: string, fixtureRef: string, record: FaultRecord): string[] {
  const leaks: string[] = [];
  const fixValues = Object.values(record.validation.fix);
  const secretLines = fixSecretLines(fixtureRef, record);
  for (const file of walkFiles(workspace)) {
    if (/\.FAULT\.json$/.test(file)) {
      leaks.push(`${relative(workspace, file)} (FAULT.json by name)`);
      continue;
    }
    const content = (() => {
      try {
        return readFileSync(file, 'utf8');
      } catch (e) {
        // An unreadable entry (a symlinked dir, a permission error) is
        // fail-closed: a labeled leak, never a throw that hides the verdict.
        leaks.push(`${relative(workspace, file)} (unreadable: ${(e as Error).message})`);
        return undefined;
      }
    })();
    if (content === undefined) continue;
    if (content.includes('"failure_symptoms"')) leaks.push(`${relative(workspace, file)} (FAULT.json marker)`);
    else if (fixValues.some((fix) => fix === content)) leaks.push(`${relative(workspace, file)} (canonical fix content)`);
    else if (secretLines.some((line) => content.includes(line))) leaks.push(`${relative(workspace, file)} (canonical fix line)`);
  }
  return leaks;
}

let wsRoot: string;
beforeEach(() => {
  wsRoot = mkdtempSync(join(tmpdir(), 'cq-breadth-'));
});
afterEach(() => {
  rmSync(wsRoot, { recursive: true, force: true });
});

const suite = loadSuite(BREADTH_SUITE_DIR);
const fixerCases = suite.cases.filter(isFixerCase);

describe('breadth suite shape (F2 acceptance)', () => {
  it('loads 10 fixer cases with the recorded 4 easy / 4 medium / 2 hard mix', () => {
    expect(fixerCases).toHaveLength(10);
    expect(fixerCases.map((c) => c.id)).toEqual(Array.from({ length: 10 }, (_, i) => `breadth-${String(i + 1).padStart(2, '0')}`));
    const bands = fixerCases.map((c) => loadFaultForFixture(REPO_ROOT, c.fixture).difficulty);
    expect(bands.filter((b) => b === 'easy')).toHaveLength(4);
    expect(bands.filter((b) => b === 'medium')).toHaveLength(4);
    expect(bands.filter((b) => b === 'hard')).toHaveLength(2);
    // The mix is recorded in the suite's provenance.origin (plan WB-2.4).
    expect(suite.provenance.origin).toContain('4 easy / 4 medium / 2 hard');
  });

  it('every case has a schema-valid FAULT.json whose operators obey the catalog band rules', () => {
    for (const c of fixerCases) {
      const record = loadFaultForFixture(REPO_ROOT, c.fixture);
      expect(record.bug_type.length).toBeGreaterThan(0);
      expect(record.validation.f2p.length).toBeGreaterThan(0);
      expect(record.validation.p2p.length).toBeGreaterThan(0);
      for (const operatorId of record.operator.split('+')) {
        expect(checkOperatorAssignment(operatorId, record.difficulty), `${c.id} ${operatorId}@${record.difficulty}`).toEqual({ ok: true });
      }
      // Every faulted src file the record names must exist and differ from the fix.
      for (const [rel, fixed] of Object.entries(record.validation.fix)) {
        const stored = readFileSync(join(REPO_ROOT, c.fixture, rel), 'utf8');
        expect(stored, `${c.id} ${rel} must be the faulted state`).not.toBe(fixed);
      }
      // The adequacy target must be a statement in a fixed file.
      expect(record.adequacy, `${c.id} adequacy`).toBeDefined();
      expect(Object.keys(record.validation.fix), `${c.id} adequacy file is fixed`).toContain(record.adequacy!.file);
      expect(record.validation.fix[record.adequacy!.file]).toContain(record.adequacy!.delete);
    }
  });

  it('every f2p/p2p title is an exact declared it() title', () => {
    for (const c of fixerCases) {
      const record = loadFaultForFixture(REPO_ROOT, c.fixture);
      const titles = declaredTitles(c.fixture);
      for (const title of [...record.validation.f2p, ...record.validation.p2p]) {
        expect(titles.has(title), `${c.id} declared it() title '${title}'`).toBe(true);
      }
    }
  });

  it('faulted-to-fixed diffs carry no operator signature or tell markers', () => {
    // The format/tell pass (R6 digest §2): both states share authoring
    // discipline, so the diff is the operator change alone — no `stryker`/
    // `mutant`/`FAULT` markers and no reformatting noise.
    for (const c of fixerCases) {
      const record = loadFaultForFixture(REPO_ROOT, c.fixture);
      for (const [rel, fixed] of Object.entries(record.validation.fix)) {
        const stored = readFileSync(join(REPO_ROOT, c.fixture, rel), 'utf8');
        const changed = changedLines(stored, fixed);
        expect(changed.join('\n'), `${c.id} ${rel} diff markers`).not.toMatch(/\b(stryker|mutant|FAULT|BUG|TODO|XXX|MUTATION)\b/i);
        expect(changed.length, `${c.id} ${rel} diff must be operator-sized`).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe('FAULT.json is unreachable from a materialized worker workspace', () => {
  it('the record is a sibling FILE, never inside the copied fixture directory', () => {
    for (const c of fixerCases) {
      const recordPath = faultRecordAbsPath(REPO_ROOT, c.fixture);
      const rel = relative(join(REPO_ROOT, c.fixture), recordPath);
      expect(rel.startsWith('..'), `${c.id} FAULT.json must live outside ${c.fixture}`).toBe(true);
      expect(existsSync(recordPath), `${c.id} FAULT.json exists`).toBe(true);
    }
  });

  it('a cpSync materialization carries no FAULT.json and no canonical fix content', () => {
    for (const c of fixerCases) {
      const record = loadFaultForFixture(REPO_ROOT, c.fixture);
      const workspace = materialize(c.fixture);
      try {
        expect(scanForFaultLeaks(workspace, c.fixture, record), `${c.id} leaks`).toEqual([]);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  });

  it('the real runner materializer never places the record in the workspace (driver-observed)', async () => {
    // Drive runSuite with a one-case suite so the leak scan runs DURING
    // dispatch, against the runner's own mkdtemp + cpSync path.
    const dir = join(wsRoot, 'leak-probe');
    mkdirSync(dir, { recursive: true });
    const record = loadFaultForFixture(REPO_ROOT, 'fixtures/breadth-01');
    writeFileSync(
      join(dir, 'suite.json'),
      JSON.stringify({
        name: 'leak-probe',
        role: 'fixer-worker',
        provenance: { origin: 'test-local single-case slice of suites/fixer-worker/breadth' },
        cases: [
          {
            id: 'breadth-01',
            fixture: 'fixtures/breadth-01',
            task: { prompt: 'The workspace at the path below contains a TypeScript package whose vitest suite fails.' },
            probe: { kind: 'check-rerun', check: 'fixtures/breadth-01/check.mjs' },
          },
        ],
      }, null, 2) + '\n',
    );
    class LeakProbeDriver implements Driver {
      leaks: string[] | undefined;
      workspaceSeen: string | undefined;
      async run(invocation: OpInvocation): Promise<WorkerResult> {
        const workspace = /\nworkspace: (\S+)$/.exec(invocation.prompt)?.[1];
        if (workspace !== undefined) {
          this.workspaceSeen = workspace;
          this.leaks = scanForFaultLeaks(workspace, 'fixtures/breadth-01', record);
        }
        return {
          model: invocation.modelSpec.model,
          structuredOutput: { fixed: false, notes: '' },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'complete',
        };
      }
    }
    const driver = new LeakProbeDriver();
    await runSuite({ suiteDir: dir, driver, ...SMOKE_MODEL });
    expect(driver.workspaceSeen, 'driver saw the materialized workspace').toBeDefined();
    expect(driver.leaks, 'no FAULT.json/fix leak during dispatch').toEqual([]);
  }, PROBE_TIMEOUT_MS + 30_000);
});

describe('validation filter chain: F2P, baseline, determinism ×3, adequacy', () => {
  for (const c of fixerCases) {
    const { fixture, probe } = c;
    it(`${c.id}: per-test F2P/P2P in both states, determinism ×3, adequacy deletion red`, () => {
      const record = loadFaultForFixture(REPO_ROOT, fixture);
      const workspace = materialize(fixture);
      try {
        // The real scoring path (judge) confirms the aggregate verdict and
        // determinism; the JSON runs then check each declared title.
        for (let run = 0; run < 3; run++) {
          expect(runJudgeOrThrow(c.id, join(REPO_ROOT, probe.check), workspace), `${c.id} faulted judge run ${run + 1} must be red`).not.toBe(0);
        }
        const faulted = runVitestJson(workspace, `${c.id}-faulted`);
        expect(faulted.status, `${c.id} faulted JSON run must be red`).not.toBe(0);
        for (const title of record.validation.f2p) {
          expect(outcomeOf(faulted.tests, title, c.id), `${c.id} f2p '${title}' must fail in the faulted state`).toBe('failed');
        }
        for (const title of record.validation.p2p) {
          expect(outcomeOf(faulted.tests, title, c.id), `${c.id} p2p '${title}' must pass in the faulted state`).toBe('passed');
        }

        // Baseline/P2P gate + determinism on the canonical-fix state.
        applyFaultFix(record, workspace);
        for (let run = 0; run < 3; run++) {
          expect(runJudgeOrThrow(c.id, join(REPO_ROOT, probe.check), workspace), `${c.id} fixed judge run ${run + 1} must be green`).toBe(0);
        }
        const fixed = runVitestJson(workspace, `${c.id}-fixed`);
        expect(fixed.status, `${c.id} fixed JSON run must be green`).toBe(0);
        for (const title of [...record.validation.f2p, ...record.validation.p2p]) {
          expect(outcomeOf(fixed.tests, title, c.id), `${c.id} '${title}' must pass in the fixed state`).toBe('passed');
        }

        // P2P adequacy: deleting one load-bearing statement from the fixed
        // source must make the suite red (a suite that survives the deletion
        // would grade green without a real fix).
        const adequacy = record.adequacy!;
        const fixedSource = record.validation.fix[adequacy.file]!;
        const crippled = fixedSource.replace(adequacy.delete, '');
        expect(crippled, `${c.id} adequacy statement must be present in the fixed source`).not.toBe(fixedSource);
        writeFileSync(join(workspace, adequacy.file), crippled);
        expect(runVitestJson(workspace, `${c.id}-adequacy`).status, `${c.id} adequacy deletion must be red`).not.toBe(0);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }, PROBE_TIMEOUT_MS * 8);
  }
});
