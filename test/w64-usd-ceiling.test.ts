import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliMain } from '../runner/cli.ts';
import type { ResultRow } from '../runner/aggregate.ts';

// W6.4 (D7/D9): the USD ceiling on the real matrix. Runner-side, the
// unattended refusal is enforced here: a real-lane run in CI
// (GITHUB_ACTIONS=true) whose only cap is the legacy run-level --max-usd —
// i.e. no per-case ceiling at all — is refused (exit 2) before any dispatch;
// attended runs keep the legacy semantics verbatim (the recorded W6.2
// decision). The workflow-side half (every matrix cell carries its D9
// `usd_per_case`, cross-checked against the runner's D9 table, and the
// acp leg's D7 non-fatal wiring) is the static workflow contract in
// test/workflow-contract.test.ts.
//
// Everything here is synthetic: real-lane cases only ever exercise the
// PARSE-TIME refusal (the guard sits in parseArgs, before any driver is
// constructed), and every run that completes uses the FakeDriver — zero
// network, zero spend.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-fixture-w64-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function writeClassifierSuite(dirName: string, servedModel: string): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'suite.json'),
    JSON.stringify({
      name: dirName,
      role: 'review-classifier',
      servedModel,
      provenance: { origin: 'hand-seeded' },
      cases: [
        {
          id: 'w64-1',
          // cliMain exposes no repoRoot override (same as the W6.2 CLI
          // tests): the fixture resolves against the real repo.
          fixture: 'fixtures/threads/thread-01.json',
          task: { prompt: 'Classify the review thread.' },
          probe: { kind: 'expected-verdict', expected: 'resolved' },
        },
      ],
    }) + '\n',
  );
  return dir;
}

/** Real-lane args: the guard's subject. A guarded run refuses in parseArgs, so a real driver is never constructed. */
function realLaneArgs(suiteDir: string, driver: string, model: string): string[] {
  return ['--suite', suiteDir, '--driver', driver, '--model', model, '--provider', 'zai'];
}

/** Fake args standing in for a lane: how the smoke proves pipeline and envelope coverage without spend. */
function fakeArgs(suiteDir: string, driverName: string, model: string): string[] {
  return ['--suite', suiteDir, '--driver', 'fake', '--driver-name', driverName, '--model', model, '--provider', 'zai'];
}

describe('unattended real runs without a per-case ceiling are refused (W6.4)', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
  });

  it.each(['ai-sdk', 'claude-agent', 'subprocess', 'acp'])('a bare --max-usd on the %s lane in CI exits 2 before any dispatch', async (driver) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir = writeClassifierSuite('ci-legacy', 'glm-5.3-flash');
      const code = await cliMain([...realLaneArgs(dir, driver, 'glm-5.3-flash'), '--max-usd', '5']);
      expect(code).toBe(2);
      const text = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(text).toMatch(/unattended real-lane run without a per-case USD ceiling \(W6\.4\)/);
      expect(text).toMatch(/--max-usd-per-case/);
      expect(text).toMatch(/D9 envelope caps the cell/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('an unmapped cell names the explicit-value requirement instead of a cap', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // deepseek-chat is retired and was never an envelope cell; the run
      // carries only the legacy run-level cap.
      const dir = writeClassifierSuite('ci-unmapped', 'deepseek-chat');
      const code = await cliMain([...realLaneArgs(dir, 'ai-sdk', 'deepseek-chat'), '--max-usd', '5']);
      expect(code).toBe(2);
      expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/no cap — an explicit value is required/);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('unattended runs that carry a ceiling run; attended semantics unchanged', () => {
  it('in CI the fake smoke shape (no USD flags) resolves the D9 default and records it', async () => {
    // The suite.yml smoke loop runs exactly this shape on every push: fake,
    // no USD flags, in CI. It must keep passing — the D9 resolution (W6.2)
    // is what gives it its ceiling.
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const dir = writeClassifierSuite('ci-d9', 'glm-5.3-flash');
    const out = join(root, 'out-ci-d9');
    const code = await cliMain([...fakeArgs(dir, 'subprocess', 'glm-5.3-flash'), '--out', out]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as { runs: Array<Record<string, unknown>> };
    expect(manifest.runs[0]?.maxUsdPerCase).toBe(0.1);
    expect(manifest.runs[0]?.maxUsdPerCaseBasis).toBe('d9-default');
  }, 15_000);

  it('in CI the matrix shape (explicit per-case ceiling) records basis explicit', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const dir = writeClassifierSuite('ci-explicit', 'glm-5.3-flash');
    const out = join(root, 'out-ci-explicit');
    const code = await cliMain([...fakeArgs(dir, 'ai-sdk', 'glm-5.3-flash'), '--max-usd-per-case', '0.05', '--out', out]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as { runs: Array<Record<string, unknown>> };
    expect(manifest.runs[0]?.maxUsdPerCase).toBe(0.05);
    expect(manifest.runs[0]?.maxUsdPerCaseBasis).toBe('explicit');
  }, 15_000);

  it('attended runs keep the legacy bare --max-usd semantics (no GITHUB_ACTIONS)', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    const dir = writeClassifierSuite('attended-legacy', 'glm-5.3-flash');
    const out = join(root, 'out-attended');
    // Fake stand-in: the same command on a real lane would dispatch a live
    // driver, which no test here may do — the guard's attended branch is the
    // absence of a refusal, proven by this run completing.
    const code = await cliMain([...fakeArgs(dir, 'ai-sdk', 'glm-5.3-flash'), '--max-usd', '5', '--out', out]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as { runs: Array<Record<string, unknown>> };
    expect(manifest.runs[0]?.maxUsdPerCase).toBeUndefined();
    expect(manifest.runs[0]?.maxUsdPerCaseBasis).toBeUndefined();
    // The ceiling columns still make the denominator computable from the
    // rows alone.
    const rows = (readFileSync(join(out, 'rows.jsonl'), 'utf8').trim().split('\n') ?? []).map(
      (l) => JSON.parse(l) as ResultRow,
    );
    expect(rows[0]?.expectedCases).toBe(1);
  }, 15_000);
});
