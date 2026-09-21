import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliMain } from '../runner/cli.ts';

// CLI-path tests: exit codes (F4) and per-lane driver construction (F3).
// The toolkit barrel is mocked with the REAL module spread back in — only
// the driver classes are replaced by mocks that record their constructor
// options, so no network, no spawn, and no live keys are ever touched.

const captured = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  // Real-lane drivers (claude-agent|subprocess|acp): constructor options
  // recorded per toolkit class name, so lane tests can assert construction
  // identity the same way the ai-sdk tests do.
  laneOptions: {} as Record<string, unknown[]>,
  // When set, the mocked ai-sdk driver throws this pre-dispatch (the
  // toolkit's requireKey missing-env shape).
  driverThrow: null as Error | null,
}));

vi.mock('@camerontaylor/cq-toolkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camerontaylor/cq-toolkit')>();
  class MockAiSdkDriver {
    constructor(options?: unknown) {
      captured.constructorOptions.push(options);
    }
    async run(invocation: OpInvocation): Promise<WorkerResult> {
      if (captured.driverThrow !== null) throw captured.driverThrow;
      return {
        model: invocation.modelSpec.model,
        structuredOutput: { verdict: 'resolved' },
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'complete',
      };
    }
  }
  // The real lanes record construction per class name and mirror
  // MockAiSdkDriver's resolved-verdict run shape — construction identity is
  // the test subject; the mock never spawns or touches the network.
  function recordedLaneDriver(cls: string) {
    return class {
      constructor(options?: unknown) {
        (captured.laneOptions[cls] ??= []).push(options);
      }
      async run(invocation: OpInvocation): Promise<WorkerResult> {
        if (captured.driverThrow !== null) throw captured.driverThrow;
        return {
          model: invocation.modelSpec.model,
          structuredOutput: { verdict: 'resolved' },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'complete',
        };
      }
    };
  }
  return {
    ...actual,
    AiSdkDriver: MockAiSdkDriver,
    ClaudeAgentDriver: recordedLaneDriver('ClaudeAgentDriver'),
    SubprocessDriver: recordedLaneDriver('SubprocessDriver'),
    AcpDriver: recordedLaneDriver('AcpDriver'),
  };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-fixture-cli-'));
  captured.constructorOptions.length = 0;
  captured.laneOptions = {};
  captured.driverThrow = null;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface SuiteSpec {
  name: string;
  role: 'fixer-worker' | 'review-classifier';
  servedModel?: string;
  provenance?: object;
  cases: object[];
}

