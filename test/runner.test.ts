import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import {
  computeCostUSD,
  openRunLog,
  priceOf,
  type Driver,
  type JobFinishedJournalEvent,
  type OpInvocation,
  type RunFinishedJournalEvent,
  type WorkerResult,
} from '@camerontaylor/cq-toolkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSuite, type RunSuiteOptions } from '../runner/index.ts';
import { loadSuite } from '../runner/suite.ts';
import { scoreFixerWorker } from '../runner/score/fixerWorker.ts';
import { scoreReviewClassifier } from '../runner/score/reviewClassifier.ts';
import { FakeDriver } from '../runner/fake-driver.ts';
import type { ResultRow, SuiteRole } from '../runner/aggregate.ts';

// Runner tests: no network, no live keys — the FakeDriver stands in for a
// toolkit lane. Fixture paths inside suite.json are repo-root-relative in
// SHAPE (the runner's semantic rule) and are resolved against repoRoot,
// which points at the per-test tmp dir.

const ajv = ajvFormats(new Ajv2020({ allErrors: true }));
const validateRow = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/result-row.schema.json', import.meta.url), 'utf8')) as object,
);
const validateTable = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/comparison-table.schema.json', import.meta.url), 'utf8')) as object,
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-fixture-runner-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSuite(dirName: string, suite: object): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'suite.json'), JSON.stringify(suite, null, 2) + '\n');
  return dir;
}

function reviewCase(id: string, expected: string): object {
  return {
    id,
    fixture: 'fixture',
    task: { prompt: 'Classify the review thread.' },
    probe: { kind: 'expected-verdict', expected },
  };
}

function reviewSuite(dirName: string, name: string, cases: object[]): string {
  return writeSuite(dirName, {
    name,
    role: 'review-classifier',
    servedModel: 'deepseek-chat',
    provenance: { origin: 'hand-seeded' },
    cases,
  });
}

interface OverSpec {
  model?: string;
  provider?: string;
  maxUsd?: number;
  maxTokens?: number;
  wallClockMs?: number;
  checkTimeoutMs?: number;
  journalPath?: string;
}

function opts(suiteDir: string, over: OverSpec = {}): RunSuiteOptions {
  return {
    suiteDir,
    driver: new FakeDriver(),
    // Priced pair by default: the fake's 120 tokens/case cost ~0.0000364 USD,
    // so even an explicit maxUsd does not gate ordinary runs. Caps default to
    // ABSENT (no injection) — tests opt into caps explicitly.
    model: 'deepseek-chat',
    provider: 'deepseek',
    repoRoot: root,
    ...over,
  };
}

function assertSchemaValid(rows: ResultRow[], tables: unknown[]): void {
  for (const row of rows) expect(validateRow(row), `row ${row.case}: ${ajv.errorsText(validateRow.errors)}`).toBe(true);
  for (const table of tables) expect(validateTable(table), `table: ${ajv.errorsText(validateTable.errors)}`).toBe(true);
}

describe('empty suite (empty-but-valid table)', () => {
  it('loadSuite accepts cases: [] and runSuite emits one empty-cells table that validates', async () => {
    const dir = reviewSuite('empty-suite', 'empty-suite', []);
    const suite = loadSuite(dir);
    expect(suite.cases).toEqual([]);

    const result = await runSuite(opts(dir));
    expect(result.rows).toEqual([]);
    expect(result.gatedByBudget).toBe(false);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ role: 'review-classifier', suite: 'empty-suite', cells: [] });
    expect(validateTable(result.tables[0]), ajv.errorsText(validateTable.errors)).toBe(true);
  }, 15_000);
});

