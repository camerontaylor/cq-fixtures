import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate, type ResultRow } from '../runner/aggregate.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function runReplay(
  root: string,
  check: boolean,
  {
    allowNullSuiteSha = true,
    allowAbsoluteSuite = true,
  }: { allowNullSuiteSha?: boolean; allowAbsoluteSuite?: boolean } = {},
) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/regrade-snapshots.mjs', ...(check ? ['--check'] : []), relative(REPO_ROOT, root)],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CQ_REGRADE_ALLOW_NULL_SUITE_SHA: allowNullSuiteSha ? '1' : '0',
        CQ_REGRADE_ALLOW_TEST_ABSOLUTE_SUITE: allowAbsoluteSuite ? '1' : '0',
      },
    },
  );
}

const WB1_SUITE_SHA = 'ad7d24452b47e26a5820c484025264d9ab400ab6';
const W0_9_FIXER_RUN_ID = '36088a47-2fd6-4323-8d14-57edfa47f3dc';

// Keep synthetic snapshots and suites out of repo-wide discovery.
function snapshotTempRoot(label: string) {
  return mkdtempSync(join(tmpdir(), `cq-regrade-${label}-`));
}

function suiteTempRoot(label: string) {
  return mkdtempSync(join(tmpdir(), `cq-regrade-suite-${label}-`));
}

