import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliMain } from '../runner/cli.ts';

// CLI-path tests: exit codes (F4) and role-dependent AiSdkDriver construction
// (F3). The toolkit barrel is mocked with the REAL module spread back in —
// only AiSdkDriver is replaced by a mock that records its constructor
// options, so no network and no live keys are ever touched.

const captured = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
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
  return { ...actual, AiSdkDriver: MockAiSdkDriver };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-fixture-cli-'));
  captured.constructorOptions.length = 0;
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
  return { id, fixture: 'fixture', task: { prompt: 'Classify the review thread.' }, probe: { kind: 'expected-verdict', expected } };
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

  it('a fixer-only run constructs the driver WITHOUT an output schema', async () => {
    mkdirSync(join(root, 'fixture'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    const dir = writeSuite('fix-suite', {
      name: 'fix-suite',
      role: 'fixer-worker',
      cases: [{ id: 'fix-1', fixture: 'fixture', task: { prompt: 'Fix the fault.' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    });
    await cliMain(cliArgs(dir));
    expect(captured.constructorOptions.at(-1)).toBeUndefined();
  }, 15_000);

  it('a MIXED invocation constructs per suite: fixer bare, classifier with schema', async () => {
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
    expect(captured.constructorOptions[0]).toBeUndefined(); // fixer suite: bare driver
    const clfOptions = captured.constructorOptions[1] as { outputSchema?: unknown };
    expect(clfOptions.outputSchema).toBeDefined(); // classifier suite: verdict schema
  }, 15_000);
});