describe('driver conformance (adding a case changes no runner code)', () => {
  it('one case -> one scored row; a second case in the SAME suite dir -> two rows via the SAME runner call', async () => {
    const dir = reviewSuite('conf-suite', 'conf-suite', [reviewCase('rev-1', 'resolved')]);
    const first = await runSuite(opts(dir));
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ case: 'rev-1', outcome: { score: 1, passed: 1, total: 1 } });
    assertSchemaValid(first.rows, first.tables);

    // The conformance property: the suite is DATA — adding a case and
    // re-running the identical runner call scores it with zero runner change.
    writeSuite('conf-suite', {
      name: 'conf-suite',
      role: 'review-classifier',
      servedModel: 'deepseek-chat',
      provenance: { origin: 'hand-seeded' },
      cases: [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'resolved')],
    });
    const second = await runSuite(opts(dir));
    expect(second.rows).toHaveLength(2);
    expect(second.rows.map((r) => r.case)).toEqual(['rev-1', 'rev-2']);
    expect(second.rows.every((r) => r.outcome.score === 1)).toBe(true);
    expect(second.tables[0]?.cells).toEqual([
      expect.objectContaining({ model: 'deepseek-chat', driver: 'ai-sdk', runs: 2, passed: 2, total: 2, score: 1 }),
    ]);
    assertSchemaValid(second.rows, second.tables);
  }, 15_000);
});

