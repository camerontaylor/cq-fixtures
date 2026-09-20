import { existsSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import {
  PREFLIGHT_PROBE_JOB_ID,
  PREFLIGHT_PROBE_RESERVE_TOKENS,
  runSuite,
  type PreflightProbe,
  type RunSuiteOptions,
} from '../runner/index.ts';
import { loadSuite } from '../runner/suite.ts';
import { scoreSchemaCompliance } from '../runner/dimensions/schemaCompliance.ts';
import { scoreFixerWorker } from '../runner/score/fixerWorker.ts';
import { scoreReviewClassifier } from '../runner/score/reviewClassifier.ts';
import { FakeDriver } from '../runner/fake-driver.ts';
import { aggregate } from '../runner/aggregate.ts';
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
  // J3 payload injection: runSuite reads a review-classifier case's fixture
  // from repoRoot and injects its content into the prompt, so the fixture
  // file must EXIST on disk now (a missing file is an honest failed row, not
  // a skipped read). Hermetic per-test payload at the tmp repoRoot.
  writeFileSync(
    join(root, 'thread.json'),
    JSON.stringify({
      id: 1,
      path: 'src/example.ts',
      line: 1,
      resolved: false,
      comments: [{ author: 'tester', body: 'example remark', createdAt: '2026-09-16T00:00:00Z', isReply: false }],
    }),
  );
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
    fixture: 'thread.json',
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
  driver?: Driver;
  model?: string;
  provider?: string;
  maxUsd?: number;
  maxTokens?: number;
  checkTimeoutMs?: number;
  journalPath?: string;
  preflightProbe?: PreflightProbe;
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
    // DD-4: fixer rows carry TWO probes (check-rerun + schema compliance).
    // The FakeDriver's verdict-shaped structuredOutput fails the schema
    // probe, so a passing check scores 1/2 — the check probe itself still
    // discriminates pass (1 check-probe credit) from fail (0 credits).
    expect(result.rows.map((r) => [r.case, r.outcome.score])).toEqual([['fix-pass', 0.5], ['fix-fail', 0]]);
    expect(result.rows.map((r) => [r.case, r.outcome.passed])).toEqual([['fix-pass', 1], ['fix-fail', 0]]);
    expect(result.rows.every((r) => r.outcome.total === 2)).toBe(true);
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
    // completes (score 1). Only --check-timeout-ms bounds the probe.
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
    // DD-4: 0.5, not 1 — the check probe passed (its ceiling is the knob
    // under test here) while the fake's verdict-shaped structuredOutput
    // fails the schema-compliance probe.
    expect(uncapped.rows[0]).toMatchObject({ case: 'fix-slow', outcome: { score: 0.5 } });
  }, 15_000);

  it('a driver missing-credential throw aborts the run instead of scoring zeros', async () => {
    // The toolkit's requireKey throws pre-dispatch on a missing provider
    // env — infrastructure configuration, not an eval outcome. runSuite must
    // REJECT (cliMain maps it to exit 2), never publish scored-zero rows.
    // Literal ZAI_API_KEY case (the common path).
    const marker = `ws-marker-${randomUUID()}.txt`;
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    writeFileSync(join(root, 'fixture', marker), 'x');
    const journalPath = join(root, 'journal');
    const dir = writeSuite('missing-key', {
      name: 'missing-key',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-1', fixture: 'fixture', task: { prompt: 'p' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });
    const missingKeyDriver: Driver = {
      async run(): Promise<WorkerResult> {
        throw new Error("ai-sdk driver: provider 'zai' requires ZAI_API_KEY in the environment");
      },
    };
    await expect(runSuite(opts(dir, { driver: missingKeyDriver, journalPath }))).rejects.toThrow(/ZAI_API_KEY/);

    // W3: the aborted run's journal closes its job indeterminate (no verdict
    // exists) and carries NO run-finished event. The toolkit's journal schema
    // requires earlyStopReason: 'budget' whenever stoppedEarly is true — a
    // false claim for an error abort — so the missing run-finished IS the
    // honest record of an aborted run (and deriveJobStatuses still folds the
    // job events).
    const log = openRunLog(journalPath);
    const events = await log.read((await log.runs())[0]!);
    const finished = events.find((e): e is JobFinishedJournalEvent => e.type === 'job-finished');
    expect(finished?.result.status).toBe('indeterminate');
    expect(events.some((e) => e.type === 'run-finished')).toBe(false);

    // W1: the materialized workspace was removed even though the case
    // aborted mid-flight — no cq-fixture-* dir in tmpdir holds our unique
    // fixture marker.
    const leftovers: string[] = [];
    for (const entry of readdirSync(tmpdir())) {
      if (!entry.startsWith('cq-fixture-')) continue;
      if (existsSync(join(tmpdir(), entry, marker))) leftovers.push(entry);
    }
    expect(leftovers).toEqual([]);
  }, 15_000);

  it('a THROWING-driver fixer case keeps the full probe ceiling: { passed: 0, total: 2 } (DD-4, not a truncated total: 1)', async () => {
    // The zero paths count the case's CONFIGURED probes (runner/index.ts
    // zeroOutcome(probeCount)): a worker that never produced a gradeable
    // result failed both DD-4 probes — the check-rerun AND the
    // schema-compliance probe — so its row carries the full ceiling of 2,
    // never a truncated total: 1. (A plain driver throw, not the
    // missing-credential class: that one aborts the run instead — asserted
    // above.)
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    const dir = writeSuite('throwing-fixer', {
      name: 'throwing-fixer',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-throw', fixture: 'fixture', task: { prompt: 'p' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });
    const throwingDriver: Driver = {
      async run(): Promise<WorkerResult> {
        throw new Error('boom — a driver-level failure, not a credential abort');
      },
    };
    const result = await runSuite(opts(dir, { driver: throwingDriver }));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ case: 'fix-throw', outcome: { score: 0, passed: 0, total: 2 } });
    expect(result.diagnostics[0]).toMatch(/^case fix-throw: driver threw: /);
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('a check killed by its own signal reports failure-with-signal, never "timed out"', () => {
    // W2: only the spawn timeout machinery (ETIMEDOUT) may claim "timed
    // out" — a script dying by its own SIGKILL is a plain failure that
    // names the signal.
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check-selfkill.js'), 'process.kill(process.pid, "SIGKILL");\n');
    const outcome = scoreFixerWorker(
      { fixture: 'fixture', probe: { kind: 'check-rerun', check: 'fixture/check-selfkill.js' } },
      {} as WorkerResult,
      root,
      join(root, 'fixture'),
    );
    expect(outcome.score).toBe(0);
    expect(outcome.diagnostics).toMatch(/killed by signal SIGKILL/);
    expect(outcome.diagnostics).not.toMatch(/timed out/);
  });

  it('an uncopyable fixture emits NO row, counts a materialization failure, and journals indeterminate', async () => {
    // A fixture path that does not exist makes cpSync fail (ENOENT): the
    // driver never ran, so the case emits no row — infrastructure, not a
    // scored zero. (loadSuite checks path SHAPE only, so a missing dir is a
    // runtime materialization failure by design; no chmod games — a locked
    // dir crashes the worker in a C++ directory iterator, uncatchable.)
    const journalPath = join(root, 'journal');
    const dir = writeSuite('uncopyable', {
      name: 'uncopyable',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-uncopyable', fixture: 'does-not-exist', task: { prompt: 'p' }, probe: { kind: 'check-rerun', check: 'does-not-exist/check.js' } }],
    });
    const result = await runSuite(opts(dir, { journalPath }));
    expect(result.rows).toEqual([]);
    expect(result.materializationFailures).toBe(1);
    expect(result.tables[0]?.cells).toEqual([]); // empty-but-valid table
    expect(result.diagnostics.some((d) => d.includes('fixture materialization failed'))).toBe(true);
    const log = openRunLog(journalPath);
    const events = await log.read((await log.runs())[0]!);
    const finished = events.find((e): e is JobFinishedJournalEvent => e.type === 'job-finished');
    expect(finished?.result.status).toBe('indeterminate');
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

describe('schema-compliance dimension (DD-4: structured-output fidelity as a scored probe)', () => {
  it('a structuredOutput matching {fixed: boolean, notes: string} passes 1/1', () => {
    const ok = scoreSchemaCompliance({
      structuredOutput: { fixed: true, notes: 'reordered the loop guard' },
    } as WorkerResult);
    expect(ok).toMatchObject({ score: 1, passed: 1, total: 1 });
    expect(ok.diagnostics).toBeUndefined();
  });

  it('missing, verdict-shaped, or wrongly-typed structuredOutput scores 0 with a ONE-LINE diagnostic, never throws', () => {
    // The classifier's vocabulary shape is the canonical near-miss: the
    // right channel, the wrong contract.
    const verdictShaped = scoreSchemaCompliance({
      structuredOutput: { verdict: 'resolved' },
    } as WorkerResult);
    expect(verdictShaped.score).toBe(0);
    expect(verdictShaped.diagnostics).toMatch(/does not match the fixer output schema/);

    const missing = scoreSchemaCompliance({} as WorkerResult);
    expect(missing).toMatchObject({ score: 0, passed: 0, total: 1 });

    const wrongTypes = scoreSchemaCompliance({
      structuredOutput: { fixed: 'yes', notes: 3 },
    } as WorkerResult);
    expect(wrongTypes.score).toBe(0);
    // One line by contract: the CLI prints only the first diagnostic line.
    expect(wrongTypes.diagnostics).not.toMatch(/\n/);
  });

  it('an EXTRA field fails the probe (strict schema — DD-4 measures shape fidelity)', () => {
    // Zod objects default-strip unknown keys, so a schema-stripping parse
    // would let a stray `verdict` ride along undetected; .strict() makes any
    // undeclared key a compliance failure, with the diagnostic naming it.
    const extraField = scoreSchemaCompliance({
      structuredOutput: { fixed: true, notes: 'ok', verdict: 'whatever' },
    } as WorkerResult);
    expect(extraField).toMatchObject({ score: 0, passed: 0, total: 1 });
    expect(extraField.diagnostics).toMatch(/Unrecognized key: "verdict"/);
  });

  it('a worker that fixes the fixture AND holds the shape scores both probes (2/2) end to end', async () => {
    // The same seeded fault as the workspace round-trip test, dispatched to
    // a driver that both writes the fix and answers in the DD-4 shape — the
    // only configuration that earns the full fixer row.
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'state.txt'), 'broken');
    writeFileSync(join(root, 'fixture', 'check.js'), "process.exit(require('fs').readFileSync('./state.txt', 'utf8') === 'fixed' ? 0 : 1);\n");
    const dir = writeSuite('dd4-suite', {
      name: 'dd4-suite',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-dd4', fixture: 'fixture', task: { prompt: 'Fix state.txt to say fixed.' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });
    const shapedFixer: Driver = {
      async run(invocation: OpInvocation): Promise<WorkerResult> {
        const workspace = /workspace: (.+)$/m.exec(invocation.prompt)?.[1];
        if (workspace !== undefined) writeFileSync(join(workspace, 'state.txt'), 'fixed');
        return {
          model: invocation.modelSpec.model,
          structuredOutput: { fixed: true, notes: 'wrote fixed to state.txt' },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'complete',
        };
      },
    };
    const result = await runSuite(opts(dir, { driver: shapedFixer }));
    expect(result.rows[0]).toMatchObject({ case: 'fix-dd4', outcome: { score: 1, passed: 2, total: 2 } });
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);
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
    // The probe saw the driver's fix in the workspace copy: the check probe
    // passed — proving the workspace round-trip (driver wrote it, probe read
    // it). DD-4: score 0.5 of total 2, because the FixingDriver's
    // verdict-shaped structuredOutput fails the schema-compliance probe.
    expect(result.rows[0]).toMatchObject({ case: 'fix-ws-1', outcome: { score: 0.5, passed: 1, total: 2 } });
    // The pristine fixture under repoRoot was never touched.
    expect(readFileSync(join(root, 'fixture', 'state.txt'), 'utf8')).toBe('broken');
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('materializes relative symlinks verbatim — the copied link still points inside the workspace', async () => {
    // Fixture with a relative symlink: sub/link.js -> ../../src/module.js.
    // cpSync's default rewrites such links to ABSOLUTE paths into the
    // pristine fixture; verbatimSymlinks preserves the stored target
    // byte-for-byte so it resolves inside the workspace copy (M1).
    mkdirSync(join(root, 'fixture', 'sub'), { recursive: true });
    mkdirSync(join(root, 'fixture', 'src'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'src', 'module.js'), 'export {};\n');
    symlinkSync('../../src/module.js', join(root, 'fixture', 'sub', 'link.js'));
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    const dir = writeSuite('symlink-suite', {
      name: 'symlink-suite',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-link', fixture: 'fixture', task: { prompt: 'Fix the fault.' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });

    const copiedLinkTargets: string[] = [];
    const linkReader: Driver = {
      async run(invocation: OpInvocation): Promise<WorkerResult> {
        const workspace = /workspace: (.+)$/m.exec(invocation.prompt)?.[1];
        if (workspace !== undefined) copiedLinkTargets.push(readlinkSync(join(workspace, 'sub', 'link.js'), 'utf8'));
        return {
          model: invocation.modelSpec.model,
          structuredOutput: { verdict: 'resolved' },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'complete',
        };
      },
    };
    const result = await runSuite(opts(dir, { driver: linkReader }));

    expect(copiedLinkTargets).toEqual(['../../src/module.js']);
    // DD-4: 0.5 of 2 — the check probe passed on the verbatim link, the
    // linkReader's verdict-shaped structuredOutput failed the schema probe.
    expect(result.rows[0]).toMatchObject({ case: 'fix-link', outcome: { score: 0.5 } });
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

describe('fixture materialization honesty (T2)', () => {
  it('a fixture that cannot be materialized emits no row, journals indeterminate, and surfaces diagnostics', async () => {
    // Honest reproduction of the T2 guard: the broken case's fixture entry
    // names a plain FILE. The runner's workspace is the already-created
    // mkdtemp DIRECTORY, and cpSync refuses to overwrite a directory with a
    // non-directory (ERR_FS_CP_NON_DIR_TO_DIR, verified on node 24) — an
    // infrastructure failure where the driver never ran. (A dangling symlink
    // does NOT trigger the guard: verbatimSymlinks copies the link verbatim
    // without dereferencing.) The healthy sibling case proves the run
    // continues with the other cases.
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    writeFileSync(join(root, 'fixture-file'), 'not a directory\n');
    const journalPath = join(root, 'journal');
    const dir = writeSuite('mat-fail', {
      name: 'mat-fail',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [
        { id: 'fix-broken', fixture: 'fixture-file', task: { prompt: 'p' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } },
        { id: 'fix-healthy', fixture: 'fixture', task: { prompt: 'p' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } },
      ],
    });

    const result = await runSuite(opts(dir, { journalPath }));

    // The unmaterializable case emitted NO row (rows exist only for cases
    // that ran); the run continued and scored the healthy case.
    expect(result.rows.map((r) => r.case)).toEqual(['fix-healthy']);
    expect(result.diagnostics).toEqual([
      expect.stringMatching(/^case fix-broken: fixture materialization failed for 'fixture-file'/),
      // DD-4: the healthy case RAN, so its row also carries the schema
      // probe's complaint — the FakeDriver's verdict-shaped structuredOutput
      // is not the fixer's {fixed, notes} shape.
      expect.stringMatching(/^case fix-healthy: structuredOutput does not match the fixer output schema/),
    ]);
    assertSchemaValid(result.rows, result.tables);

    // The journal folds the failed case as honestly indeterminate (no
    // verdict exists — the driver never ran) while the healthy case is ok.
    const log = openRunLog(journalPath);
    const events = await log.read((await log.runs())[0]!);
    const finished = events.filter((e): e is JobFinishedJournalEvent => e.type === 'job-finished');
    const broken = finished.find((e) => e.jobId === 'fix-broken');
    expect(broken?.result).toEqual({
      status: 'indeterminate',
      detail: expect.stringMatching(/^fixture materialization failed for 'fixture-file'/),
    });
    const healthy = finished.find((e) => e.jobId === 'fix-healthy');
    expect(healthy?.result.status).toBe('ok');
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

describe('pre-runner probe accounting (review-debt #14)', () => {
  const probe: PreflightProbe = {
    at: '2026-09-20T00:00:00.000Z',
    promptChars: 30,
    replyChars: 120,
    replyPreview: '{"jsonrpc":"2.0","result":{"sessionUpdate":"agent_message_chunk"}}',
  };

  it('the probe is journaled with its labeled reservation and emits NO row', async () => {
    const dir = reviewSuite('probe-journal', 'probe-journal', [reviewCase('rev-1', 'resolved')]);
    const journalPath = join(root, 'journal');
    const result = await runSuite(opts(dir, { journalPath, preflightProbe: probe }));
    // The probe is accounting, not evidence: the run still scores its case.
    expect(result.gatedByBudget).toBe(false);
    expect(result.rows.map((r) => r.case)).toEqual(['rev-1']);
    assertSchemaValid(result.rows, result.tables);

    const log = openRunLog(journalPath);
    const events = await log.read((await log.runs())[0]!);
    const started = events.find((e) => e.type === 'job-started' && (e as { jobId: string }).jobId === PREFLIGHT_PROBE_JOB_ID);
    expect(started).toMatchObject({ op: 'acp-preflight', attempt: 1 });
    const finished = events.find(
      (e): e is JobFinishedJournalEvent => e.type === 'job-finished' && e.jobId === PREFLIGHT_PROBE_JOB_ID,
    );
    expect(finished?.result).toMatchObject({
      status: 'ok',
      value: {
        probe: 'acp-auth-preflight',
        reservedTokens: PREFLIGHT_PROBE_RESERVE_TOKENS,
        promptChars: 30,
        replyChars: 120,
      },
    });
    // The reservation is LABELED, never a measurement.
    expect(JSON.stringify(finished?.result)).toMatch(/reservation/);
    expect(finished).toMatchObject({
      usage: { input: PREFLIGHT_PROBE_RESERVE_TOKENS, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    // The probe pair precedes every case dispatch in the journal.
    const firstCaseStart = events.findIndex((e) => e.type === 'job-started' && (e as { jobId: string }).jobId === 'rev-1');
    expect(events.findIndex((e) => e === started)).toBeLessThan(firstCaseStart);
  }, 15_000);

  it('the probe reservation counts against the token cap: a cap below the reserve gates the run', async () => {
    // PREFLIGHT_PROBE_RESERVE_TOKENS (2000) exceeds maxTokens 100, so the
    // observeUsage fold trips the cap before the first case is admitted:
    // zero rows (no fabricated verdicts for work that never ran) and the
    // honest budget stop on run-finished. THIS is the proof the probe sits
    // INSIDE the governor.
    const dir = reviewSuite('probe-gated', 'probe-gated', [reviewCase('rev-1', 'resolved')]);
    const journalPath = join(root, 'journal-gated');
    const result = await runSuite(opts(dir, { journalPath, maxTokens: 100, preflightProbe: probe }));
    expect(result.gatedByBudget).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.tables[0]).toMatchObject({ cells: [] });

    const log = openRunLog(journalPath);
    const events = await log.read((await log.runs())[0]!);
    expect(events.some((e) => e.type === 'job-started' && (e as { jobId: string }).jobId === PREFLIGHT_PROBE_JOB_ID)).toBe(true);
    expect(events.some((e) => e.type === 'job-started' && (e as { jobId: string }).jobId === 'rev-1')).toBe(false);
    const runFinished = events.find((e): e is RunFinishedJournalEvent => e.type === 'run-finished');
    expect(runFinished).toMatchObject({ stoppedEarly: true, earlyStopReason: 'budget' });
  }, 15_000);

  it('control: the same tiny cap WITHOUT a probe still dispatches (the probe charge, not the cases, tripped it)', async () => {
    // The fake reports 120 tokens/case; admission precedes observation, so
    // the single case dispatches and only then trips the 100-token cap.
    const dir = reviewSuite('probe-control', 'probe-control', [reviewCase('rev-1', 'resolved')]);
    const result = await runSuite(opts(dir, { maxTokens: 100 }));
    expect(result.gatedByBudget).toBe(false);
    expect(result.rows.map((r) => r.case)).toEqual(['rev-1']);
  }, 15_000);

  it('every suite run in one process charges the reservation against its own cap', async () => {
    // Each suite invocation owns its own governor and journal, so a shared
    // --journal dir collects one probe pair PER run, each counting against
    // that run's cap — conservative in the same direction on each.
    const a = reviewSuite('probe-multi-a', 'probe-multi-a', [reviewCase('rev-a', 'resolved')]);
    const b = reviewSuite('probe-multi-b', 'probe-multi-b', [reviewCase('rev-b', 'resolved')]);
    const journalPath = join(root, 'journal-multi');
    await runSuite(opts(a, { journalPath, preflightProbe: probe }));
    await runSuite(opts(b, { journalPath, preflightProbe: probe }));
    const log = openRunLog(journalPath);
    const runs = await log.runs();
    expect(runs).toHaveLength(2);
    for (const runId of runs) {
      const events = await log.read(runId);
      expect(events.filter((e) => e.type === 'job-started' && (e as { jobId: string }).jobId === PREFLIGHT_PROBE_JOB_ID)).toHaveLength(1);
      expect(
        events.filter((e): e is JobFinishedJournalEvent => e.type === 'job-finished' && e.jobId === PREFLIGHT_PROBE_JOB_ID),
      ).toHaveLength(1);
    }
  }, 15_000);

  it('a --max-usd run with a probe behaves like one without (the probe adds no USD evidence)', async () => {
    // Unpriced lane under an explicit USD cap: the probe observes tokens
    // only, so the fail-closed trip still comes from the first case's
    // unpriced usage — identical shape to the no-probe run.
    const dir = reviewSuite('probe-usd', 'probe-usd', [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'resolved')]);
    const result = await runSuite(
      opts(dir, { model: 'glm-5.3-flash', provider: 'zai', maxUsd: 0.000001, maxTokens: 1_000_000, preflightProbe: probe }),
    );
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

describe('F4 per-verdict metrics (probes[] + byVerdict/macroF1/fpRate)', () => {
  function reviewCaseOn(id: string, fixture: string, expected: string): object {
    return {
      id,
      fixture,
      task: { prompt: 'Classify the review thread.' },
      probe: { kind: 'expected-verdict', expected },
    };
  }

  function threadPayload(n: number): object {
    return {
      id: n,
      path: 'src/example.ts',
      line: n,
      resolved: false,
      comments: [{ author: 'reviewer', body: `remark ${n}`, createdAt: '2026-09-16T00:00:00Z', isReply: false }],
    };
  }

  // Observed verdicts keyed by fixture file. null = the driver emits no
  // structuredOutput at all — a missing verdict is a miss with no predicted
  // bucket (the aggregate's null-observed rule).
  const OBSERVED: Record<string, string | null> = {
    'thread-1.json': 'actionable',
    'thread-2.json': null,
    'thread-3.json': 'responded',
    'thread-4.json': 'skip',
    'thread-5.json': 'blocked',
    'thread-6.json': 'actionable',
  };

  class FixtureVerdictDriver implements Driver {
    async run(invocation: OpInvocation): Promise<WorkerResult> {
      const m = /\(fixture (\S+?)\)/.exec(invocation.prompt);
      const verdict = m !== null ? OBSERVED[m[1]!] : undefined;
      return {
        model: invocation.modelSpec.model,
        ...(verdict !== undefined && verdict !== null ? { structuredOutput: { verdict } } : {}),
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'complete',
      };
    }
  }

  it('classifier rows carry probes[] with the observed verdict; the cell carries byVerdict/macroF1/fpRate', async () => {
    for (let n = 1; n <= 6; n++) {
      writeFileSync(join(root, `thread-${n}.json`), JSON.stringify(threadPayload(n)));
    }
    // Suspicious-benign subset: one wrong (c-skip-6 cries actionable on
    // adjudicated-benign content) and one right (c-resp-3) — fpN 2, fpRate 1/2.
    writeFileSync(join(root, 'thread-3.label.json'), JSON.stringify({ case: 'c-resp-3', fp_flag: 'suspicious-benign' }) + '\n');
    writeFileSync(join(root, 'thread-6.label.json'), JSON.stringify({ case: 'c-skip-6', fp_flag: 'suspicious-benign' }) + '\n');
    // A non-benign label is NOT the flag: fp_flag 'none' leaves the row unflagged.
    writeFileSync(join(root, 'thread-1.label.json'), JSON.stringify({ case: 'c-act-1', fp_flag: 'none' }) + '\n');
    const dir = reviewSuite('verdict-suite', 'verdict-suite', [
      reviewCaseOn('c-act-1', 'thread-1.json', 'actionable'),
      reviewCaseOn('c-act-2', 'thread-2.json', 'actionable'),
      reviewCaseOn('c-resp-3', 'thread-3.json', 'responded'),
      reviewCaseOn('c-resd-4', 'thread-4.json', 'resolved'),
      reviewCaseOn('c-blk-5', 'thread-5.json', 'blocked'),
      reviewCaseOn('c-skip-6', 'thread-6.json', 'skip'),
    ]);
    const result = await runSuite(opts(dir, { driver: new FixtureVerdictDriver() }));
    expect(result.rows).toHaveLength(6);

    // Row-level probes[]: one entry per case with expected + observed + passed.
    expect(result.rows.map((r) => [r.case, r.probes])).toEqual([
      ['c-act-1', [{ kind: 'expected-verdict', expected: 'actionable', observed: 'actionable', passed: true }]],
      ['c-act-2', [{ kind: 'expected-verdict', expected: 'actionable', observed: null, passed: false }]],
      ['c-resp-3', [{ kind: 'expected-verdict', expected: 'responded', observed: 'responded', passed: true }]],
      ['c-resd-4', [{ kind: 'expected-verdict', expected: 'resolved', observed: 'skip', passed: false }]],
      ['c-blk-5', [{ kind: 'expected-verdict', expected: 'blocked', observed: 'blocked', passed: true }]],
      ['c-skip-6', [{ kind: 'expected-verdict', expected: 'skip', observed: 'actionable', passed: false }]],
    ]);

    // The flag rides only on the two sidecar-marked cases; every other row
    // OMITS the key (absence means unflagged — never false-by-default).
    expect(Object.fromEntries(result.rows.map((r) => [r.case, 'suspiciousBenign' in r]))).toEqual({
      'c-act-1': false,
      'c-act-2': false,
      'c-resp-3': true,
      'c-resd-4': false,
      'c-blk-5': false,
      'c-skip-6': true,
    });

    // Cell-level confusion: the null observed (c-act-2) is a miss with no
    // predicted bucket; the skip-observed-on-resolved (c-resd-4) lands in
    // resolved's predicted bucket under the skip key (and counts as a false
    // positive for skip via the predicted totals). Per-verdict F1s:
    // actionable 2/(2+1+1) = 0.5, responded 1, resolved 0, blocked 1, skip 0
    // → macroF1 = 2.5/5 = 0.5.
    const cell = result.tables[0]!.cells[0]!;
    expect(cell).toMatchObject({ runs: 6, passed: 3, total: 6, score: 0.5, fpN: 2, fpRate: 0.5 });
    expect(cell.byVerdict).toEqual({
      actionable: { expected: 2, correct: 1, predicted: { actionable: 1 } },
      responded: { expected: 1, correct: 1, predicted: { responded: 1 } },
      resolved: { expected: 1, correct: 0, predicted: { skip: 1 } },
      blocked: { expected: 1, correct: 1, predicted: { blocked: 1 } },
      skip: { expected: 1, correct: 0, predicted: { actionable: 1 } },
    });
    expect(cell.macroF1).toBeCloseTo(0.5, 10);
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('fpRate counts only observed-actionable on benign rows (CodeRabbit cycle-1: a miss with any other observed verdict is not an FP)', () => {
    const row = (id: string, expected: string, observed: string | null): ResultRow => ({
      role: 'review-classifier',
      suite: 'fp-rule',
      case: id,
      model: 'glm-5.3-flash',
      driver: 'ai-sdk',
      outcome: { score: observed === expected ? 1 : 0, passed: observed === expected ? 1 : 0, total: 1 },
      probes: [{ kind: 'expected-verdict', expected, observed, passed: observed === expected }],
      suspiciousBenign: true,
      costUSD: null,
      wallTimeMs: 10,
      tokens: { input: 1, output: 1 },
      runId: 'run-fp-rule',
      timestamp: '2026-09-21T00:00:00Z',
    });
    const [table] = aggregate([
      row('c1', 'skip', 'actionable'), // cried wolf: the one FP
      row('c2', 'responded', 'skip'), // miss, wrong non-actionable verdict: not an FP
      row('c3', 'resolved', null), // miss, unparseable answer: not an FP
    ]);
    expect(table!.cells[0]).toMatchObject({ fpN: 3, fpRate: 1 / 3 });
  });

  it('a classifier case with a missing sidecar omits the flag LOUDLY: row shape unchanged, one case diagnostic (r1-F3)', async () => {
    writeFileSync(join(root, 'lonely.json'), JSON.stringify(threadPayload(7)));
    // No lonely.label.json anywhere: the flag must be omitted AND diagnosed.
    const dir = reviewSuite('sidecar-diag', 'sidecar-diag', [
      reviewCaseOn('c-lonely', 'lonely.json', 'resolved'),
    ]);
    const result = await runSuite(opts(dir));
    expect(result.rows).toHaveLength(1);
    expect('suspiciousBenign' in result.rows[0]!).toBe(false);
    expect(result.rows[0]!.probes).toEqual([
      { kind: 'expected-verdict', expected: 'resolved', observed: 'resolved', passed: true },
    ]);
    expect(result.diagnostics).toContain(
      "case c-lonely: label sidecar 'lonely.label.json' absent — suspiciousBenign flag omitted",
    );
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('mixed probed/unprobed classifier cell: score counts every row, byVerdict/macroF1 count probed rows only (r1-F4)', () => {
    const probed: ResultRow = {
      role: 'review-classifier',
      suite: 'mixed-cell',
      case: 'c-scored',
      model: 'glm-5.3-flash',
      driver: 'ai-sdk',
      outcome: { score: 1, passed: 1, total: 1 },
      probes: [{ kind: 'expected-verdict', expected: 'actionable', observed: 'actionable', passed: true }],
      costUSD: null,
      wallTimeMs: 10,
      tokens: { input: 1, output: 1 },
      runId: 'run-mixed-cell',
      timestamp: '2026-09-21T00:00:00Z',
    };
    // A zero-path row (driver-throw): honest outcome failure, no probes[] by I9.
    const unprobed: ResultRow = {
      ...probed,
      case: 'c-thrown',
      outcome: { score: 0, passed: 0, total: 1 },
    };
    delete (unprobed as { probes?: unknown }).probes;
    const [table] = aggregate([probed, unprobed]);
    const cell = table!.cells[0]!;
    // Score denominator covers both rows; confusion covers the scored one.
    expect(cell).toMatchObject({ runs: 2, passed: 1, total: 2, score: 0.5 });
    expect(cell.byVerdict!.actionable).toEqual({ expected: 1, correct: 1, predicted: { actionable: 1 } });
    expect(cell.macroF1).toBeCloseTo(0.2, 10);
    expect(cell).not.toHaveProperty('fpRate');
  });

  it('an out-of-vocabulary observed verdict is a miss with no predicted bucket (r1-F5)', () => {
    const row: ResultRow = {
      role: 'review-classifier',
      suite: 'oov-cell',
      case: 'c-oov',
      model: 'glm-5.3-flash',
      driver: 'ai-sdk',
      outcome: { score: 0, passed: 0, total: 1 },
      probes: [{ kind: 'expected-verdict', expected: 'skip', observed: 'maybe', passed: false }],
      costUSD: null,
      wallTimeMs: 10,
      tokens: { input: 1, output: 1 },
      runId: 'run-oov-cell',
      timestamp: '2026-09-21T00:00:00Z',
    };
    const [table] = aggregate([row]);
    const cell = table!.cells[0]!;
    expect(cell).toMatchObject({ runs: 1, passed: 0, total: 1, score: 0 });
    expect(cell.byVerdict!.skip).toEqual({ expected: 1, correct: 0, predicted: {} });
    expect(cell.macroF1).toBe(0);
  });

  it('fixer rows and cells carry none of the F4 fields (pre-F4 shape preserved)', async () => {
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    const dir = writeSuite('fixer-shape', {
      name: 'fixer-shape',
      role: 'fixer-worker',
      provenance: { origin: 'hand-seeded' },
      cases: [{ id: 'fix-1', fixture: 'fixture', task: { prompt: 'p' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });
    const result = await runSuite(opts(dir));
    expect(result.rows).toHaveLength(1);
    expect('probes' in result.rows[0]!).toBe(false);
    expect('suspiciousBenign' in result.rows[0]!).toBe(false);
    const cell = result.tables[0]!.cells[0]!;
    for (const k of ['byVerdict', 'macroF1', 'fpRate', 'fpN']) expect(cell).not.toHaveProperty(k);
    assertSchemaValid(result.rows, result.tables);
  }, 15_000);

  it('scoreReviewClassifier reports the observed verdict (null when missing, the string when out-of-vocabulary)', () => {
    const hit = scoreReviewClassifier(
      { probe: { kind: 'expected-verdict', expected: 'resolved' } },
      { structuredOutput: { verdict: 'resolved' } } as WorkerResult,
    );
    expect(hit).toMatchObject({ score: 1, passed: 1, total: 1, observed: 'resolved' });
    const missing = scoreReviewClassifier(
      { probe: { kind: 'expected-verdict', expected: 'resolved' } },
      {} as WorkerResult,
    );
    expect(missing).toMatchObject({ score: 0, observed: null });
    const oov = scoreReviewClassifier(
      { probe: { kind: 'expected-verdict', expected: 'resolved' } },
      { structuredOutput: { verdict: 'maybe' } } as WorkerResult,
    );
    expect(oov).toMatchObject({ score: 0, observed: 'maybe' });
  });
});
