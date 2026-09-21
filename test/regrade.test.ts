// F6 (WB-5.2b) regrade tests. Two acceptance properties:
//  - `regrade --from <out>` re-aggregates rows.jsonl BYTE-IDENTICALLY with the
//    table it replaces (the original generatedAt is preserved);
//  - `regrade --from <out> --rejudge` re-runs the LOCAL judge over the
//    persisted prediction (fixer patch applied to a pristine fixture; the
//    classifier structured output re-scored) and matches the recorded outcome.
// Hermetic: temp dirs only, no network, no toolkit driver construction.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aggregate, type ResultRow } from '../runner/aggregate.ts';
import { cliMain } from '../runner/cli.ts';
import { TRUNCATION_MARKER_PREFIX } from '../runner/persist.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-regrade-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A shared valid result row (classifier or fixer) with per-test overrides. */
function baseRow(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    role: 'review-classifier',
    suite: 'tiny-classifier',
    case: 'tiny-c1',
    model: 'glm-5.3-flash',
    driver: 'subprocess',
    outcome: { score: 1, passed: 1, total: 1 },
    costUSD: null,
    wallTimeMs: 100,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    runId: 'run-tiny',
    timestamp: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

function writeRowsJsonl(dir: string, rows: ResultRow[]): void {
  writeFileSync(join(dir, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('regrade --from re-aggregates byte-identically', () => {
  it('rewrites the table from rows.jsonl with the original generatedAt preserved', async () => {
    const outDir = join(root, 'out');
    mkdirSync(outDir, { recursive: true });
    const rows = [baseRow({ case: 'c1', outcome: { score: 1, passed: 1, total: 1 } }),
      baseRow({ case: 'c2', outcome: { score: 0, passed: 0, total: 1 } })];
    writeRowsJsonl(outDir, rows);
    // The table the run originally emitted, with a fixed generation stamp.
    const table = aggregate(rows)[0]!;
    table.generatedAt = '2026-09-18T20:46:13.925Z';
    const tablePath = join(outDir, 'review-classifier.table.json');
    const before = JSON.stringify(table, null, 2) + '\n';
    writeFileSync(tablePath, before);

    await expect(cliMain(['regrade', '--from', outDir])).resolves.toBe(0);
    expect(readFileSync(tablePath, 'utf8')).toBe(before);
  });

  it('exits 2 when the out dir has no rows.jsonl', async () => {
    const outDir = join(root, 'empty');
    mkdirSync(outDir, { recursive: true });
    await expect(cliMain(['regrade', '--from', outDir])).resolves.toBe(2);
  });

  it('exits 2 on a schema-invalid rows.jsonl (never re-aggregates garbage into an overwrite)', async () => {
    const outDir = join(root, 'bad-rows');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'rows.jsonl'), '{"role":"review-classifier"}\n');
    await expect(cliMain(['regrade', '--from', outDir])).resolves.toBe(2);
  });

  it('exits 2 on a missing --from', async () => {
    await expect(cliMain(['regrade'])).resolves.toBe(2);
  });
});

// --- rejudge: a tiny fixer suite / fixture built entirely under a temp repo root ---

const VALUE_PRISTINE = [
  'export const value = 0;',
  'export const other = 1;',
  'export const more = 2;',
  '',
].join('\n');

const VALUE_PATCH = [
  'diff --git a/src/value.ts b/src/value.ts',
  '--- a/src/value.ts',
  '+++ b/src/value.ts',
  '@@ -1,3 +1,3 @@',
  '-export const value = 0;',
  '+export const value = 1;',
  ' export const other = 1;',
  ' export const more = 2;',
  '',
].join('\n');

const CHECK_MJS = [
  "import { readFileSync } from 'node:fs';",
  "const src = readFileSync('src/value.ts', 'utf8');",
  "process.exit(src.includes('export const value = 1;') ? 0 : 1);",
  '',
].join('\n');

interface TinyRepo {
  repoRoot: string;
  outDir: string;
}

/** A temp repo root with a fixer suite whose check passes iff value === 1. */
function buildTinyFixerRepo(): TinyRepo {
  const repoRoot = join(root, 'repo');
  const fixture = join(repoRoot, 'fixtures', 'value-repo');
  mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(join(fixture, 'src', 'value.ts'), VALUE_PRISTINE);
  writeFileSync(join(fixture, 'check.mjs'), CHECK_MJS);
  const suiteDir = join(repoRoot, 'suites', 'fixer-worker', 'tiny');
  mkdirSync(suiteDir, { recursive: true });
  writeFileSync(
    join(suiteDir, 'suite.json'),
    JSON.stringify({
      name: 'tiny-fixer',
      role: 'fixer-worker',
      servedModel: 'glm-5.3-flash',
      provenance: { origin: 'hand-seeded' },
      cases: [{
        id: 'tiny-1',
        fixture: 'fixtures/value-repo',
        task: { prompt: 'make the check pass' },
        probe: { kind: 'check-rerun', check: 'fixtures/value-repo/check.mjs' },
      }],
    }, null, 2) + '\n',
  );
  const outDir = join(root, 'fixer-out');
  mkdirSync(join(outDir, 'patches'), { recursive: true });
  mkdirSync(join(outDir, 'outputs'), { recursive: true });
  writeFileSync(join(outDir, 'patches', 'tiny-1.patch'), VALUE_PATCH);
  writeFileSync(join(outDir, 'outputs', 'tiny-1.json'), JSON.stringify({ fixed: true, notes: 'set value to 1' }, null, 2) + '\n');
  writeFileSync(
    join(outDir, 'run.json'),
    JSON.stringify({
      runs: [{
        role: 'fixer-worker',
        suite: 'tiny-fixer',
        suiteDir: 'suites/fixer-worker/tiny',
        model: 'glm-5.3-flash',
        driver: 'subprocess',
        variant: 'default',
        toolkitLock: null,
        suiteSha: null,
        runId: 'run-tiny',
        generatedAt: '2026-09-18T00:00:00.000Z',
      }],
    }, null, 2) + '\n',
  );
  // The recorded (pre-rejudge) outcome: a fixer row carries TWO probes.
  writeRowsJsonl(outDir, [baseRow({
    role: 'fixer-worker',
    suite: 'tiny-fixer',
    case: 'tiny-1',
    outcome: { score: 1, passed: 2, total: 2 },
  })]);
  return { repoRoot, outDir };
}

describe('regrade --rejudge re-runs the local judge over persisted predictions', () => {
  it('a persisted fixer patch re-judged offline matches the recorded outcome', async () => {
    const { repoRoot, outDir } = buildTinyFixerRepo();
    await expect(
      cliMain(['regrade', '--from', outDir, '--rejudge', '--repo-root', repoRoot]),
    ).resolves.toBe(0);
    const rows = readFileSync(join(outDir, 'rows.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ResultRow);
    expect(rows[0]!.outcome).toEqual({ score: 1, passed: 2, total: 2 });
    const table = JSON.parse(readFileSync(join(outDir, 'fixer-worker.table.json'), 'utf8')) as { cells: Array<{ score: number; passed: number; total: number }> };
    expect(table.cells[0]).toMatchObject({ score: 1, passed: 2, total: 2 });
  });

  it('a persisted classifier output re-judged offline matches the expected verdict', async () => {
    const repoRoot = join(root, 'repo');
    const suiteDir = join(repoRoot, 'suites', 'review-classifier', 'tiny');
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(
      join(suiteDir, 'suite.json'),
      JSON.stringify({
        name: 'tiny-classifier',
        role: 'review-classifier',
        servedModel: 'glm-5.3-flash',
        provenance: { origin: 'hand-labeled' },
        cases: [{
          id: 'tiny-c1',
          fixture: 'fixtures/threads/thread-01.json',
          task: { prompt: 'classify the thread' },
          probe: { kind: 'expected-verdict', expected: 'resolved' },
        }],
      }, null, 2) + '\n',
    );
    const outDir = join(root, 'classifier-out');
    mkdirSync(join(outDir, 'outputs'), { recursive: true });
    writeFileSync(join(outDir, 'outputs', 'tiny-c1.json'), JSON.stringify({ verdict: 'resolved' }, null, 2) + '\n');
    writeFileSync(
      join(outDir, 'run.json'),
      JSON.stringify({
        runs: [{
          role: 'review-classifier',
          suite: 'tiny-classifier',
          suiteDir: 'suites/review-classifier/tiny',
          model: 'glm-5.3-flash',
          driver: 'subprocess',
          variant: 'default',
          toolkitLock: null,
          suiteSha: null,
          runId: 'run-tiny',
          generatedAt: '2026-09-18T00:00:00.000Z',
        }],
      }, null, 2) + '\n',
    );
    // Recorded as a MISS; the persisted output says resolved, so re-judge flips it.
    writeRowsJsonl(outDir, [baseRow({ outcome: { score: 0, passed: 0, total: 1 } })]);

    await expect(
      cliMain(['regrade', '--from', outDir, '--rejudge', '--repo-root', repoRoot]),
    ).resolves.toBe(0);
    const rows = readFileSync(join(outDir, 'rows.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ResultRow);
    expect(rows[0]!.outcome).toEqual({ score: 1, passed: 1, total: 1 });
    expect(rows[0]!.probes).toEqual([
      { kind: 'expected-verdict', expected: 'resolved', observed: 'resolved', passed: true },
    ]);
  });

  it('refuses a truncated patch and keeps the recorded outcome (with a diagnostic)', async () => {
    const { repoRoot, outDir } = buildTinyFixerRepo();
    // Recorded outcome is a MISS so a wrongly-applied patch would be visible.
    writeRowsJsonl(outDir, [baseRow({
      role: 'fixer-worker',
      suite: 'tiny-fixer',
      case: 'tiny-1',
      outcome: { score: 0, passed: 0, total: 2 },
    })]);
    writeFileSync(
      join(outDir, 'patches', 'tiny-1.patch'),
      `diff --git a/src/value.ts b/src/value.ts\n${TRUNCATION_MARKER_PREFIX} full 999999 bytes exceeds cap 262144\n`,
    );
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    try {
      await expect(
        cliMain(['regrade', '--from', outDir, '--rejudge', '--repo-root', repoRoot]),
      ).resolves.toBe(0);
    } finally {
      spy.mockRestore();
    }
    const rows = readFileSync(join(outDir, 'rows.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ResultRow);
    expect(rows[0]!.outcome).toEqual({ score: 0, passed: 0, total: 2 });
    expect(errors.join('\n')).toContain('truncated');
  });
});

// A regression tripwire for the acceptance: the committed 2026-09-18 snapshot's
// real rows must be present. (The byte-identical replay over the committed
// snapshot lives in test/snapshot-index.test.ts, where those rows land.)
describe('regrade acceptance data is present', () => {
  it('the committed 2026-09-18 snapshot carries the eight real rows.jsonl files', () => {
    const snapshot = fileURLToPath(new URL('../reports/snapshots/2026-09-18', import.meta.url));
    const found = (readdirSync(snapshot, { recursive: true }) as string[])
      .filter((f) => f.endsWith('rows.jsonl'));
    expect(found.length).toBe(8);
  });
});