describe('review-classifier scoring (fake verdict: resolved)', () => {
  it('expected actionable vs verdict resolved scores 0 with no fabricated credit', async () => {
    const dir = reviewSuite('rev-miss', 'rev-miss', [reviewCase('rev-miss-1', 'actionable')]);
    const result = await runSuite(opts(dir));
    expect(result.rows[0]).toMatchObject({ outcome: { score: 0, passed: 0, total: 1 } });
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('missing or out-of-vocabulary structuredOutput scores 0 with diagnostics and never throws', () => {
    const noOutput = {} as WorkerResult;
    const missing = scoreReviewClassifier({ probe: { kind: 'expected-verdict', expected: 'resolved' } }, noOutput);
    expect(missing).toMatchObject({ score: 0, passed: 0, total: 1 });
    expect(missing.diagnostics).toMatch(/missing or unparseable/);

    const offVocab = { structuredOutput: { verdict: 'maybe' } } as WorkerResult;
    const off = scoreReviewClassifier({ probe: { kind: 'expected-verdict', expected: 'resolved' } }, offVocab);
    expect(off.score).toBe(0);
    expect(off.diagnostics).toMatch(/outside the classifyThreads vocabulary/);
  });
});

describe('fixer-worker scoring (re-run the seeded check)', () => {
  it('check exit 0 scores 1, check exit 1 scores 0', async () => {
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check-pass.js'), 'process.exit(0);\n');
    writeFileSync(join(root, 'fixture', 'check-fail.js'), 'process.exit(1);\n');
    const dir = writeSuite('fix-suite', {
      name: 'fix-suite',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [
        { id: 'fix-pass', fixture: 'fixture', task: { prompt: 'Fix the fault.' }, probe: { kind: 'check-rerun', check: 'fixture/check-pass.js' } },
        { id: 'fix-fail', fixture: 'fixture', task: { prompt: 'Fix the fault.' }, probe: { kind: 'check-rerun', check: 'fixture/check-fail.js' } },
      ],
    });
    const result = await runSuite(opts(dir));
    expect(result.rows.map((r) => [r.case, r.outcome.score])).toEqual([['fix-pass', 1], ['fix-fail', 0]]);
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('a missing check script scores 0 with diagnostics and never throws', () => {
    const outcome = scoreFixerWorker(
      { fixture: 'fixture', probe: { kind: 'check-rerun', check: 'fixture/does-not-exist.js' } },
      {} as WorkerResult,
      root,
      join(root, 'fixture'),
    );
    expect(outcome.score).toBe(0);
    expect(outcome.passed).toBe(0);
    expect(outcome.total).toBe(1);
    expect(outcome.diagnostics).toBeDefined();
  });

  it('a check that outlives its timeout scores 0 with a timeout diagnostic (never hangs the suite)', () => {
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check-slow.js'), 'setTimeout(() => process.exit(0), 10_000);\n');
    const outcome = scoreFixerWorker(
      { fixture: 'fixture', probe: { kind: 'check-rerun', check: 'fixture/check-slow.js' } },
      {} as WorkerResult,
      root,
      join(root, 'fixture'),
      300,
    );
    expect(outcome.score).toBe(0);
    expect(outcome.diagnostics).toMatch(/check probe timed out after 300ms/);
  }, 10_000);

  it('the probe ceiling is --check-timeout-ms through the run path, independent of wallClockMs', async () => {
    // An 800ms check: capped at 300ms it times out (score 0); uncapped it
    // completes (score 1). wallClockMs is NOT involved — F2 decoupling.
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check-800ms.js'), 'setTimeout(() => process.exit(0), 800);\n');
    const dir = writeSuite('slow-check-suite', {
      name: 'slow-check-suite',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-slow', fixture: 'fixture', task: { prompt: 'Fix the fault.' }, probe: { kind: 'check-rerun', check: 'fixture/check-800ms.js' } }],
    });
    const capped = await runSuite(opts(dir, { checkTimeoutMs: 300 }));
    expect(capped.rows[0]).toMatchObject({ case: 'fix-slow', outcome: { score: 0 } });
    const uncapped = await runSuite(opts(dir));
    expect(uncapped.rows[0]).toMatchObject({ case: 'fix-slow', outcome: { score: 1 } });
  }, 15_000);

  it('a small wallClockMs does NOT constrain the check probe (decoupled knobs)', async () => {
    // wallClockMs is the invocation budget only; the probe ceiling is
    // checkTimeoutMs (default 60s), so a fast check scores 1 even with a
    // 50ms run wall clock.
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check-fast.js'), 'process.exit(0);\n');
    const dir = writeSuite('small-wallclock', {
      name: 'small-wallclock',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-fast', fixture: 'fixture', task: { prompt: 'Fix the fault.' }, probe: { kind: 'check-rerun', check: 'fixture/check-fast.js' } }],
    });
    const result = await runSuite(opts(dir, { wallClockMs: 50 }));
    expect(result.rows[0]).toMatchObject({ case: 'fix-fast', outcome: { score: 1 } });
  }, 15_000);

  it('a probe handed the wrong probe.kind throws (programming error, caught by loadSuite first)', () => {
    expect(() =>
      scoreFixerWorker(
        { fixture: 'fixture', probe: { kind: 'expected-verdict', expected: 'resolved' } } as never,
        {} as WorkerResult,
        root,
        join(root, 'fixture'),
      ),
    ).toThrow(/must be 'check-rerun'/);
  });
});

describe('writable workspace (fixer fixture round-trip)', () => {
  /** A stand-in worker that "fixes" state.txt inside the workspace named in the prompt. */
  class FixingDriver implements Driver {
    readonly invocations: OpInvocation[] = [];
    async run(invocation: OpInvocation): Promise<WorkerResult> {
      this.invocations.push(invocation);
      const workspace = /workspace: (.+)$/m.exec(invocation.prompt)?.[1];
      if (workspace !== undefined) writeFileSync(join(workspace, 'state.txt'), 'fixed');
      return {
        model: invocation.modelSpec.model,
        structuredOutput: { verdict: 'resolved' },
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'complete',
      };
    }
  }

  it('the driver writes its workspace copy and the check probe grades THAT copy — the fix round-trips', async () => {
    // Seeded fault: state.txt says 'broken'; the probe passes only on 'fixed'.
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'state.txt'), 'broken');
    writeFileSync(join(root, 'fixture', 'check.js'), "process.exit(require('fs').readFileSync('./state.txt', 'utf8') === 'fixed' ? 0 : 1);\n");
    const dir = writeSuite('ws-suite', {
      name: 'ws-suite',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-ws-1', fixture: 'fixture', task: { prompt: 'Fix state.txt to say fixed.' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });

    const driver = new FixingDriver();
    const result = await runSuite({ suiteDir: dir, driver, model: 'deepseek-chat', provider: 'deepseek', maxUsd: 1, repoRoot: root });

    // The invocation went out shaped for a real fixer: full harness tool
    // allowlist, workspace-write sandbox, and the workspace path in-prompt.
    const invocation = driver.invocations[0]!;
    expect(invocation.toolPolicy).toEqual({ allow: ['read', 'edit', 'run'], mode: 'allowlist' });
    expect(invocation.sandboxPolicy).toEqual({ level: 'workspace-write' });
    expect(invocation.prompt).toMatch(/^Fix state\.txt to say fixed\.\nworkspace: \S+/);
    // The probe saw the driver's fix in the workspace copy: score 1 —
    // proving the workspace round-trip (driver wrote it, probe read it).
    expect(result.rows[0]).toMatchObject({ case: 'fix-ws-1', outcome: { score: 1, passed: 1, total: 1 } });
    // The pristine fixture under repoRoot was never touched.
    expect(readFileSync(join(root, 'fixture', 'state.txt'), 'utf8')).toBe('broken');
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('review-classifier invocations stay tools-none / read-only with no workspace line', async () => {
    const dir = reviewSuite('ws-review', 'ws-review', [reviewCase('rev-1', 'resolved')]);
    const driver = new FixingDriver();
    await runSuite({ suiteDir: dir, driver, model: 'deepseek-chat', provider: 'deepseek', maxUsd: 1, repoRoot: root });
    const invocation = driver.invocations[0]!;
    expect(invocation.toolPolicy).toEqual({ allow: [], mode: 'none' });
    expect(invocation.sandboxPolicy).toEqual({ level: 'read-only' });
    expect(invocation.prompt).not.toMatch(/workspace:/);
  }, 15_000);
});

describe('budget honesty (I9)', () => {
  it('a tripped token cap gates admission: rows carry ONLY admitted cases and the journal records the honest stop', async () => {
    const dir = reviewSuite('budget-suite', 'budget-suite', [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'resolved')]);
    // The fake reports 100 input + 20 output = 120 tokens; the governor's
    // token cap trips when the fold EXCEEDS maxTokens (BudgetGovernor
    // .d.ts), so case 1 runs and case 2 is refused admission.
    const journalPath = join(root, 'journal');
    const result = await runSuite(opts(dir, { maxTokens: 100, journalPath }));

    expect(result.gatedByBudget).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows.map((r) => r.case)).toEqual(['rev-1']);
    expect(result.tables[0]?.cells).toEqual([expect.objectContaining({ runs: 1 })]);
    assertSchemaValid(result.rows, result.tables);

    const log = openRunLog(journalPath);
    const runs = await log.runs();
    expect(runs).toEqual([result.rows[0]!.runId]);
    const events = await log.read(runs[0]!);
    const dispatched = events.filter((e) => e.type === 'job-started').map((e) => (e as { jobId: string }).jobId);
    expect(dispatched).toEqual(['rev-1']); // no fabricated dispatch for rev-2
    const finished = events.find((e): e is JobFinishedJournalEvent => e.type === 'job-finished');
    expect(finished?.result.status).toBe('ok');
    const runFinished = events.find((e): e is RunFinishedJournalEvent => e.type === 'run-finished');
    expect(runFinished).toMatchObject({ stoppedEarly: true, earlyStopReason: 'budget' });
  }, 15_000);

  it('an unpriced lane under a TOKEN-ONLY cap dispatches ALL cases (no USD fail-closed)', async () => {
    // glm-5.3-flash on zai is unpriced: with no maxUsd configured, the
    // governor has no USD cap to fail closed on, so the token cap binds
    // alone and both cases dispatch (F1/DD-9).
    const dir = reviewSuite('token-only', 'token-only', [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'resolved')]);
    const result = await runSuite(opts(dir, { model: 'glm-5.3-flash', provider: 'zai', maxTokens: 10_000 }));
    expect(result.gatedByBudget).toBe(false);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.case)).toEqual(['rev-1', 'rev-2']);
    expect(result.rows.every((r) => r.costUSD === null)).toBe(true);
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('an EXPLICIT maxUsd on an unpriced lane still trips fail-closed after case 1', async () => {
    // Keeping the honest-stop contract honest in the other direction: a
    // configured USD cap over unpriced usage MUST trip (never run unbounded).
    const dir = reviewSuite('usd-fail-closed', 'usd-fail-closed', [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'resolved')]);
    const result = await runSuite(opts(dir, { model: 'glm-5.3-flash', provider: 'zai', maxUsd: 0.000001, maxTokens: 1_000_000 }));
    expect(result.gatedByBudget).toBe(true);
    expect(result.rows.map((r) => r.case)).toEqual(['rev-1']);
  }, 15_000);
});

describe('DD-9 cost derivation', () => {
  it('a priced model yields a positive costUSD with costBasis modeled', async () => {
    const dir = reviewSuite('cost-priced', 'cost-priced', [reviewCase('rev-1', 'resolved')]);
    const result = await runSuite(opts(dir, { model: 'deepseek-chat', provider: 'deepseek' }));
    const row = result.rows[0]!;
    expect(typeof row.costUSD).toBe('number');
    expect(row.costUSD).toBeGreaterThan(0);
    expect(row.costBasis).toBe('modeled');
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('an unpriced model yields costUSD null with no costBasis (never invented)', async () => {
    // Verified against the toolkit price map directly: glm-5.3-flash on the
    // zai handle has no entry (checked anthropic too — also absent).
    const spec = { model: 'glm-5.3-flash', provider: 'zai' };
    expect(priceOf(spec)).toBeUndefined();
    expect(computeCostUSD(spec, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();

    const dir = reviewSuite('cost-unpriced', 'cost-unpriced', [reviewCase('rev-1', 'resolved')]);
    const result = await runSuite(opts(dir, { model: 'glm-5.3-flash', provider: 'zai' }));
    const row = result.rows[0]!;
    expect(row.costUSD).toBeNull();
    expect('costBasis' in row).toBe(false);
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);
});

describe('schema validation of emitted artifacts', () => {
  it('every row and table from a mixed two-suite run validates', async () => {
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    const fixer = writeSuite('mix-fixer', {
      name: 'mix-fixer',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-1', fixture: 'fixture', task: { prompt: 'p' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });
    const review = reviewSuite('mix-review', 'mix-review', [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'actionable')]);
    const a = await runSuite(opts(fixer));
    const b = await runSuite(opts(review));
    const roles = new Set<SuiteRole>([...a.rows, ...b.rows].map((r) => r.role));
    expect([...roles].sort()).toEqual(['fixer-worker', 'review-classifier']);
    assertSchemaValid([...a.rows, ...b.rows], [...a.tables, ...b.tables]);
  }, 15_000);
});

describe('semantic layer (issue #4 enforcement in loadSuite)', () => {
  it('rejects a role/probe-kind mismatch', () => {
    const dir = writeSuite('bad-pairing', {
      name: 'bad-pairing',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [reviewCase('z', 'resolved')],
    });
    expect(() => loadSuite(dir)).toThrow(/requires probe.kind 'check-rerun'/);
  });

  it('rejects duplicate case ids', () => {
    const dir = reviewSuite('bad-dup', 'bad-dup', [reviewCase('x', 'resolved'), reviewCase('x', 'resolved')]);
    expect(() => loadSuite(dir)).toThrow(/duplicate case id 'x'/);
  });

  it('rejects a fixture path escaping the repo', () => {
    const dir = writeSuite('bad-escape', {
      name: 'bad-escape',
      role: 'review-classifier',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'y', fixture: '../outside', task: { prompt: 'p' }, probe: { kind: 'expected-verdict', expected: 'resolved' } }],
    });
    expect(() => loadSuite(dir)).toThrow(/repo-root-relative/);
  });

  it('rejects Windows path forms: backslash separators, drive prefixes, drive-absolute', () => {
    const fixtures = ['sub\\evil', 'C:', 'C:/evil', 'C:\\evil', '/abs'];
    for (const fixture of fixtures) {
      const dir = writeSuite(`bad-win-${fixtures.indexOf(fixture)}`, {
        name: `bad-win-${fixtures.indexOf(fixture)}`,
        role: 'review-classifier',
        provenance: { origin: 'hand-seeded' },
        cases: [{ id: 'w', fixture, task: { prompt: 'p' }, probe: { kind: 'expected-verdict', expected: 'resolved' } }],
      });
      expect(() => loadSuite(dir), `fixture '${fixture}' must be rejected`).toThrow(/repo-root-relative/);
    }
  });

  it('rejects a suite failing the JSON Schema (missing provenance)', () => {
    const dir = writeSuite('bad-schema', {
      name: 'bad-schema',
      role: 'review-classifier',
      cases: [reviewCase('x', 'resolved')],
    });
    expect(() => loadSuite(dir)).toThrow(/failed schema validation/);
  });
});
