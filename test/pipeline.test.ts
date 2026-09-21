import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSuite } from '../runner/index.ts';
import {
  annotationGate,
  assertRecordOutsideFixture,
  changedLines,
  declaredTitles,
  duplicateTitles,
  runCasePipeline,
  scanForFaultLeaks,
  PIPELINE_REPO_ROOT,
} from '../catalog/pipeline.ts';
import { loadFaultForFixture, type FaultRecord } from '../catalog/fault.ts';

// Pure/lightweight pipeline unit tests. The heavy execution gates are covered
// per case in test/breadth.test.ts; this file pins the helpers and the
// driver-observed reachability path without paying for a full suite run.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SMOKE_MODEL = { model: 'glm-5.3-flash', provider: 'zai', driverName: 'subprocess' } as const;

let wsRoot: string;
beforeEach(() => {
  wsRoot = mkdtempSync(join(tmpdir(), 'cq-pipeline-'));
});
afterEach(() => {
  rmSync(wsRoot, { recursive: true, force: true });
});

describe('pipeline helpers', () => {
  it('changedLines returns the multiset symmetric difference', () => {
    expect(changedLines('a\nb\nc\n', 'a\nB\nc\n').sort()).toEqual(['B', 'b']);
  });

  it('declaredTitles collects exact it() titles from a fixture', () => {
    const titles = declaredTitles(PIPELINE_REPO_ROOT, 'fixtures/breadth-11');
    expect(titles.has('returns the text unchanged at the limit')).toBe(true);
    expect(titles.has('averages the word lengths')).toBe(true);
  });

  it('duplicateTitles flags a repeated it() title', () => {
    const fixture = join(wsRoot, 'fixtures', 'dup');
    mkdirSync(join(fixture, 'test'), { recursive: true });
    writeFileSync(join(fixture, 'test', 'dup.test.ts'), "import { it } from 'vitest';\nit('same', () => {});\nit('same', () => {});\n");
    expect(duplicateTitles(wsRoot, 'fixtures/dup')).toEqual(['same']);
    expect(duplicateTitles(PIPELINE_REPO_ROOT, 'fixtures/breadth-11')).toEqual([]);
  });

  it('the annotation gate fails closed on a missing fix target', () => {
    const fixture = join(wsRoot, 'fixtures', 'badfix');
    mkdirSync(join(fixture, 'src'), { recursive: true });
    mkdirSync(join(fixture, 'test'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'a.ts'), 'export const x = 1;\n');
    writeFileSync(join(fixture, 'test', 'a.test.ts'), "import { it, expect } from 'vitest';\nit('x is one', () => { expect(1).toBe(1); });\n");
    const base = loadFaultForFixture(PIPELINE_REPO_ROOT, 'fixtures/breadth-11');
    const record: FaultRecord = {
      ...base,
      validation: { f2p: ['x is one'], p2p: [], fix: { 'src/missing.ts': 'export const y = 2;\n' } },
      adequacy: { file: 'src/missing.ts', delete: 'export const y = 2;' },
    };
    const result = annotationGate(wsRoot, 'fixtures/badfix', record);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('src/missing.ts is missing from the fixture');
  });

  it('the annotation gate rejects an adequacy target that is not a unique statement', () => {
    const fixture = join(wsRoot, 'fixtures', 'dup-adequacy');
    mkdirSync(join(fixture, 'src'), { recursive: true });
    mkdirSync(join(fixture, 'test'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'a.ts'), 'export function f(x: number): number {\n  return x;\n  return x + 1;\n}\n');
    writeFileSync(join(fixture, 'test', 'a.test.ts'), "import { it, expect } from 'vitest';\nit('f is identity', () => { expect(1).toBe(1); });\n");
    const base = loadFaultForFixture(PIPELINE_REPO_ROOT, 'fixtures/breadth-11');
    const record: FaultRecord = {
      ...base,
      // The recorded statement appears twice in the fixed source, so the
      // first-occurrence delete could remove the wrong one — not a valid
      // adequacy target even though `.includes()` would see it.
      validation: { f2p: ['f is identity'], p2p: [], fix: { 'src/a.ts': 'export function f(x: number): number {\n  return x;\n  return x;\n}\n' } },
      adequacy: { file: 'src/a.ts', delete: 'return x;' },
    };
    const result = annotationGate(wsRoot, 'fixtures/dup-adequacy', record);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('adequacy.delete must occur exactly once');
  });

  it('assertRecordOutsideFixture holds for every case', () => {
    expect(assertRecordOutsideFixture(PIPELINE_REPO_ROOT, 'fixtures/breadth-01')).toBe(true);
    expect(assertRecordOutsideFixture(PIPELINE_REPO_ROOT, 'fixtures/breadth-40')).toBe(true);
  });

  it('the pipeline reports every gate for a case without touching the pristine fixture', () => {
    // full=false runs the both-states floor: annotation + reachability + one
    // faulted and one fixed judge run + the per-title JSON checks.
    const report = runCasePipeline('fixtures/breadth-16', { full: false });
    expect(report.caseId).toBe('breadth-16');
    expect(report.gates.map((g) => g.gate)).toEqual([
      'annotation',
      'reachability',
      'f2p',
      'f2p-per-test',
      'p2p-per-test',
      'baseline',
      'p2p-fixed',
      'adequacy',
    ]);
    expect(report.pass, report.gates.map((g) => `${g.gate}=${g.pass}`).join(' ')).toBe(true);
  }, 180_000);
});

describe('FAULT.json reachability against the real runner materializer', () => {
  it('the runner never places the record in a materialized workspace (driver-observed)', async () => {
    const dir = join(wsRoot, 'leak-probe');
    mkdirSync(dir, { recursive: true });
    const record = loadFaultForFixture(REPO_ROOT, 'fixtures/breadth-01');
    writeFileSync(
      join(dir, 'suite.json'),
      JSON.stringify({
        name: 'leak-probe',
        role: 'fixer-worker',
        provenance: { origin: 'test-local single-case slice of suites/fixer-worker/breadth-verified' },
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
          this.leaks = scanForFaultLeaks(workspace, 'fixtures/breadth-01', record, REPO_ROOT);
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
  }, 180_000);
});