function classifierMissSnapshot(snapshotRoot: string, observed: string | null = null) {
  const suiteDir = suiteTempRoot('classifier');
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
      fixture,
      task: { prompt: 'classify' },
      probe: { kind: 'expected-verdict', expected: 'resolved' },
    }],
  };
  writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify(suite, null, 2) + '\n');
  writeFileSync(join(cell, 'run.json'), JSON.stringify({
    runs: [{
      role: 'review-classifier',
      suite: suite.name,
      suiteDir,
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
    probes: [{ kind: 'expected-verdict', expected: 'resolved', observed, passed: false }],
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

function setRecordedAbsences(
  cell: string,
  absences: Array<{ case: string; cause: string }>,
): void {
  const runPath = join(cell, 'run.json');
  const manifest = JSON.parse(readFileSync(runPath, 'utf8')) as {
    runs: Array<{ absences?: Array<{ case: string; cause: string }> }>;
  };
  manifest.runs[0]!.absences = absences;
  writeFileSync(runPath, JSON.stringify(manifest, null, 2) + '\n');
}

function setFixerOutcome(cell: string, outcome: ResultRow['outcome']): void {
  const rowsPath = join(cell, 'rows.jsonl');
  const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
  row.outcome = outcome;
  writeFileSync(rowsPath, JSON.stringify(row) + '\n');
  const table = aggregate([row])[0]!;
  table.generatedAt = '2026-01-01T00:00:00.000Z';
  writeFileSync(join(cell, 'fixer-worker.table.json'), JSON.stringify(table, null, 2) + '\n');
}

function fixerSnapshot(snapshotRoot: string, runId: string) {
  const suiteDir = suiteTempRoot('fixer');
  const cell = join(snapshotRoot, 'glm-5.3-flash', 'ai-sdk', 'fixer-worker', 'provenance');
  mkdirSync(join(cell, 'journal'), { recursive: true });
  const check = join(suiteDir, 'check.mjs');
  const suite = {
    name: 'regrade-provenance-test',
    role: 'fixer-worker',
    servedModel: 'glm-5.3-flash',
    provenance: { origin: 'deterministic-test' },
    cases: [{
      id: 'provenance',
      fixture: join(suiteDir, 'provenance.json'),
      task: { prompt: 'fix' },
      probe: { kind: 'check-rerun', check },
    }],
  };
  writeFileSync(join(suiteDir, 'provenance.json'), '{}\n');
  writeFileSync(check, '// synthetic offline replay check\n');
  writeFileSync(join(suiteDir, 'QUARANTINE.md'), '# Synthetic regrade fixture\n\n- Date quarantined: 2026-01-01 (UTC)\n');
  writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify(suite, null, 2) + '\n');
  writeFileSync(join(cell, 'run.json'), JSON.stringify({
    runs: [{
      role: 'fixer-worker',
      suite: suite.name,
      suiteDir,
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
  writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
    type: 'job-finished',
    runId,
    jobId: row.case,
    result: { status: 'ok', value: row.outcome },
  }) + '\n');
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
    // A depth-one CI checkout may print provenance fallbacks before diagnostics.
    expect(result.stderr).toContain('snapshot regrade label sidecar diagnostics (40):');
    expect(result.stderr).toContain(
      "reports/snapshots/2026-09-21-wb1/deepseek-flash/ai-sdk/review-classifier/micro: case thread-01: label sidecar 'fixtures/threads/thread-01.label.json' absent — suspiciousBenign flag omitted",
    );
  }, 120_000);

  it.each(['run.json', 'rows.jsonl'])('fails discovery for a directory containing only %s', (onlyFile) => {
    const snapshotRoot = snapshotTempRoot('partial-test');
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

  it('rejects a table-only directory instead of silently recursing into a nested cell', () => {
    const snapshotRoot = snapshotTempRoot('table-only-test');
    const tableOnly = join(snapshotRoot, 'table-only');
    mkdirSync(tableOnly, { recursive: true });
    writeFileSync(join(tableOnly, 'fixer-worker.table.json'), '{}\n');
    const { cell, suiteDir } = fixerSnapshot(tableOnly, 'table-only-test');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `incomplete snapshot cell — table file(s) present but missing run.json and rows.jsonl`,
      );
      expect(result.stderr).not.toContain(cell);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('accepts an absence-only cell when run.json and the journal account for every no-row job', () => {
    const snapshotRoot = snapshotTempRoot('absence-only-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'absence-only-test');
    const cause = 'ai-sdk driver: [endpoint-timeout] run failed — synthetic infrastructure failure';
    writeFileSync(join(cell, 'rows.jsonl'), '');
    rmSync(join(cell, 'fixer-worker.table.json'));
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'absence-only-test',
      jobId: 'provenance',
      result: { status: 'failed', error: cause },
    }) + '\n');
    setRecordedAbsences(cell, [{ case: 'provenance', cause }]);
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('checked 1 snapshot cells (0 file(s) changed)\n');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a stale table in an absence-only cell before accepting the no-row evidence', () => {
    const snapshotRoot = snapshotTempRoot('absence-only-stale-table-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'absence-only-stale-table-test');
    const cause = 'ai-sdk driver: [endpoint-timeout] run failed — synthetic infrastructure failure';
    writeFileSync(join(cell, 'rows.jsonl'), '');
    // Keep the now-stale populated table in place. The absence-only exception
    // applies only to cells whose table artifact is genuinely absent.
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'absence-only-stale-table-test',
      jobId: 'provenance',
      result: { status: 'failed', error: cause },
    }) + '\n');
    setRecordedAbsences(cell, [{ case: 'provenance', cause }]);
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'absence-only cell must not contain comparison table file(s) fixer-worker.table.json',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects an empty no-row cell when its failed journal job is not recorded in run.json absences', () => {
    const snapshotRoot = snapshotTempRoot('missing-absence-record-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'missing-absence-record-test');
    const cause = 'ai-sdk driver: [endpoint-timeout] run failed — synthetic infrastructure failure';
    writeFileSync(join(cell, 'rows.jsonl'), '');
    rmSync(join(cell, 'fixer-worker.table.json'));
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'missing-absence-record-test',
      jobId: 'provenance',
      result: { status: 'failed', error: cause },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `journal fixer no-row case provenance (${cause}) is not recorded in run.json absences`,
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('preserves a manifest-backed schema/identity-valid empty-suite table with empty rows', () => {
    const snapshotRoot = snapshotTempRoot('empty-suite-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'empty-suite-test');
    const suitePath = join(suiteDir, 'suite.json');
    const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as {
      name: string;
      role: string;
      cases: unknown[];
    };
    suite.cases = [];
    writeFileSync(suitePath, JSON.stringify(suite, null, 2) + '\n');
    writeFileSync(join(cell, 'rows.jsonl'), '');
    rmSync(join(cell, 'journal'), { recursive: true, force: true });
    const tablePath = join(cell, 'fixer-worker.table.json');
    const emptyTable = {
      role: suite.role,
      suite: suite.name,
      generatedAt: '2026-01-01T00:00:00.000Z',
      cells: [],
    };
    writeFileSync(tablePath, JSON.stringify(emptyTable, null, 2) + '\n');
    try {
      const valid = runReplay(snapshotRoot, true);
      expect(valid.status).toBe(0);
      expect(valid.stdout).toBe('checked 1 snapshot cells (0 file(s) changed)\n');

      const mismatched = { ...emptyTable, role: 'review-classifier' };
      writeFileSync(tablePath, JSON.stringify(mismatched, null, 2) + '\n');
      const identityFailure = runReplay(snapshotRoot, true);
      expect(identityFailure.status).toBe(1);
      expect(identityFailure.stderr).toContain(
        'empty-suite table identity review-classifier/regrade-provenance-test does not match manifest role/suite fixer-worker/regrade-provenance-test',
      );

      writeFileSync(
        tablePath,
        JSON.stringify({ ...emptyTable, unexpected: true }, null, 2) + '\n',
      );
      const schemaFailure = runReplay(snapshotRoot, true);
      expect(schemaFailure.status).toBe(1);
      expect(schemaFailure.stderr).toContain('empty-suite table fixer-worker.table.json failed schema validation');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails when a rows/manifest cell regrades to no table instead of passing a missing table check', () => {
    const snapshotRoot = snapshotTempRoot('missing-table-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'missing-table-test');
    writeFileSync(join(cell, 'rows.jsonl'), '');
    rmSync(join(cell, 'fixer-worker.table.json'));
    rmSync(join(cell, 'journal'), { recursive: true, force: true });
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'snapshot cell has rows.jsonl and run.json but regrade produced no table; refusing stale or missing table check',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects an extra stale table file in a snapshot cell', () => {
    const snapshotRoot = snapshotTempRoot('extra-table-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'extra-table-test');
    copyFileSync(
      join(cell, 'fixer-worker.table.json'),
      join(cell, 'stale-role.table.json'),
    );
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'unexpected table file(s) stale-role.table.json; only the manifest role table fixer-worker.table.json is expected',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails discovery when the snapshot contains zero cells', () => {
    const snapshotRoot = snapshotTempRoot('zero-test');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no snapshot cells found');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('validates an existing null/false classifier miss against structured-output-miss journal evidence', () => {
    const snapshotRoot = snapshotTempRoot('null-miss-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    const journal = join(cell, 'journal', 'events.ndjson');
    writeFileSync(journal, JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
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
        'case null-miss has no matching completed, failed, or governed journal event for manifest run regrade-null-miss-test',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(['endpoint-timeout', 'provider-error'])(
    'rejects a classifier row backed by a non-model [%s] journal failure',
    (failure) => {
      const snapshotRoot = snapshotTempRoot(`${failure}-row-test`);
      const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
      writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
        type: 'job-finished',
        runId: 'regrade-null-miss-test',
        jobId: 'null-miss',
        result: {
          status: 'failed',
          error: `ai-sdk driver: [${failure}] run failed — synthetic infrastructure failure`,
        },
      }) + '\n');
      try {
        const result = runReplay(snapshotRoot, true);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `case null-miss has a non-model classifier journal failure (ai-sdk driver: [${failure}] run failed — synthetic infrastructure failure) but a row was published`,
        );
        expect(result.stderr).not.toContain('journal structured-output-miss case');
      } finally {
        rmSync(snapshotRoot, { recursive: true, force: true });
        rmSync(suiteDir, { recursive: true, force: true });
      }
    }, 120_000,
  );

  it.each([
    { status: 'budget-exhausted', detail: undefined },
    { status: 'indeterminate', detail: 'driver stopReason: aborted' },
  ])('retains $status classifier governed-stop evidence and requires a zero row', ({ status, detail }) => {
    const snapshotRoot = snapshotTempRoot(`${status}-governed-test`);
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    delete row.probes;
    row.outcome = { score: 0, passed: 0, total: 1 };
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    const table = aggregate([row])[0]!;
    table.generatedAt = '2026-01-01T00:00:00.000Z';
    writeFileSync(join(cell, 'review-classifier.table.json'), JSON.stringify(table, null, 2) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: detail === undefined ? { status } : { status, detail },
    }) + '\n');
    try {
      const accepted = runReplay(snapshotRoot, true);
      expect(accepted.status).toBe(0);

      row.probes = [{ kind: 'expected-verdict', expected: 'resolved', observed: 'resolved', passed: true }];
      writeFileSync(rowsPath, JSON.stringify(row) + '\n');
      const probeTable = aggregate([row])[0]!;
      probeTable.generatedAt = '2026-01-01T00:00:00.000Z';
      writeFileSync(join(cell, 'review-classifier.table.json'), JSON.stringify(probeTable, null, 2) + '\n');
      const probeBearing = runReplay(snapshotRoot, true);
      expect(probeBearing.status).toBe(1);
      expect(probeBearing.stderr).toContain(
        'case null-miss has classifier governed-stop evidence but carries probes',
      );

      delete row.probes;
      row.outcome = { score: 1, passed: 1, total: 1 };
      writeFileSync(rowsPath, JSON.stringify(row) + '\n');
      const nonzeroTable = aggregate([row])[0]!;
      nonzeroTable.generatedAt = '2026-01-01T00:00:00.000Z';
      writeFileSync(join(cell, 'review-classifier.table.json'), JSON.stringify(nonzeroTable, null, 2) + '\n');
      const rejected = runReplay(snapshotRoot, true);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(
        'case null-miss has classifier governed-stop evidence but does not carry the required zero outcome',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a classifier row for a no-row infrastructure indeterminate detail', () => {
    const snapshotRoot = snapshotTempRoot('infrastructure-indeterminate-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'indeterminate', detail: 'fixture read failed for synthetic.json: ENOENT' },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case null-miss has infrastructure indeterminate journal detail (fixture read failed for synthetic.json: ENOENT) but a row was published',
      );

      writeFileSync(join(cell, 'rows.jsonl'), '');
      const noTable = runReplay(snapshotRoot, true);
      expect(noTable.status).toBe(1);
      expect(noTable.stderr).toContain(
        'journal classifier no-row case null-miss (fixture read failed for synthetic.json: ENOENT) is not recorded in run.json absences',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a completed fixer journal job absent from rows.jsonl', () => {
    const snapshotRoot = snapshotTempRoot('missing-completed-fixer-row-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'missing-completed-fixer-row-test');
    writeFileSync(join(cell, 'rows.jsonl'), '');
    mkdirSync(join(cell, 'journal'), { recursive: true });
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'missing-completed-fixer-row-test',
      jobId: 'provenance',
      result: { status: 'ok', value: { score: 1, passed: 2, total: 2 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('journal completed job case provenance is absent from rows.jsonl');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects fabricated billed and modeled cost labels during replay', () => {
    for (const [label, costBasis, expected] of [
      ['billed', 'billed', 'case provenance has invalid billed cost accounting: costUSD must be a finite non-negative number'],
      ['modeled', 'modeled', 'case provenance has invalid modeled cost accounting: costUSD must be a finite non-negative number'],
    ] as const) {
      const snapshotRoot = snapshotTempRoot(`fixer-${label}-cost-test`);
      const { cell, suiteDir } = fixerSnapshot(snapshotRoot, `fixer-${label}-cost-test`);
      const rowsPath = join(cell, 'rows.jsonl');
      const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
      row.costBasis = costBasis;
      writeFileSync(rowsPath, JSON.stringify(row) + '\n');
      writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
        type: 'job-finished',
        runId: `fixer-${label}-cost-test`,
        jobId: 'provenance',
        result: { status: 'ok', value: { score: 1, passed: 2, total: 2 } },
      }) + '\n');
      try {
        const result = runReplay(snapshotRoot, true);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expected);
      } finally {
        rmSync(snapshotRoot, { recursive: true, force: true });
        rmSync(suiteDir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('rejects classifier-only expected-verdict probes on a fixer row', () => {
    const snapshotRoot = snapshotTempRoot('fixer-classifier-probe-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'fixer-classifier-probe-test');
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    row.probes = [{ kind: 'expected-verdict', expected: 'resolved', observed: 'resolved', passed: true }];
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case provenance fixer row carries classifier-only expected-verdict probes',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a fixer row without matching journal evidence for the manifest run', () => {
    const snapshotRoot = snapshotTempRoot('fixer-missing-journal-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'fixer-missing-journal-test');
    rmSync(join(cell, 'journal'), { recursive: true, force: true });
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case provenance has no matching completed/ok, governed, or structured-output-miss journal event for manifest run fixer-missing-journal-test',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts a fixer structured-output-miss paired with the exact two-probe zero outcome', () => {
    const snapshotRoot = snapshotTempRoot('fixer-structured-miss-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'fixer-structured-miss-test');
    setFixerOutcome(cell, { score: 0, passed: 0, total: 2 });
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'fixer-structured-miss-test',
      jobId: 'provenance',
      result: {
        status: 'failed',
        error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
      },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('checked 1 snapshot cells (0 file(s) changed)\n');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    { label: 'a partial zero', outcome: { score: 0, passed: 0, total: 1 } },
    { label: 'a nonzero outcome', outcome: { score: 0.5, passed: 1, total: 2 } },
  ])('rejects a fixer structured-output-miss paired with $label', ({ outcome }) => {
    const snapshotRoot = snapshotTempRoot('fixer-structured-miss-wrong-outcome-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'fixer-structured-miss-wrong-outcome-test');
    setFixerOutcome(cell, outcome);
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'fixer-structured-miss-wrong-outcome-test',
      jobId: 'provenance',
      result: {
        status: 'failed',
        error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
      },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case provenance has journal structured-output-miss evidence but does not carry the required zero outcome',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a structured-output-miss fixer journal event absent from rows.jsonl', () => {
    const snapshotRoot = snapshotTempRoot('missing-fixer-miss-row-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'missing-fixer-miss-row-test');
    writeFileSync(join(cell, 'rows.jsonl'), '');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'missing-fixer-miss-row-test',
      jobId: 'provenance',
      result: {
        status: 'failed',
        error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
      },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('journal structured-output-miss case provenance is absent from rows.jsonl');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a fixer row whose completed journal outcome contradicts the row', () => {
    const snapshotRoot = snapshotTempRoot('fixer-completed-outcome-mismatch-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'fixer-completed-outcome-mismatch-test');
    setFixerOutcome(cell, { score: 0, passed: 0, total: 2 });
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case provenance outcome {"score":0,"passed":0,"total":2} contradicts completed journal outcome {"score":1,"passed":1,"total":1}',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a fixer row whose only journal event belongs to a different manifest run', () => {
    const snapshotRoot = snapshotTempRoot('fixer-other-run-journal-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'fixer-other-run-journal-test');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'different-run',
      jobId: 'provenance',
      result: { status: 'ok', value: { score: 1, passed: 1, total: 1 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case provenance has no matching completed/ok, governed, or structured-output-miss journal event for manifest run fixer-other-run-journal-test',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts a fixer row backed by a governed journal event only with the exact zero outcome', () => {
    const snapshotRoot = snapshotTempRoot('fixer-governed-test');
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, 'fixer-governed-test');
    setFixerOutcome(cell, { score: 0, passed: 0, total: 2 });
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'fixer-governed-test',
      jobId: 'provenance',
      result: { status: 'budget-exhausted' },
    }) + '\n');
    try {
      const accepted = runReplay(snapshotRoot, true);
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toBe('checked 1 snapshot cells (0 file(s) changed)\n');

      setFixerOutcome(cell, { score: 0.5, passed: 1, total: 2 });
      const rejected = runReplay(snapshotRoot, true);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(
        'case provenance has fixer governed-stop evidence but does not carry the required zero outcome',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    {
      label: 'failed',
      result: { status: 'failed', error: 'ai-sdk driver: [endpoint-timeout] run failed — synthetic infrastructure failure' },
      evidence: 'journal failure',
    },
    {
      label: 'indeterminate',
      result: { status: 'indeterminate', detail: 'fixture read failed for provenance.json: ENOENT' },
      evidence: 'journal detail',
    },
  ])('rejects a fixer row backed by a no-row infrastructure $label event', ({ result, evidence }) => {
    const snapshotRoot = snapshotTempRoot(`fixer-infrastructure-${result.status}-test`);
    const { cell, suiteDir } = fixerSnapshot(snapshotRoot, `fixer-infrastructure-${result.status}-test`);
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: `fixer-infrastructure-${result.status}-test`,
      jobId: 'provenance',
      result,
    }) + '\n');
    try {
      const replay = runReplay(snapshotRoot, true);
      expect(replay.status).toBe(1);
      expect(replay.stderr).toContain(`has a no-row infrastructure fixer ${evidence}`);
      expect(replay.stderr).toContain('but a row was published');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a classifier governed stop absent from rows.jsonl', () => {
    const snapshotRoot = snapshotTempRoot('missing-governed-row-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    writeFileSync(join(cell, 'rows.jsonl'), '');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'budget-exhausted' },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'journal classifier governed stop case null-miss (budget-exhausted) is absent from rows.jsonl',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a journal-recorded structured-output-miss absent from rows.jsonl', () => {
    const snapshotRoot = snapshotTempRoot('missing-miss-row-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    writeFileSync(join(cell, 'rows.jsonl'), '');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: {
        status: 'failed',
        error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
      },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('journal structured-output-miss case null-miss is absent from rows.jsonl');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts a future-honest null/false classifier row with an ok job result', () => {
    const snapshotRoot = snapshotTempRoot('future-honest-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    const journal = join(cell, 'journal', 'events.ndjson');
    writeFileSync(journal, JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'ok', value: { score: 0, passed: 0, total: 1 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('checked 1 snapshot cells (0 file(s) changed)\n');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    {
      label: 'a wrong expected verdict',
      mutate: (row: ResultRow) => {
        row.probes = [{ kind: 'expected-verdict', expected: 'actionable', observed: null, passed: false }];
      },
      message: 'does not carry the exact expected-verdict null/false probe',
    },
    {
      label: 'an extra probe',
      mutate: (row: ResultRow) => {
        row.probes = [
          { kind: 'expected-verdict', expected: 'resolved', observed: null, passed: false },
          { kind: 'expected-verdict', expected: 'skip', observed: 'skip', passed: true },
        ];
      },
      message: 'does not carry the exact expected-verdict null/false probe',
    },
    {
      label: 'a nonzero row outcome',
      mutate: (row: ResultRow) => {
        row.outcome = { score: 1, passed: 1, total: 1 };
      },
      message: 'does not carry the required zero outcome',
    },
  ])('rejects completed ok zero-result evidence paired with $label', ({ mutate, message }) => {
    const snapshotRoot = snapshotTempRoot('completed-zero-miss-shape-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    mutate(row);
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'ok', value: { score: 0, passed: 0, total: 1 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `case null-miss has matching completed zero-result evidence but ${message}`,
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    {
      label: 'structured-output-miss',
      journalEvent: {
        status: 'failed',
        error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
      },
    },
    {
      label: 'completed zero-result',
      journalEvent: { status: 'ok', value: { score: 0, passed: 0, total: 1 } },
    },
  ])('rejects a contradictory null/passed:true probe with $label evidence', ({ journalEvent }) => {
    const snapshotRoot = snapshotTempRoot('null-passed-true-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    row.probes = [{ kind: 'expected-verdict', expected: 'resolved', observed: null, passed: true }];
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: journalEvent,
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('case null-miss has a contradictory null/passed:true classifier probe');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts a normal real observed classifier probe with passing ok journal evidence', () => {
    const snapshotRoot = snapshotTempRoot('real-observed-ok-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    row.outcome = { score: 1, passed: 1, total: 1 };
    row.probes = [{ kind: 'expected-verdict', expected: 'resolved', observed: 'resolved', passed: true }];
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    const table = aggregate([row])[0]!;
    table.generatedAt = '2026-01-01T00:00:00.000Z';
    writeFileSync(join(cell, 'review-classifier.table.json'), JSON.stringify(table, null, 2) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'ok', value: { score: 1, passed: 1, total: 1 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('checked 1 snapshot cells (0 file(s) changed)\n');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    {
      label: 'no probes',
      probes: undefined,
      message: 'must carry exactly one expected-verdict probe',
    },
    {
      label: 'an empty probes array',
      probes: [],
      message: 'must carry exactly one expected-verdict probe',
    },
    {
      label: 'duplicate expected-verdict probes',
      probes: [
        { kind: 'expected-verdict', expected: 'resolved', observed: 'resolved', passed: true },
        { kind: 'expected-verdict', expected: 'resolved', observed: 'resolved', passed: true },
      ],
      message: 'must carry exactly one expected-verdict probe',
    },
    {
      label: 'passed:true for a mismatched observation',
      probes: [{ kind: 'expected-verdict', expected: 'resolved', observed: 'actionable', passed: true }],
      message: 'classifier probe passed=true contradicts observed=actionable expected=resolved',
    },
    {
      label: 'passed:false for a matching observation',
      probes: [{ kind: 'expected-verdict', expected: 'resolved', observed: 'resolved', passed: false }],
      message: 'classifier probe passed=false contradicts observed=resolved expected=resolved',
    },
  ])('rejects an ordinary completed classifier row with $label', ({ probes, message }) => {
    const snapshotRoot = snapshotTempRoot('ordinary-probe-shape-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    row.outcome = { score: 0, passed: 0, total: 1 };
    row.probes = probes;
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'ok', value: { score: 0, passed: 0, total: 1 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a real observed classifier probe with the wrong suite expectation', () => {
    const snapshotRoot = snapshotTempRoot('real-observed-expected-mismatch-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    row.outcome = { score: 1, passed: 1, total: 1 };
    row.probes = [{ kind: 'expected-verdict', expected: 'actionable', observed: 'resolved', passed: true }];
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'ok', value: { score: 1, passed: 1, total: 1 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case null-miss classifier probe expected actionable does not match suite expected resolved',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a real observed classifier probe whose passed flag contradicts the completed journal', () => {
    const snapshotRoot = snapshotTempRoot('real-observed-passed-mismatch-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    row.outcome = { score: 1, passed: 1, total: 1 };
    row.probes = [{ kind: 'expected-verdict', expected: 'resolved', observed: 'actionable', passed: false }];
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'ok', value: { score: 1, passed: 1, total: 1 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case null-miss classifier probe passed=false contradicts completed journal passed=1',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a real observed classifier row whose outcome contradicts the completed journal', () => {
    const snapshotRoot = snapshotTempRoot('real-observed-outcome-mismatch-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    row.outcome = { score: 0, passed: 0, total: 1 };
    row.probes = [{ kind: 'expected-verdict', expected: 'resolved', observed: 'resolved', passed: true }];
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'ok', value: { score: 1, passed: 1, total: 1 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case null-miss outcome {"score":0,"passed":0,"total":1} contradicts completed journal outcome {"score":1,"passed":1,"total":1}',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects an existing null/false classifier row backed only by a passing ok journal result', () => {
    const snapshotRoot = snapshotTempRoot('passing-ok-null-miss-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: { status: 'ok', value: { score: 1, passed: 1, total: 1 } },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case null-miss has a null/false classifier probe without journal structured-output-miss or matching completed zero-result evidence',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('repairs an undefined structured-output-miss probe before validating it', () => {
    const snapshotRoot = snapshotTempRoot('undefined-miss-shape-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    delete row.probes;
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: {
        status: 'failed',
        error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
      },
    }) + '\n');
    try {
      const applied = runReplay(snapshotRoot, false);
      expect(applied.status).toBe(0);
      const repaired = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
      expect(repaired.probes).toEqual([
        { kind: 'expected-verdict', expected: 'resolved', observed: null, passed: false },
      ]);
      const checked = runReplay(snapshotRoot, true);
      expect(checked.status).toBe(0);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    {
      label: 'an empty probes array',
      mutate: (row: ResultRow) => { row.probes = []; },
      message: 'does not carry the exact expected-verdict null/false probe',
    },
    {
      label: 'a wrong expected verdict',
      mutate: (row: ResultRow) => {
        row.probes = [{ kind: 'expected-verdict', expected: 'actionable', observed: null, passed: false }];
      },
      message: 'does not carry the exact expected-verdict null/false probe',
    },
    {
      label: 'a nonzero outcome',
      mutate: (row: ResultRow) => { row.outcome = { score: 1, passed: 1, total: 1 }; },
      message: 'does not carry the required zero outcome',
    },
  ])('rejects structured-output-miss evidence paired with $label', ({ mutate, message }) => {
    const snapshotRoot = snapshotTempRoot('invalid-miss-shape-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot);
    const rowsPath = join(cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    mutate(row);
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: {
        status: 'failed',
        error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
      },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`case null-miss has journal structured-output-miss evidence but ${message}`);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a structured-output-miss journal paired with real observed probes', () => {
    const snapshotRoot = snapshotTempRoot('real-observed-miss-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
    const journal = join(cell, 'journal', 'events.ndjson');
    writeFileSync(journal, JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-null-miss-test',
      jobId: 'null-miss',
      result: {
        status: 'failed',
        error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
      },
    }) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case null-miss has journal structured-output-miss evidence but carries real observed classifier probes',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a classifier row without matching journal evidence for the manifest run', () => {
    const snapshotRoot = snapshotTempRoot('mixed-run-journal-test');
    const { cell, suiteDir } = classifierMissSnapshot(snapshotRoot, 'resolved');
    writeFileSync(join(cell, 'journal', 'events.ndjson'), [
      {
        type: 'job-finished',
        runId: 'different-run',
        jobId: 'null-miss',
        result: {
          status: 'failed',
          error: 'ai-sdk driver: [structured-output-miss] run failed — No object generated',
        },
      },
      {
        type: 'job-finished',
        runId: 'regrade-null-miss-test',
        jobId: 'unrelated-case',
        result: { status: 'failed', error: 'unrelated failure' },
      },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case null-miss has no matching completed, failed, or governed journal event for manifest run regrade-null-miss-test',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails a null suiteSha replay without the explicit test-only switch', () => {
    const snapshotRoot = snapshotTempRoot('null-suite-sha-test');
    const { suiteDir } = fixerSnapshot(snapshotRoot, 'future-correctly-bound-run');
    try {
      const result = runReplay(snapshotRoot, true, { allowNullSuiteSha: false });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'run.json runs[0].suiteSha must be a non-empty git revision; null is allowed only for deterministic tests with CQ_REGRADE_ALLOW_NULL_SUITE_SHA=1',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('uses an available recorded revision, but warns and falls back to committed checkout files when it is unavailable', () => {
    const snapshotRoot = snapshotTempRoot('recorded-revision-test');
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
    writeFileSync(join(cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'job-finished',
      runId: 'recorded-revision-test',
      jobId: 'thread-01',
      result: { status: 'ok', value: { score: 1, passed: 1, total: 1 } },
    }) + '\n');

    try {
      const historicalRevisionAvailable = spawnSync(
        'git',
        ['cat-file', '-e', `${WB1_SUITE_SHA}^{commit}`],
        { cwd: REPO_ROOT },
      ).status === 0;
      const recorded = runReplay(snapshotRoot, true);
      expect(recorded.status).toBe(0);
      expect(recorded.stderr.includes('recorded suite revision')).toBe(!historicalRevisionAvailable);
      expect(recorded.stderr).toContain(
        "case thread-01: label sidecar 'fixtures/threads/thread-01.label.json' absent",
      );

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.runs[0].suiteSha = 'not-a-recorded-revision';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const unavailable = runReplay(snapshotRoot, true);
      expect(unavailable.status).toBe(0);
      expect(unavailable.stderr).toContain(
        'WARNING:',
      );
      expect(unavailable.stderr).toContain(
        'recorded suite revision not-a-recorded-revision is unavailable locally; using checked-out committed suite and sidecars for offline replay',
      );
      expect(unavailable.stderr).toContain(
        "case thread-01: label sidecar 'fixtures/threads/thread-01.label.json' absent",
      );

      manifest.runs[0].suiteDir = join(REPO_ROOT, 'suites/review-classifier/micro');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const absolute = runReplay(snapshotRoot, true, { allowAbsoluteSuite: false });
      expect(absolute.status).toBe(1);
      expect(absolute.stderr).toContain(
        "run.json runs[0].suiteDir must be a non-empty repo-relative path without '..'; absolute paths are allowed only for deterministic tests with CQ_REGRADE_ALLOW_TEST_ABSOLUTE_SUITE=1",
      );

      manifest.runs[0].suiteDir = '../outside';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const malformed = runReplay(snapshotRoot, true);
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain("run.json runs[0].suiteDir must be a non-empty repo-relative path without '..'");

      manifest.runs[0].suiteDir = 'suites/review-classifier/does-not-exist';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const missing = runReplay(snapshotRoot, true);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('checked-out suite fallback: git show HEAD:suites/review-classifier/does-not-exist/suite.json failed');
      expect(missing.stderr).toContain('does not exist');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('invalidates only the audited W0.9 fixer run identity, not a future fixer run', () => {
    const historicalRoot = snapshotTempRoot('w09-run-test');
    const futureRoot = snapshotTempRoot('future-run-test');
    const historical = fixerSnapshot(historicalRoot, W0_9_FIXER_RUN_ID);
    const future = fixerSnapshot(futureRoot, 'future-correctly-bound-run');
    const historicalRowsPath = join(historical.cell, 'rows.jsonl');
    const historicalRow = JSON.parse(readFileSync(historicalRowsPath, 'utf8'));
    historicalRow.invalid = 'workspace-unbound';
    writeFileSync(historicalRowsPath, JSON.stringify(historicalRow) + '\n');
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

  it('retains the audited W0.9 workspace-unbound no-journal exception', () => {
    const snapshotRoot = snapshotTempRoot('w09-no-journal-test');
    const snapshot = fixerSnapshot(snapshotRoot, W0_9_FIXER_RUN_ID);
    rmSync(join(snapshot.cell, 'journal'), { recursive: true, force: true });
    try {
      expect(runReplay(snapshotRoot, false).status).toBe(0);
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('checked 1 snapshot cells (0 file(s) changed)\n');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a mismatched row runId before the W0.9 invalid-marker allowlist', () => {
    const snapshotRoot = snapshotTempRoot('mismatched-run-id-test');
    const snapshot = fixerSnapshot(snapshotRoot, W0_9_FIXER_RUN_ID);
    try {
      expect(runReplay(snapshotRoot, false).status).toBe(0);

      const rowsPath = join(snapshot.cell, 'rows.jsonl');
      const row = JSON.parse(readFileSync(rowsPath, 'utf8'));
      row.runId = 'different-run';
      writeFileSync(rowsPath, JSON.stringify(row) + '\n');

      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case provenance row runId different-run does not match manifest entry runId 36088a47-2fd6-4323-8d14-57edfa47f3dc',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    { field: 'suite', suiteField: 'name', value: 'different-loaded-suite' },
    { field: 'role', suiteField: 'role', value: 'review-classifier' },
  ])('rejects loaded suite $field that does not match the manifest entry', ({ field, suiteField, value }) => {
    const snapshotRoot = snapshotTempRoot(`loaded-${field}-identity-test`);
    const snapshot = fixerSnapshot(snapshotRoot, 'future-correctly-bound-run');
    const suitePath = join(snapshot.suiteDir, 'suite.json');
    const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as Record<string, unknown>;
    suite[suiteField] = value;
    writeFileSync(suitePath, JSON.stringify(suite, null, 2) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `run.json runs[0].${field} ${field === 'suite' ? 'regrade-provenance-test' : 'fixer-worker'} does not match recorded suite ${field} ${value}`,
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    { field: 'role', value: 'review-classifier' },
    { field: 'suite', value: 'different-suite' },
    { field: 'driver', value: 'different-driver' },
    { field: 'variant', value: 'different-variant' },
  ])('rejects a row whose $field does not match the manifest entry', ({ field, value }) => {
    const snapshotRoot = snapshotTempRoot(`mismatched-${field}-test`);
    const snapshot = fixerSnapshot(snapshotRoot, 'future-correctly-bound-run');
    const rowsPath = join(snapshot.cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as Record<string, unknown>;
    row[field] = value;
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `case provenance row ${field} ${value} does not match manifest entry ${field} ${field === 'role' ? 'fixer-worker' : field === 'suite' ? 'regrade-provenance-test' : field === 'driver' ? 'ai-sdk' : 'default'}`,
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts an observed row model that differs from the manifest requested model', () => {
    const snapshotRoot = snapshotTempRoot('observed-model-test');
    const snapshot = fixerSnapshot(snapshotRoot, 'observed-model-run');
    const rowsPath = join(snapshot.cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    row.model = 'provider-observed-model';
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    try {
      expect(runReplay(snapshotRoot, false).status).toBe(0);
      expect(runReplay(snapshotRoot, true).status).toBe(0);
      const table = JSON.parse(readFileSync(join(snapshot.cell, 'fixer-worker.table.json'), 'utf8')) as { cells: Array<{ model: string }> };
      expect(table.cells[0]?.model).toBe('provider-observed-model');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects replayed token counters that differ from journal usage', () => {
    const snapshotRoot = snapshotTempRoot('usage-mismatch-test');
    const snapshot = fixerSnapshot(snapshotRoot, 'usage-mismatch-run');
    const rowsPath = join(snapshot.cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    row.tokens = { input: 10, output: 5, cacheRead: 3, cacheWrite: 0 };
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    writeFileSync(join(snapshot.cell, 'journal', 'events.ndjson'), [
      {
        type: 'job-finished',
        runId: 'usage-mismatch-run',
        jobId: row.case,
        result: { status: 'ok', value: row.outcome },
        usage: { input: 11, output: 5, cacheRead: 3, cacheWrite: 0 },
      },
      { type: 'run-finished', runId: 'usage-mismatch-run', stoppedEarly: false },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case provenance tokens {"input":10,"output":5,"cacheRead":3,"cacheWrite":0} do not match journal usage {"input":11,"output":5,"cacheRead":3,"cacheWrite":0}',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts a fully budget-stopped run with no rows when run-finished records the stop', () => {
    const snapshotRoot = snapshotTempRoot('fully-budget-stopped-test');
    const snapshot = fixerSnapshot(snapshotRoot, 'fully-budget-stopped-run');
    writeFileSync(join(snapshot.cell, 'rows.jsonl'), '');
    writeFileSync(join(snapshot.cell, 'journal', 'events.ndjson'), JSON.stringify({
      type: 'run-finished',
      runId: 'fully-budget-stopped-run',
      stoppedEarly: true,
      earlyStopReason: 'budget',
    }) + '\n');
    writeFileSync(join(snapshot.cell, 'fixer-worker.table.json'), JSON.stringify({
      role: 'fixer-worker',
      suite: 'regrade-provenance-test',
      generatedAt: '2026-01-01T00:00:00.000Z',
      cells: [],
    }, null, 2) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('checked 1 snapshot cells (0 file(s) changed)\n');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects missing case coverage when run-finished records a completed run', () => {
    const snapshotRoot = snapshotTempRoot('completed-coverage-test');
    const snapshot = fixerSnapshot(snapshotRoot, 'completed-coverage-run');
    const suitePath = join(snapshot.suiteDir, 'suite.json');
    const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as { cases: Array<Record<string, unknown>> };
    suite.cases.push({
      id: 'missing-case',
      fixture: join(snapshot.suiteDir, 'missing.json'),
      task: { prompt: 'fix' },
      probe: { kind: 'check-rerun', check: join(snapshot.suiteDir, 'check.mjs') },
    });
    writeFileSync(suitePath, JSON.stringify(suite, null, 2) + '\n');
    const journalPath = join(snapshot.cell, 'journal', 'events.ndjson');
    const events = readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    events.push({ type: 'run-finished', runId: 'completed-coverage-run', stoppedEarly: false });
    writeFileSync(journalPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('completed run is missing case missing-case coverage');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects duplicate case rows before aggregation', () => {
    const snapshotRoot = snapshotTempRoot('duplicate-case-test');
    const snapshot = fixerSnapshot(snapshotRoot, 'future-correctly-bound-run');
    const rowsPath = join(snapshot.cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8')) as ResultRow;
    writeFileSync(rowsPath, [row, row].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('duplicate case provenance row');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects an unaudited fixer row pre-marked workspace-unbound', () => {
    const snapshotRoot = snapshotTempRoot('unaudited-invalid-test');
    const snapshot = fixerSnapshot(snapshotRoot, 'unaudited-run');
    const rowsPath = join(snapshot.cell, 'rows.jsonl');
    const row = JSON.parse(readFileSync(rowsPath, 'utf8'));
    row.invalid = 'workspace-unbound';
    writeFileSync(rowsPath, JSON.stringify(row) + '\n');
    try {
      const result = runReplay(snapshotRoot, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'case provenance is pre-marked workspace-unbound, but manifest runId unaudited-run is not in the audited W0.9 allowlist',
      );
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
      rmSync(snapshot.suiteDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('preserves all five sidecar states and checks damaged states deterministically', () => {
    const suiteDir = suiteTempRoot('sidecar');
    const snapshotRoot = snapshotTempRoot('sidecar-test');
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
        fixture,
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
          suiteDir,
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
    writeFileSync(join(cell, 'journal', 'events.ndjson'), rows.map((row) => JSON.stringify({
      type: 'job-finished',
      runId: 'regrade-sidecar-test',
      jobId: row.case,
      result: { status: 'ok', value: row.outcome },
    })).join('\n') + '\n');

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
