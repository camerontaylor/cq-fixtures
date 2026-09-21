import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSuite } from '../runner/index.ts';
import {
  assertRecordOutsideFixture,
  changedLines,
  declaredTitles,
  runCasePipeline,
  scanForFaultLeaks,
  PIPELINE_REPO_ROOT,
} from '../catalog/pipeline.ts';
import { loadFaultForFixture } from '../catalog/fault.ts';

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

  it('assertRecordOutsideFixture holds for every case', () => {
    expect(assertRecordOutsideFixture(PIPELINE_REPO_ROOT, 'fixtures/breadth-01')).toBe(true);
    expect(assertRecordOutsideFixture(PIPELINE_REPO_ROOT, 'fixtures/breadth-40')).toBe(true);
  });

  it('the pipeline reports every gate for a case without touching the pristine fixture', () => {
    // full=false keeps this cheap: annotation + reachability + one red + one green.
    const report = runCasePipeline('fixtures/breadth-16', { full: false });
    expect(report.caseId).toBe('breadth-16');
    expect(report.gates.map((g) => g.gate)).toEqual(['annotation', 'reachability', 'f2p', 'baseline']);
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
