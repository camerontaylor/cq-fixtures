import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate, type ResultRow } from '../runner/aggregate.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function runReplay(root: string, check: boolean) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/regrade-snapshots.mjs', ...(check ? ['--check'] : []), relative(REPO_ROOT, root)],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
}

const WB1_SUITE_SHA = 'ad7d24452b47e26a5820c484025264d9ab400ab6';
const W0_9_FIXER_RUN_ID = '36088a47-2fd6-4323-8d14-57edfa47f3dc';

function classifierMissSnapshot(snapshotRoot: string) {
  const suiteDir = mkdtempSync(join(REPO_ROOT, 'suites/review-classifier/regrade-null-miss-test-'));
  const cell = join(snapshotRoot, 'glm-5.3-flash', 'ai-sdk', 'review-classifier', 'null-miss');
  mkdirSync(join(cell, 'journal'), { recursive: true });
  const fixture = join(suiteDir, 'thread.json');
  writeFileSync(fixture, '{}\n');
  const suite = {
    name: 'regrade-null-miss-test',
    role: 'review-classifier',
    servedModel: 'glm-5.3-flash',
    provenance: { origin: 'deterministic-test' },
    cases: [{
      id: 'null-miss',
      fixture: relative(REPO_ROOT, fixture),
      task: { prompt: 'classify' },
      probe: { kind: 'expected-verdict', expected: 'resolved' },
    }],
  };
  writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify(suite, null, 2) + '\n');
  writeFileSync(join(cell, 'run.json'), JSON.stringify({
    runs: [{
      role: 'review-classifier',
      suite: suite.name,
      suiteDir: relative(REPO_ROOT, suiteDir),
      model: 'glm-5.3-flash',
      driver: 'ai-sdk',
      variant: 'default',
      toolkitLock: null,
      suiteSha: null,
      runId: 'regrade-null-miss-test',
      generatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }, null, 2) + '\n');
  const row: ResultRow = {
    role: 'review-classifier',
    suite: suite.name,
    case: 'null-miss',
    model: 'glm-5.3-flash',
    driver: 'ai-sdk',
    outcome: { score: 0, passed: 0, total: 1 },
    probes: [{ kind: 'expected-verdict', expected: 'resolved', observed: null, passed: false }],
    costUSD: null,
    wallTimeMs: 1,
    tokens: { input: 1, output: 1 },
    runId: 'regrade-null-miss-test',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  writeFileSync(join(cell, 'rows.jsonl'), JSON.stringify(row) + '\n');
  const table = aggregate([row])[0]!;
  table.generatedAt = '2026-01-01T00:00:00.000Z';
  writeFileSync(join(cell, 'review-classifier.table.json'), JSON.stringify(table, null, 2) + '\n');
  return { cell, suiteDir };
}

function fixerSnapshot(snapshotRoot: string, runId: string) {
  const suiteDir = mkdtempSync(join(REPO_ROOT, 'suites/fixer-worker/regrade-provenance-test-'));
  const cell = join(snapshotRoot, 'glm-5.3-flash', 'ai-sdk', 'fixer-worker', 'provenance');
  mkdirSync(cell, { recursive: true });
  const suite = {
    name: 'regrade-provenance-test',
    role: 'fixer-worker',
    servedModel: 'glm-5.3-flash',
    provenance: { origin: 'deterministic-test' },
    cases: [{ id: 'provenance', fixture: join(suiteDir, 'provenance.json'), task: { prompt: 'fix' } }],
  };
  writeFileSync(join(suiteDir, 'provenance.json'), '{}\n');
  writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify(suite, null, 2) + '\n');
  writeFileSync(join(cell, 'run.json'), JSON.stringify({
    runs: [{
      role: 'fixer-worker',
      suite: suite.name,
      suiteDir: relative(REPO_ROOT, suiteDir),
      model: 'glm-5.3-flash',
      driver: 'ai-sdk',
      variant: 'default',
      toolkitLock: null,
      suiteSha: null,
      runId,
      generatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }, null, 2) + '\n');
  const row: ResultRow = {
    role: 'fixer-worker',
    suite: suite.name,
    case: 'provenance',
    model: 'glm-5.3-flash',
    driver: 'ai-sdk',
    outcome: { score: 1, passed: 1, total: 1 },
    costUSD: null,
    wallTimeMs: 1,
    tokens: { input: 1, output: 1 },
    runId,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  writeFileSync(join(cell, 'rows.jsonl'), JSON.stringify(row) + '\n');
  const table = aggregate([row])[0]!;
  table.generatedAt = '2026-01-01T00:00:00.000Z';
  writeFileSync(join(cell, 'fixer-worker.table.json'), JSON.stringify(table, null, 2) + '\n');
  return { cell, suiteDir };
}

describe('committed WB-1 regrade replay', () => {
  it('is deterministic, leaves the checked-in snapshot unchanged, and succeeds check while reporting absent sidecars', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/regrade-snapshots.mjs', '--check', 'reports/snapshots/2026-09-21-wb1'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('checked 24 snapshot cells (0 file(s) changed)\n');
    expect(result.stderr).toMatch(/^snapshot regrade label sidecar diagnostics \(40\):/);
    expect(result.stderr).toContain(
      "reports/snapshots/2026-09-21-wb1/deepseek-flash/ai-sdk/review-classifier/micro: case thread-01: label sidecar 'fixtures/threads/thread-01.label.json' absent — suspiciousBenign flag omitted",
    );
  }, 120_000);

  it.each(['run.json', 'rows.jsonl'])('fails discovery for a directory containing only %s', (onlyFile) => {
    const snapshotRoot = mkdtempSync(join(REPO_ROOT, 'reports/snapshots/regrade-partial-test-'));
    const partial = join(snapshotRoot, 'partial');
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, onlyFile), onlyFile === 'run.json' ? '{"runs":[]}\n' : '');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`incomplete snapshot cell — missing ${onlyFile === 'run.json' ? 'rows.jsonl' : 'run.json'}`);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails discovery when the snapshot contains zero cells', () => {
    const snapshotRoot = mkdtempSync(join(REPO_ROOT, 'reports/snapshots/regrade-zero-test-'));
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no snapshot cells found');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('validates an existing null/false classifier miss against structured-output-miss journal evidence', () => {
    const snapshotRoot = mkdtempSync(join(REPO_ROOT, 'reports/snapshots/regrade-null-miss-test-'));
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    const journal = join(cell, 'journal', 'events.ndjson');
    writeFileSync(journal, JSON.stringify({
      type: 'job-finished',
      jobId: 'null-miss',
      result: {
        status: 'failed',
        error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
      },
    }) + '\n');
    try {
      const supported = runReplay(snapshotRoot, true);
      expect(supported.status).toBe(0);
      expect(supported.stderr).toContain('label sidecar');

      writeFileSync(journal, '');
      const unsupported = runReplay(snapshotRoot, true);
      expect(unsupported.status).toBe(1);
      expect(unsupported.stderr).toContain(
        'case null-miss has a null/false classifier probe without journal structured-output-miss evidence',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('loads the suite and sidecars from the manifest suite revision and fails loudly when unavailable', () => {
    const snapshotRoot = mkdtempSync(join(REPO_ROOT, 'reports/snapshots/regrade-recorded-revision-test-'));
    const cell = join(snapshotRoot, 'glm-5.3-flash', 'ai-sdk', 'review-classifier', 'micro');
    mkdirSync(join(cell, 'journal'), { recursive: true });
    const manifestPath = join(cell, 'run.json');
    writeFileSync(manifestPath, JSON.stringify({
      runs: [{
        role: 'review-classifier',
        suite: 'micro',
        suiteDir: 'suites/review-classifier/micro',
        model: 'glm-5.3-flash',
        driver: 'ai-sdk',
        variant: 'default',
        toolkitLock: null,
        suiteSha: WB1_SUITE_SHA,
        runId: 'recorded-revision-test',
        generatedAt: '2026-01-01T00:00:00.000Z',
      }],
    }, null, 2) + '\n');
    const row: ResultRow = {
      role: 'review-classifier',
      suite: 'micro',
      case: 'thread-01',
      model: 'glm-5.3-flash',
      driver: 'ai-sdk',
      outcome: { score: 1, passed: 1, total: 1 },
      probes: [{ kind: 'expected-verdict', expected: 'actionable', observed: 'actionable', passed: true }],
      costUSD: null,
      wallTimeMs: 1,
      tokens: { input: 1, output: 1 },
      runId: 'recorded-revision-test',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(join(cell, 'rows.jsonl'), JSON.stringify(row) + '\n');
    const table = aggregate([row])[0]!;
    table.generatedAt = '2026-01-01T00:00:00.000Z';
    writeFileSync(join(cell, 'review-classifier.table.json'), JSON.stringify(table, null, 2) + '\n');

    try {
      const recorded = runReplay(snapshotRoot, true);
      expect(recorded.status).toBe(0);
      expect(recorded.stderr).toContain(
        "case thread-01: label sidecar 'fixtures/threads/thread-01.label.json' absent",
      );

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.runs[0].suiteSha = 'not-a-recorded-revision';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const unavailable = runReplay(snapshotRoot, true);
      expect(unavailable.status).toBe(1);
      expect(unavailable.stderr).toContain('recorded suite: git show not-a-recorded-revision:');
      expect(unavailable.stderr).toContain('failed');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('invalidates only the audited W0.9 fixer run identity, not a future fixer run', () => {
    const historicalRoot = mkdtempSync(join(REPO_ROOT, 'reports/snapshots/regrade-w09-run-test-'));
    const futureRoot = mkdtempSync(join(REPO_ROOT, 'reports/snapshots/regrade-future-run-test-'));
    const historical = fixerSnapshot(historicalRoot, W0_9_FIXER_RUN_ID);
    const future = fixerSnapshot(futureRoot, 'future-correctly-bound-run');
    try {
      expect(runReplay(historicalRoot, false).status).toBe(0);
      expect(runReplay(futureRoot, false).status).toBe(0);
      const historicalRow = JSON.parse(readFileSync(join(historical.cell, 'rows.jsonl'), 'utf8'));
      const futureRow = JSON.parse(readFileSync(join(future.cell, 'rows.jsonl'), 'utf8'));
      expect(historicalRow.invalid).toBe('workspace-unbound');
      expect(futureRow.invalid).toBeUndefined();
      expect(runReplay(historicalRoot, true).status).toBe(0);
      expect(runReplay(futureRoot, true).status).toBe(0);
    } finally {
      rmSync(historicalRoot, { recursive: true, force: true });
      rmSync(futureRoot, { recursive: true, force: true });
      rmSync(historical.suiteDir, { recursive: true, force: true });
      rmSync(future.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('preserves all five sidecar states and checks damaged states deterministically', () => {
    const suiteDir = mkdtempSync(join(REPO_ROOT, 'suites/review-classifier/regrade-sidecar-test-'));
    const snapshotRoot = mkdtempSync(join(REPO_ROOT, 'reports/snapshots/regrade-sidecar-test-'));
    const cell = join(snapshotRoot, 'glm-5.3-flash', 'ai-sdk', 'review-classifier', 'all-states');
    mkdirSync(join(cell, 'journal'), { recursive: true });

    const states: Array<{ id: string; label?: string }> = [
      { id: 'flagged', label: '{"fp_flag":"suspicious-benign"}' },
      { id: 'unflagged', label: '{"fp_flag":"none"}' },
      { id: 'unparseable', label: '{' },
      { id: 'invalid', label: '{}' },
      { id: 'absent' },
    ];
    const cases = states.map(({ id, label }, index) => {
      const fixture = join(suiteDir, `${id}.json`);
      writeFileSync(fixture, '{}\n');
      if (label !== undefined) writeFileSync(join(suiteDir, `${id}.label.json`), label);
      return {
        id,
        fixture: relative(REPO_ROOT, fixture),
        task: { prompt: 'classify' },
        probe: { kind: 'expected-verdict', expected: index % 2 === 0 ? 'actionable' : 'resolved' },
      };
    });
    writeFileSync(
      join(suiteDir, 'suite.json'),
      JSON.stringify({
        name: 'regrade-sidecar-test',
        role: 'review-classifier',
        servedModel: 'glm-5.3-flash',
        provenance: { origin: 'deterministic-test' },
        cases,
      }, null, 2) + '\n',
    );
    writeFileSync(
      join(cell, 'run.json'),
      JSON.stringify({
        runs: [{
          role: 'review-classifier',
          suite: 'regrade-sidecar-test',
          suiteDir: relative(REPO_ROOT, suiteDir),
          model: 'glm-5.3-flash',
          driver: 'ai-sdk',
          variant: 'default',
          toolkitLock: null,
          suiteSha: null,
          runId: 'regrade-sidecar-test',
          generatedAt: '2026-01-01T00:00:00.000Z',
        }],
      }, null, 2) + '\n',
    );
    const rows: ResultRow[] = cases.map((suiteCase) => ({
      role: 'review-classifier',
      suite: 'regrade-sidecar-test',
      case: suiteCase.id,
      model: 'glm-5.3-flash',
      driver: 'ai-sdk',
      outcome: { score: 1, passed: 1, total: 1 },
      probes: [{ kind: 'expected-verdict', expected: suiteCase.probe.expected, observed: suiteCase.probe.expected, passed: true }],
      costUSD: null,
      wallTimeMs: 1,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      runId: 'regrade-sidecar-test',
      timestamp: '2026-01-01T00:00:00.000Z',
    }));
    writeFileSync(join(cell, 'rows.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const table = aggregate(rows)[0]!;
    table.generatedAt = '2026-01-01T00:00:00.000Z';
    writeFileSync(join(cell, 'review-classifier.table.json'), JSON.stringify(table, null, 2) + '\n');

    try {
      const applied = runReplay(snapshotRoot, false);
      expect(applied.status).toBe(0);
      expect(applied.stderr).toMatch(/^snapshot regrade label sidecar diagnostics \(3\):/);
      expect(applied.stderr).toContain(' unparseable — suspiciousBenign flag omitted');
      expect(applied.stderr).toContain(' invalid content (fp_flag missing or outside none|suspicious-benign) — suspiciousBenign flag omitted');
      expect(applied.stderr).toContain(' absent — suspiciousBenign flag omitted');

      const rowsPath = join(cell, 'rows.jsonl');
      const tablePath = join(cell, 'review-classifier.table.json');
      const replayedRows = readFileSync(rowsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(Object.fromEntries(replayedRows.map((row) => [row.case, row.suspiciousBenign]))).toEqual({
        flagged: true,
        unflagged: undefined,
        unparseable: undefined,
        invalid: undefined,
        absent: undefined,
      });
      const firstAppliedBytes = readFileSync(rowsPath, 'utf8') + readFileSync(tablePath, 'utf8');
      const secondApplied = runReplay(snapshotRoot, false);
      expect(secondApplied.status).toBe(0);
      expect(secondApplied.stderr).toBe(applied.stderr);
      expect(readFileSync(rowsPath, 'utf8') + readFileSync(tablePath, 'utf8')).toBe(firstAppliedBytes);

      const firstCheck = runReplay(snapshotRoot, true);
      const secondCheck = runReplay(snapshotRoot, true);
      expect(firstCheck.status).toBe(0);
      expect(firstCheck.stdout).toBe('checked 1 snapshot cells (0 file(s) changed)\n');
      expect(firstCheck.stderr).toBe(secondCheck.stderr);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);
});
