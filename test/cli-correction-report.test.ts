import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emitCorrectionReport } from '../runner/cli.ts';
import { canonicalRecordHash } from '../runner/reporting/corrections.ts';
import type { ComparisonTable, ResultRow } from '../runner/aggregate.ts';
import type { RunManifestEntry } from '../runner/persist.ts';

const dirs: string[] = [];
const RUN19 = 'cq-s5-final-20260929-19';
const AUTHORITY = 'cq-settings-execution-orchestrator';

function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cq-cli-correction-'));
  dirs.push(dir);
  return dir;
}

function runEntry(runId: string): RunManifestEntry {
  return {
    role: 'fixer-worker', suite: 'fixture-suite', suiteDir: 'suites/fixture', model: 'glm-5.3-flash',
    driver: 'ai-sdk', variant: 'default', toolkitLock: null, suiteSha: null, runId,
    generatedAt: '2026-09-30T00:00:00.000Z', expectedCases: 1,
  };
}

function table(rate: number): ComparisonTable {
  return {
    role: 'fixer-worker', suite: 'fixture-suite', generatedAt: '2026-09-30T00:00:00.000Z',
    cells: [{
      model: 'glm-5.3-flash', driver: 'ai-sdk', runs: 1, passed: 1, total: 1, costUSD: null,
      score: 1, wallTimeMs: 1, tokens: { input: 1, output: 1 }, operationalCompletionRate: rate,
    }],
  };
}

function config(out: string, manifestPath: string) {
  return {
    out,
    correctionReport: {
      manifestPath, corpusRoot: null, evidenceRoots: [], asOf: '2026-09-30T00:00:00.000Z',
      scopes: [{ entryId: 'run21-g1-contract-audit', route: 'test route', lane: 'development' as const }],
    },
  } as unknown as Parameters<typeof emitCorrectionReport>[0];
}

function run19Inputs(root: string): { manifestPath: string; originalBytes: Buffer } {
  const recordBytes = readFileSync(new URL('../runner/reporting/fixtures/run19-lifecycle-correction.fixture.json', import.meta.url));
  const record = JSON.parse(recordBytes.toString('utf8')) as Record<string, unknown>;
  const recordPath = join(root, 'record.json');
  writeFileSync(recordPath, recordBytes);
  const manifest = {
    schemaVersion: 1,
    approvedAuthorities: [AUTHORITY],
    entries: [{
      id: 'run19-lifecycle-correction', kind: 'append-only-lifecycle-correction', root: 'repo',
      path: 'record.json', sha256: digest(recordBytes), canonicalId: canonicalRecordHash(record as never),
      authorityId: AUTHORITY, recordedAt: null,
    }],
  };
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, originalBytes: recordBytes };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PK14 CLI correction-report seam', () => {
  it('keeps the historic run19 literal out of derived rates when source artifacts and rows are unavailable', async () => {
    const root = tempDir();
    const out = join(root, 'out');
    mkdirSync(out);
    const { manifestPath, originalBytes } = run19Inputs(root);
    const rowsPath = join(out, 'rows.jsonl');
    const tablePath = join(out, 'fixer-worker.table.json');
    const rowsBytes = Buffer.from('');
    const tableBytes = Buffer.from(`${JSON.stringify(table(1), null, 2)}\n`);
    writeFileSync(rowsPath, rowsBytes);
    writeFileSync(tablePath, tableBytes);
    const existingReport = Buffer.from('pre-existing correction report\n');
    writeFileSync(join(out, 'correction-report.json'), existingReport);

    await emitCorrectionReport(config(out, manifestPath), [] as ResultRow[], [table(1)], [runEntry(RUN19)], root);

    // The pre-existing exclusive output is preserved; inspect the rate gate
    // through its dedicated selector artifact and its exact raw inputs.
    expect(readFileSync(join(out, 'correction-report.json'))).toEqual(existingReport);
    const selection = JSON.parse(readFileSync(join(out, 'correction-rate-selection.json'), 'utf8'));
    expect(selection.runs[0].correctedCompletionRate).toBeNull();
    expect(selection.runs[0].status).toBe('withheld');
    expect(selection.runs[0].blockers.some((blocker: { reason: string }) => blocker.reason === 'corrected-rows-not-reaggregated')).toBe(true);
    expect(readFileSync(rowsPath)).toEqual(rowsBytes);
    expect(readFileSync(tablePath)).toEqual(tableBytes);
    expect(readFileSync(join(root, 'record.json'))).toEqual(originalBytes);
    expect(readFileSync(join(out, 'correction-input', `${RUN19}.original-projection.json`), 'utf8')).toContain('1');
  });

  it('withholds a numeric claim when the pinned record bytes are tampered', async () => {
    const root = tempDir();
    const out = join(root, 'out');
    mkdirSync(out);
    const { manifestPath } = run19Inputs(root);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.entries[0].sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const row: ResultRow = {
      role: 'fixer-worker', suite: 'fixture-suite', case: 'case-1', model: 'glm-5.3-flash', driver: 'ai-sdk',
      outcome: { score: 1, passed: 1, total: 1 }, costUSD: null, wallTimeMs: 1, tokens: { input: 1, output: 1 },
      runId: RUN19, timestamp: '2026-09-30T00:00:00.000Z',
      outcomes: { candidateCorrectness: true, formatConformance: true, assignedStrategySuccess: true, operationalStatus: 'complete' },
    };
    const rowsBytes = Buffer.from(`${JSON.stringify(row)}\n`);
    writeFileSync(join(out, 'rows.jsonl'), rowsBytes);

    await emitCorrectionReport(config(out, manifestPath), [row], [table(1)], [runEntry(RUN19)], root);

    const selection = JSON.parse(readFileSync(join(out, 'correction-rate-selection.json'), 'utf8'));
    expect(selection.pinnedOk).toBe(false);
    expect(selection.runs[0].correctedCompletionRate).toBeNull();
    expect(selection.runs[0].status).toBe('withheld');
    expect(selection.runs[0].blockers.some((blocker: { reason: string }) => blocker.reason === 'correction-pins-unverified')).toBe(true);
    expect(readFileSync(join(out, 'rows.jsonl'))).toEqual(rowsBytes);
  });
});