function writeSuite(dirName: string, spec: SuiteSpec): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'suite.json'),
    JSON.stringify(
      {
        servedModel: 'glm-5.3-flash',
        provenance: { origin: 'hand-seeded' },
        ...spec,
      },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

function reviewCase(id: string, expected: string): object {
  // J3 payload injection: runSuite reads the classifier fixture from the repo
  // root (cliMain exposes no repoRoot override), so classifier cases here
  // reference a REAL repo fixture — thread-01.json — instead of the pre-J3
  // nonexistent 'fixture' placeholder.
  return {
    id,
    fixture: 'fixtures/threads/thread-01.json',
    task: { prompt: 'Classify the review thread.' },
    probe: { kind: 'expected-verdict', expected },
  };
}

function fixerCase(id: string): object {
  // The fixer probe is a real check-rerun judge; the untouched micro-1
  // fixture fails it (score 0) but still produces a row — the multi-suite
  // cap test counts dispatched rows, not scores.
  return {
    id,
    fixture: 'fixtures/micro-1',
    task: { prompt: 'Fix the failing vitest suite.' },
    probe: { kind: 'check-rerun', check: 'fixtures/micro-1/check.mjs' },
  };
}

function cliArgs(suiteDir: string): string[] {
  return ['--suite', suiteDir, '--driver', 'ai-sdk', '--driver-name', 'ai-sdk', '--model', 'glm-5.3-flash', '--provider', 'zai'];
}

describe('cliMain exit codes (I1: 0 clean, 1 eval/run failure, 2 usage or suite load failure)', () => {
  it('a clean run exits 0', async () => {
    const dir = writeSuite('ok-suite', { name: 'ok-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(cliArgs(dir))).resolves.toBe(0);
  }, 15_000);

  it('a scored-zero run exits 1 — a benign eval outcome, not a hard failure', async () => {
    const dir = writeSuite('zero-suite', { name: 'zero-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'actionable')] });
    await expect(cliMain(cliArgs(dir))).resolves.toBe(1);
  }, 15_000);

  it('a SCHEMA-INVALID suite.json exits 2 (hard fail in the workflow rc>=2 branch)', async () => {
    const dir = join(root, 'invalid-suite');
    mkdirSync(dir, { recursive: true });
    // Missing the required provenance object — fails suite.schema.json.
    writeFileSync(join(dir, 'suite.json'), JSON.stringify({ name: 'invalid-suite', role: 'review-classifier', cases: [] }));
    await expect(cliMain(cliArgs(dir))).resolves.toBe(2);
  }, 15_000);

  it('an UNREADABLE suite dir (no suite.json) exits 2', async () => {
    const dir = join(root, 'empty-suite-dir');
    mkdirSync(dir, { recursive: true });
    await expect(cliMain(cliArgs(dir))).resolves.toBe(2);
  }, 15_000);

  it('a usage error (unknown flag) exits 2', async () => {
    const dir = writeSuite('usage-suite', { name: 'usage-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain([...cliArgs(dir), '--bogus'])).resolves.toBe(2);
  }, 15_000);

  it('a driver missing-credential throw (generic requireKey shape) exits 2 — never zeros-while-green', async () => {
    const dir = writeSuite('key-suite', { name: 'key-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    // A different lane than zai, proving the predicate is shape-generic.
    captured.driverThrow = new Error("ai-sdk driver: provider 'anthropic' requires ANTHROPIC_API_KEY in the environment");
    await expect(cliMain(cliArgs(dir))).resolves.toBe(2);
    // The run aborted: no tables/rows were published for the aborted suite.
  }, 15_000);
});

describe('--probe-record (review-debt #14: the pre-runner probe rides inside the governor/journal)', () => {
  const record = {
    probe: 'acp-auth-preflight',
    at: '2026-09-20T00:00:00.000Z',
    promptChars: 30,
    replyChars: 120,
    replyPreview: 'ready',
  };

  function writeRecord(name: string, content: string): string {
    const path = join(root, name);
    writeFileSync(path, content);
    return path;
  }

  it('a missing record file exits 2 (fail loud — never silently ungoverned)', async () => {
    const dir = writeSuite('probe-missing', { name: 'probe-missing', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain([...cliArgs(dir), '--probe-record', join(root, 'does-not-exist.json')])).resolves.toBe(2);
  }, 15_000);

  it('a malformed record exits 2', async () => {
    const dir = writeSuite('probe-malformed', { name: 'probe-malformed', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    const bad = writeRecord('bad-probe.json', 'not json{');
    await expect(cliMain([...cliArgs(dir), '--probe-record', bad])).resolves.toBe(2);
  }, 15_000);

  it('a wrong-shaped record exits 2', async () => {
    const dir = writeSuite('probe-shape', { name: 'probe-shape', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    const shaped = writeRecord('shaped-probe.json', JSON.stringify({ probe: 'something-else' }));
    await expect(cliMain([...cliArgs(dir), '--probe-record', shaped])).resolves.toBe(2);
  }, 15_000);

  it('a record violating the documented bounds (bad at, over-long preview, non-integer counts, extra keys) exits 2', async () => {
    const dir = writeSuite('probe-bounds', { name: 'probe-bounds', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    const badAt = writeRecord('probe-bad-at.json', JSON.stringify({ ...record, at: 'not-a-datetime' }));
    await expect(cliMain([...cliArgs(dir), '--probe-record', badAt])).resolves.toBe(2);
    const longPreview = writeRecord('probe-long.json', JSON.stringify({ ...record, replyPreview: 'x'.repeat(201) }));
    await expect(cliMain([...cliArgs(dir), '--probe-record', longPreview])).resolves.toBe(2);
    // Counts are non-negative integers: negatives and floats are rejected.
    const negative = writeRecord('probe-negative.json', JSON.stringify({ ...record, promptChars: -1 }));
    await expect(cliMain([...cliArgs(dir), '--probe-record', negative])).resolves.toBe(2);
    const float = writeRecord('probe-float.json', JSON.stringify({ ...record, replyChars: 1.5 }));
    await expect(cliMain([...cliArgs(dir), '--probe-record', float])).resolves.toBe(2);
    // The schema is strict: unknown keys fail loud instead of dropping.
    const extra = writeRecord('probe-extra.json', JSON.stringify({ ...record, extra: true }));
    await expect(cliMain([...cliArgs(dir), '--probe-record', extra])).resolves.toBe(2);
  }, 15_000);

  it('a valid record runs clean (exit 0) — the reservation fits the uncapped run', async () => {
    const dir = writeSuite('probe-ok', { name: 'probe-ok', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    const rec = writeRecord('probe.json', JSON.stringify(record));
    await expect(cliMain([...cliArgs(dir), '--probe-record', rec])).resolves.toBe(0);
  }, 15_000);

  it('a valid record with a sub-reserve token cap gates the run (exit 1, no rows — the probe is inside the governor)', async () => {
    const dir = writeSuite('probe-gated', { name: 'probe-gated', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    const rec = writeRecord('probe-gated.json', JSON.stringify(record));
    const outDir = join(root, 'out');
    await expect(cliMain([...cliArgs(dir), '--probe-record', rec, '--max-tokens', '100', '--out', outDir])).resolves.toBe(1);
    // Budget-gated, not scored: the empty-but-valid table, no rows.
    const table = JSON.parse(readFileSync(join(outDir, 'review-classifier.table.json'), 'utf8')) as { cells: unknown[] };
    expect(table.cells).toEqual([]);
  }, 15_000);
});

describe('--max-tokens-per-case (WB-1.6: the cap scales with suite size)', () => {
  it('is mutually exclusive with --max-tokens (two denominations) — exit 2', async () => {
    const dir = writeSuite('cap-both', { name: 'cap-both', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain([...cliArgs(dir), '--max-tokens', '200000', '--max-tokens-per-case', '60000'])).resolves.toBe(2);
  }, 15_000);

  it('rejects a non-positive per-case budget — exit 2', async () => {
    const dir = writeSuite('cap-zero', { name: 'cap-zero', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain([...cliArgs(dir), '--max-tokens-per-case', '0'])).resolves.toBe(2);
  }, 15_000);

  it('gates admission at perCase × caseCount (NOT a flat cap): 3 cases at 5 tokens/case trips after case 2', async () => {
    // The mocked driver reports 15 tokens/case. cap = 5 × 3 = 15: case 1
    // observes 15 (not > 15), case 2 pushes the fold to 30 (> 15) and trips,
    // so case 3 is refused admission and gets NO row (I9). A flat 200000 cap
    // would have dispatched all three.
    const dir = writeSuite('cap-scale', {
      name: 'cap-scale',
      role: 'review-classifier',
      cases: [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'resolved'), reviewCase('rev-3', 'resolved')],
    });
    const outDir = join(root, 'cap-scale-out');
    const journalDir = join(outDir, 'journal');
    await expect(
      cliMain([...cliArgs(dir), '--max-tokens-per-case', '5', '--journal', journalDir, '--out', outDir]),
    ).resolves.toBe(1);
    const rows = readFileSync(join(outDir, 'rows.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { case?: string });
    expect(rows.map((r) => r.case)).toEqual(['rev-1', 'rev-2']);
    // I9: the honest stop is journaled, not merely implied by the missing row.
    const journalFile = readdirSync(journalDir)[0]!;
    const events = readFileSync(join(journalDir, journalFile), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; stoppedEarly?: boolean; earlyStopReason?: string });
    const finished = events.find((e) => e.type === 'run-finished');
    expect(finished).toMatchObject({ stoppedEarly: true, earlyStopReason: 'budget' });
  }, 15_000);

  it('a per-case budget large enough dispatches every case cleanly — exit 0', async () => {
    const dir = writeSuite('cap-roomy', {
      name: 'cap-roomy',
      role: 'review-classifier',
      cases: [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'resolved'), reviewCase('rev-3', 'resolved')],
    });
    await expect(cliMain([...cliArgs(dir), '--max-tokens-per-case', '60000'])).resolves.toBe(0);
  }, 15_000);

  it('allocates a NON-OVERLAPPING cap per suite in one invocation (not one reset total)', async () => {
    // Two suites (one per role, B4) at perCase 5 × 2 cases = cap 10 each. The
    // mock reports 15 tokens/case, so each suite admits exactly its first
    // case and gates its second. A single invocation-wide cap reset per suite
    // (the retired bug) would give each suite 5 × 4 = 20 and dispatch all
    // four cases.
    const fixer = writeSuite('multi-fixer', {
      name: 'multi-fixer',
      role: 'fixer-worker',
      cases: [fixerCase('fix-1'), fixerCase('fix-2')],
    });
    const clf = writeSuite('multi-clf', {
      name: 'multi-clf',
      role: 'review-classifier',
      cases: [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'resolved')],
    });
    const outDir = join(root, 'multi-out');
    await expect(
      cliMain([
        '--suite', fixer, '--suite', clf,
        '--driver', 'ai-sdk', '--driver-name', 'ai-sdk',
        '--model', 'glm-5.3-flash', '--provider', 'zai',
        '--max-tokens-per-case', '5', '--out', outDir,
      ]),
    ).resolves.toBe(1);
    const rows = readFileSync(join(outDir, 'rows.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { case?: string });
    expect(rows.map((r) => r.case)).toEqual(['fix-1', 'rev-1']);
  }, 30_000);

  it('the ACP probe reservation rides ON TOP of the per-case budget (not deducted from it)', async () => {
    // perCase 5 × 2 cases = cap 10; with the probe reservation added on top
    // the cap is 2010, so the 2000-token reservation is admitted and case 1
    // runs (2015 > 2010 trips before case 2, which is refused — one row).
    // If the reservation were deducted from the case budget (cap 10), the
    // probe would trip the governor before case 1 and yield ZERO rows.
    const dir = writeSuite('cap-probe', {
      name: 'cap-probe',
      role: 'review-classifier',
      cases: [reviewCase('rev-1', 'resolved'), reviewCase('rev-2', 'resolved')],
    });
    const rec = join(root, 'cap-probe-record.json');
    writeFileSync(rec, JSON.stringify({ probe: 'acp-auth-preflight', at: '2026-09-20T00:00:00.000Z', promptChars: 30, replyChars: 120, replyPreview: 'ready' }));
    const outDir = join(root, 'cap-probe-out');
    await expect(cliMain([...cliArgs(dir), '--probe-record', rec, '--max-tokens-per-case', '5', '--out', outDir])).resolves.toBe(1);
    const rows = readFileSync(join(outDir, 'rows.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { case?: string });
    expect(rows.map((r) => r.case)).toEqual(['rev-1']);
  }, 15_000);
});

describe('gate checks (B2 axes, B3 servedModel, B4 same-role collision, B7 required --driver)', () => {
  it('an axis-violating pair (non-ai-sdk lane, non-GLM model) exits 2 BEFORE any run', async () => {
    const dir = writeSuite('axis-bad', { name: 'axis-bad', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    const code = await cliMain(['--suite', dir, '--driver', 'fake', '--driver-name', 'subprocess', '--model', 'deepseek-chat', '--provider', 'zai']);
    expect(code).toBe(2);
  }, 15_000);

  it('axis-legal pairs run: ai-sdk+deepseek and subprocess+glm-5.3-flash', async () => {
    const deepseek = writeSuite('axis-deepseek', { name: 'axis-deepseek', role: 'review-classifier', servedModel: 'deepseek-chat', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(['--suite', deepseek, '--driver', 'fake', '--driver-name', 'ai-sdk', '--model', 'deepseek-chat', '--provider', 'deepseek'])).resolves.toBe(0);
    const glm = writeSuite('axis-glm', { name: 'axis-glm', role: 'review-classifier', servedModel: 'glm-5.3-flash', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(['--suite', glm, '--driver', 'fake', '--driver-name', 'subprocess', '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(0);
  }, 15_000);

  it('a servedModel mismatch exits 2 before dispatch; a matching model runs', async () => {
    const pinned = writeSuite('pinned-suite', { name: 'pinned-suite', role: 'review-classifier', servedModel: 'glm-5.3-flash', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(['--suite', pinned, '--driver', 'fake', '--driver-name', 'ai-sdk', '--model', 'deepseek-chat', '--provider', 'deepseek'])).resolves.toBe(2);
    await expect(cliMain(['--suite', pinned, '--driver', 'fake', '--driver-name', 'ai-sdk', '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(0);
  }, 15_000);

  it('two same-role suites exit 2 with the collision refused pre-dispatch and NO rows written', async () => {
    const a = writeSuite('collide-a', { name: 'collide-a', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    const b = writeSuite('collide-b', { name: 'collide-b', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    const outDir = join(root, 'out');
    await expect(cliMain([...cliArgs(a), '--suite', b, '--out', outDir])).resolves.toBe(2);
    expect(existsSync(join(outDir, 'rows.jsonl'))).toBe(false);
    expect(existsSync(join(outDir, 'review-classifier.table.json'))).toBe(false);
  }, 15_000);

  it('an omitted --driver exits 2 (required — no silent fake default)', async () => {
    const dir = writeSuite('nodriver-suite', { name: 'nodriver-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(['--suite', dir, '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(2);
  }, 15_000);

  it('a paid ai-sdk run mislabeled via --driver-name exits 2 (T1)', async () => {
    const dir = writeSuite('mislane-suite', { name: 'mislane-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(['--suite', dir, '--driver', 'ai-sdk', '--driver-name', 'subprocess', '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(2);
  }, 15_000);

  it('a bare --driver ai-sdk runs and labels rows ai-sdk (T1 legal path)', async () => {
    const dir = writeSuite('aidriver-suite', { name: 'aidriver-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(['--suite', dir, '--driver', 'ai-sdk', '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(0);
  }, 15_000);
  it('a run whose only case fails materialization exits 2 (infrastructure — the driver never ran)', async () => {
    // Fixture path does not exist: cpSync fails ENOENT inside runSuite, the
    // case emits no row, and cliMain maps the materialization failure to 2.
    const dir = writeSuite('cli-uncopyable', {
      name: 'cli-uncopyable',
      role: 'fixer-worker',
      cases: [{ id: 'fix-u', fixture: 'does-not-exist', task: { prompt: 'p' }, probe: { kind: 'check-rerun', check: 'does-not-exist/check.js' } }],
    });
    await expect(cliMain(['--suite', dir, '--driver', 'fake', '--driver-name', 'ai-sdk', '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(2);
  }, 15_000);

  it('X2 lists both infrastructure classes from the runner\'s structured diagnostics (fixer copy + classifier read)', async () => {
    // PR 10 review round 1: the classifier payload-read failure is the
    // second infrastructure shape ('fixture read failed for …'); round 3:
    // the X2 block now prints the runner's STRUCTURED
    // materializationDiagnostics directly — no prose re-matching — so both
    // classes list their affected case ids here in one invocation.
    const clf = writeSuite('clf-missing-payload', {
      name: 'clf-missing-payload',
      role: 'review-classifier',
      cases: [
        {
          id: 'thread-missing',
          fixture: 'fixtures/threads/does-not-exist.json',
          task: { prompt: 'Classify the review thread payload printed below.' },
          probe: { kind: 'expected-verdict', expected: 'resolved' },
        },
      ],
    });
    const fixer = writeSuite('fix-missing-fixture', {
      name: 'fix-missing-fixture',
      role: 'fixer-worker',
      cases: [
        {
          id: 'fix-missing',
          fixture: 'fixtures/micro-missing',
          task: { prompt: 'Fix the fault.' },
          probe: { kind: 'check-rerun', check: 'fixtures/micro-missing/check.mjs' },
        },
      ],
    });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(' '));
    });
    try {
      await expect(
        cliMain(['--suite', clf, '--suite', fixer, '--driver', 'fake', '--driver-name', 'ai-sdk', '--model', 'glm-5.3-flash', '--provider', 'zai']),
      ).resolves.toBe(2);
    } finally {
      spy.mockRestore();
    }
    const stderr = errors.join('\n');
    // The X2 count block ran with BOTH refusals counted…
    expect(stderr).toMatch(/2 case\(s\) failed fixture materialization \(the driver never ran\):/);
    // …and both affected case ids are listed beneath it.
    expect(stderr).toMatch(/case thread-missing: fixture read failed for 'fixtures\/threads\/does-not-exist\.json':/);
    expect(stderr).toMatch(/case fix-missing: fixture materialization failed for 'fixtures\/micro-missing':/);
  }, 15_000);
});

describe('role-dependent AiSdkDriver construction (F3/G6 — one driver PER SUITE)', () => {
  it('a review-classifier run constructs the driver WITH the verdict output schema', async () => {
    const dir = writeSuite('clf-suite', { name: 'clf-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await cliMain(cliArgs(dir));
    const options = captured.constructorOptions.at(-1) as { outputSchema?: { safeParse(v: unknown): { success: boolean } } } | undefined;
    expect(options).toBeDefined();
    expect(options!.outputSchema).toBeDefined();
    // The schema is the verdict vocabulary, not just any schema.
    expect(options!.outputSchema!.safeParse({ verdict: 'resolved' }).success).toBe(true);
    expect(options!.outputSchema!.safeParse({ verdict: 'weird' }).success).toBe(false);
    expect(options!.outputSchema!.safeParse({ nope: true }).success).toBe(false);
  }, 15_000);

  it('a fixer-only run constructs the driver WITH the fixer output schema (DD-4)', async () => {
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    const dir = writeSuite('fix-suite', {
      name: 'fix-suite',
      role: 'fixer-worker',
      cases: [{ id: 'fix-1', fixture: 'fixture', task: { prompt: 'Fix the fault.' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });
    await cliMain(cliArgs(dir));
    const options = captured.constructorOptions.at(-1) as { outputSchema?: { safeParse(v: unknown): { success: boolean } } } | undefined;
    expect(options).toBeDefined();
    expect(options!.outputSchema).toBeDefined();
    // The schema is the fixer's {fixed, notes} verdict shape (DD-4), not the
    // classifier's vocabulary and not just any schema.
    expect(options!.outputSchema!.safeParse({ fixed: true, notes: 'ok' }).success).toBe(true);
    expect(options!.outputSchema!.safeParse({ fixed: 'yes', notes: '' }).success).toBe(false);
    expect(options!.outputSchema!.safeParse({ verdict: 'resolved' }).success).toBe(false);
  }, 15_000);

  it('a MIXED invocation constructs per suite: fixer with the fixer schema, classifier with the verdict schema', async () => {
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    const fixer = writeSuite('mix-fixer', {
      name: 'mix-fixer',
      role: 'fixer-worker',
      cases: [{ id: 'fix-1', fixture: 'fixture', task: { prompt: 'p' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });
    const clf = writeSuite('mix-clf', { name: 'mix-clf', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await cliMain([...cliArgs(fixer), '--suite', clf]);
    expect(captured.constructorOptions).toHaveLength(2);
    // Fixer suite: the DD-4 {fixed, notes} schema — it must reject the
    // classifier's verdict shape so the two roles can never be confused.
    const fixerOptions = captured.constructorOptions[0] as { outputSchema?: { safeParse(v: unknown): { success: boolean } } };
    expect(fixerOptions.outputSchema).toBeDefined();
    expect(fixerOptions.outputSchema!.safeParse({ fixed: false, notes: '' }).success).toBe(true);
    expect(fixerOptions.outputSchema!.safeParse({ verdict: 'resolved' }).success).toBe(false);
    const clfOptions = captured.constructorOptions[1] as { outputSchema?: unknown };
    expect(clfOptions.outputSchema).toBeDefined(); // classifier suite: verdict schema
  }, 15_000);
});

describe('--driver parsing (fake|ai-sdk|claude-agent|subprocess|acp)', () => {
  it('accepts each real lane value and runs it through the mocked lane', async () => {
    const dir = writeSuite('lanes-suite', { name: 'lanes-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    // --driver-name is omitted: each lane defaults its own label and the
    // fixed served id keeps the ADR-0001 axis guard satisfied.
    for (const driver of ['claude-agent', 'subprocess', 'acp']) {
      await expect(cliMain(['--suite', dir, '--driver', driver, '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(0);
    }
  }, 15_000);

  it('an unknown --driver value exits 2', async () => {
    const dir = writeSuite('baddriver-suite', { name: 'baddriver-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(['--suite', dir, '--driver', 'telepathy', '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(2);
  }, 15_000);

  it('the ADR-0001 axis guard rejects a non-GLM model on each new lane', async () => {
    const dir = writeSuite('lane-axis-suite', { name: 'lane-axis-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    for (const driver of ['claude-agent', 'subprocess', 'acp']) {
      await expect(cliMain(['--suite', dir, '--driver', driver, '--model', 'deepseek-chat', '--provider', 'zai'])).resolves.toBe(2);
    }
  }, 15_000);

  it('the T1 mislabel guard still fires: a paid ai-sdk run labeled as a new lane exits 2', async () => {
    const dir = writeSuite('lane-mislabel-suite', { name: 'lane-mislabel-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(['--suite', dir, '--driver', 'ai-sdk', '--driver-name', 'claude-agent', '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(2);
  }, 15_000);

  it('the T1 mislabel guard covers every real lane: a non-ai-sdk driver with a mismatched --driver-name exits 2', async () => {
    // The guard is symmetric since the lane openings: any REAL driver run
    // labeled as another lane misattributes paid results the same way.
    const dir = writeSuite('lane-mislabel-2-suite', { name: 'lane-mislabel-2-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    for (const [driver, mislabel] of [
      ['claude-agent', 'ai-sdk'],
      ['subprocess', 'acp'],
      ['acp', 'subprocess'],
    ] as const) {
      await expect(cliMain(['--suite', dir, '--driver', driver, '--driver-name', mislabel, '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(2);
    }
  }, 15_000);

  it('a real lane with a matching --driver-name parses (the guard only refuses mismatches)', async () => {
    const dir = writeSuite('lane-label-ok-suite', { name: 'lane-label-ok-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await expect(cliMain(['--suite', dir, '--driver', 'claude-agent', '--driver-name', 'claude-agent', '--model', 'glm-5.3-flash', '--provider', 'zai'])).resolves.toBe(0);
  }, 15_000);
});

describe('real-lane driver construction (per-role schema; never spawns)', () => {
  it('--driver claude-agent constructs ClaudeAgentDriver WITH the verdict output schema', async () => {
    const dir = writeSuite('ca-ctor-suite', { name: 'ca-ctor-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await cliMain(['--suite', dir, '--driver', 'claude-agent', '--model', 'glm-5.3-flash', '--provider', 'zai']);
    const options = (captured.laneOptions.ClaudeAgentDriver ?? []).at(-1) as
      | { outputSchema?: { safeParse(v: unknown): { success: boolean } } }
      | undefined;
    expect(options).toBeDefined();
    expect(options!.outputSchema).toBeDefined();
    // The schema is the verdict vocabulary, not just any schema.
    expect(options!.outputSchema!.safeParse({ verdict: 'resolved' }).success).toBe(true);
    expect(options!.outputSchema!.safeParse({ verdict: 'weird' }).success).toBe(false);
  }, 15_000);

  it('--driver subprocess constructs SubprocessDriver with the routing override admitting glm-5.3-flash AND the five upstream names', async () => {
    const dir = writeSuite('sp-ctor-suite', { name: 'sp-ctor-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await cliMain(['--suite', dir, '--driver', 'subprocess', '--model', 'glm-5.3-flash', '--provider', 'zai']);
    const options = (captured.laneOptions.SubprocessDriver ?? []).at(-1) as
      | { outputSchema?: unknown; routingTable?: { endpoints: Record<string, { models: string[] }> } }
      | undefined;
    expect(options).toBeDefined();
    expect(options!.outputSchema).toBeDefined();
    const models = options!.routingTable!.endpoints['zai']!.models;
    // The served-id decision (2026-09-14): the override must admit the
    // fixed axis-2 served id…
    expect(models).toContain('glm-5.3-flash');
    // …while the upstream default allowlist it extends survives untouched.
    expect(models).toEqual(expect.arrayContaining(['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash', 'glm-4.5v']));
  }, 15_000);

  it('--driver acp constructs AcpDriver with the 0.43.x `server` subcommand argv and the verdict output schema', async () => {
    const dir = writeSuite('acp-ctor-suite', { name: 'acp-ctor-suite', role: 'review-classifier', cases: [reviewCase('rev-1', 'resolved')] });
    await cliMain(['--suite', dir, '--driver', 'acp', '--model', 'glm-5.3-flash', '--provider', 'zai']);
    const options = (captured.laneOptions.AcpDriver ?? []).at(-1) as
      | { outputSchema?: unknown; command?: readonly string[] }
      | undefined;
    expect(options).toBeDefined();
    expect(options!.outputSchema).toBeDefined();
    // The explicit argv wins over the endpoint table — it must be the whole
    // 0.43.x launch argv (server subcommand), not the stale bare bin.
    expect(options!.command).toEqual(['zcode-acp-server', 'server']);
  }, 15_000);

  it('a fixer-worker suite on a real lane requests the fixer schema, not the classifier vocabulary', async () => {
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    const dir = writeSuite('lane-fixer-suite', {
      name: 'lane-fixer-suite',
      role: 'fixer-worker',
      cases: [{ id: 'fix-1', fixture: 'fixture', task: { prompt: 'Fix the fault.' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });
    await cliMain(['--suite', dir, '--driver', 'claude-agent', '--model', 'glm-5.3-flash', '--provider', 'zai']);
    const options = (captured.laneOptions.ClaudeAgentDriver ?? []).at(-1) as
      | { outputSchema?: { safeParse(v: unknown): { success: boolean } } }
      | undefined;
    expect(options).toBeDefined();
    // The DD-4 {fixed, notes} shape — the real lanes are role-driven
    // exactly like the ai-sdk lane.
    expect(options!.outputSchema!.safeParse({ fixed: true, notes: 'ok' }).success).toBe(true);
    expect(options!.outputSchema!.safeParse({ verdict: 'resolved' }).success).toBe(false);
  }, 15_000);
});
