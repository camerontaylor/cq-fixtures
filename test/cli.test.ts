import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliMain } from '../runner/cli.ts';

// CLI-path tests: exit codes (F4) and role-dependent AiSdkDriver construction
// (F3). The toolkit barrel is mocked with the REAL module spread back in —
// only AiSdkDriver is replaced by a mock that records its constructor
// options, so no network and no live keys are ever touched.

const captured = vi.hoisted(() => ({ constructorOptions: [] as unknown[] }));

vi.mock('@camerontaylor/cq-toolkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camerontaylor/cq-toolkit')>();
  class MockAiSdkDriver {
    constructor(options?: unknown) {
      captured.constructorOptions.push(options);
    }
    async run(invocation: OpInvocation): Promise<WorkerResult> {
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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface SuiteSpec {
  name: string;
  role: 'fixer-worker' | 'review-classifier';
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
});

describe('role-dependent AiSdkDriver construction (F3)', () => {
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
});
