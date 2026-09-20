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

function runJudgeOrThrow(caseId: string, checkPath: string, workspace: string): number {
  const res = spawnSync(process.execPath, [checkPath], { cwd: workspace, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if ((res.error !== undefined && res.error !== null) || res.status === null) {
    throw new Error(
      `${caseId} judge spawn failed (infrastructure, not an eval signal): ` +
        `${(res.error as Error | undefined)?.message ?? `killed by signal ${res.signal ?? 'unknown'}`}`,
    );
  }
  return res.status;
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

/**
 * Files in a materialized workspace that leak the fault record: a FAULT.json
 * by name, any file carrying the record's marker key, or any file whose full
 * content equals a canonical fix.
 */
function scanForFaultLeaks(workspace: string, record: FaultRecord): string[] {
  const leaks: string[] = [];
  const fixValues = Object.values(record.validation.fix);
  for (const file of walkFiles(workspace)) {
    if (/\.FAULT\.json$/.test(file)) {
      leaks.push(`${relative(workspace, file)} (FAULT.json by name)`);
      continue;
    }
    const content = readFileSync(file, 'utf8');
    if (content.includes('"failure_symptoms"')) leaks.push(`${relative(workspace, file)} (FAULT.json marker)`);
    else if (fixValues.some((fix) => fix === content)) leaks.push(`${relative(workspace, file)} (canonical fix content)`);
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

  it('every f2p/p2p title exists in the fixture test sources', () => {
    for (const c of fixerCases) {
      const record = loadFaultForFixture(REPO_ROOT, c.fixture);
      const tests = readTestSources(c.fixture);
      for (const title of [...record.validation.f2p, ...record.validation.p2p]) {
        expect(tests, `${c.id} test title '${title}'`).toContain(title);
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
        expect(changed.join('\n'), `${c.id} ${rel} diff markers`).not.toMatch(/stryker|mutant|FAULT|BUG|TODO|XXX|MUTATION/i);
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
        expect(scanForFaultLeaks(workspace, record), `${c.id} leaks`).toEqual([]);
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
          this.leaks = scanForFaultLeaks(workspace, record);
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
    it(`${c.id}: faulted red ×3, fixed green ×3, adequacy deletion red`, () => {
      const record = loadFaultForFixture(REPO_ROOT, fixture);
      const workspace = materialize(fixture);
      try {
        const judge = (): number => runJudgeOrThrow(c.id, join(REPO_ROOT, probe.check), workspace);

        // F2P gate + determinism on the stored (faulted) state.
        for (let run = 0; run < 3; run++) {
          expect(judge(), `${c.id} faulted run ${run + 1} must be red`).not.toBe(0);
        }

        // Baseline/P2P gate + determinism on the canonical-fix state.
        applyFaultFix(record, workspace);
        for (let run = 0; run < 3; run++) {
          expect(judge(), `${c.id} fixed run ${run + 1} must be green`).toBe(0);
        }

        // P2P adequacy: deleting one load-bearing statement from the fixed
        // source must make the suite red (a suite that survives the deletion
        // would grade green without a real fix).
        const adequacy = record.adequacy!;
        const fixedSource = record.validation.fix[adequacy.file]!;
        const crippled = fixedSource.replace(adequacy.delete, '');
        expect(crippled, `${c.id} adequacy statement must be present in the fixed source`).not.toBe(fixedSource);
        writeFileSync(join(workspace, adequacy.file), crippled);
        expect(judge(), `${c.id} adequacy deletion must be red`).not.toBe(0);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }, PROBE_TIMEOUT_MS * 8);
  }
});
