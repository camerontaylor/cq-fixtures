// PK14 / D22 + D77 regression: correction-aware report selection, typed
// retention, and the correction-aware status view.
//
// These tests are DEVELOPMENT regressions for a source gap. They are not
// actual-route evidence, not factory/lifecycle evidence, and they satisfy no
// campaign acceptance criterion.
//
// The sidecar is now WIRED: `wires consumption into the other-owned
// entrypoints under the granted lease` below is the guard for that, and it
// asserts the shape of the wiring rather than the old absence of it.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ResultRow } from '../runner/aggregate.ts';
import {
  adaptCorrectionRecord,
  canonicalJson,
  canonicalRecordHash,
  checkOverrideAllowed,
  deriveLifecycleOverrides,
  LIFECYCLE_ADAPTER_VERSION,
  recomputeCompletionRate,
  selectCorrections,
  type CorrectionOverride,
  type CorrectionRecord,
} from '../runner/reporting/corrections.ts';
import { byteMapResolver, verifyArtifactBinding, verifyCorrectionBinding } from '../runner/reporting/correction-binding.ts';
import { projectRetention, retentionIsFullyAccountedFor } from '../runner/reporting/retention.ts';
import { projectStatusView, renderStatusLines, type DimensionClaim, type StatusViewInput } from '../runner/reporting/status-view.ts';
import { buildCorrectionAwareBoard, renderBoardMarkdown } from '../runner/reporting/board.ts';
import { approvedAuthorities, manifestEntry, verifyManifest, type CorrectionsManifest, type ManifestEntry } from '../runner/reporting/manifest.ts';
import {
  consumeRetention,
  consumeRunReport,
  loadPinnedCorrections,
  ROW_WRITABLE_CORRECTION_FIELDS,
  type CorrectableRow,
} from '../runner/reporting/consumer.ts';
import { PINNED_OPERATIONAL_STATUSES, PINNED_TERMINAL_CAUSES } from '../runner/reporting/vocabulary.ts';
import { createEvidenceResolver, createManifestResolver, produceCorrectionAwareReport } from '../runner/reporting/producer.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const AUTHORITY = 'cq-settings-execution-orchestrator';
const RUN19 = 'cq-s5-final-20260929-19';
const RUN18 = 'cq-s5-final-20260929-18';
const RUN21 = 'cq-s5-final-20260929-21';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Independently recorded hashes, from the register and the reconciliation handoff. */
const RECORDED_HASHES: Record<string, string> = {
  'run19-lifecycle-correction': 'fcba300db5030b958ba8b50321faf9d59ee6fe377127c76280058fc0d995bfb2',
  'run19-retention-binding': 'a0d30ab47dcc021a5f814da38a3571630975cc8b7c1fab0ed8277c88f9397855',
  'run18-retention-audit': '0dabb0f1069c644335a62454670105da611ea063edfb330ac9414c22b54ad023',
  'run21-g1-contract-audit': '40d6ea03550fe369dbf58551a924ee921121cfcdcf0b49d58ae0e2eefafbc5a6',
  'run21-retention-audit': '0af5311b0a7d5dff5792efe22a67b7735be7706192eb772361a6d24dd98034a3',
  'pi-timeout-g1-contract-audit': '4aab48b80383323dc4a2242d680ed83ebb05dd42e51544394c02920e5a73b93e',
  'pi-workspace-g1-contract-audit': '93a0f91cb89aa4230c351a14a12684c88e6d6e1c291560b98261a562e0d209a4',
};

const manifest = JSON.parse(repoFile('runner/reporting/corrections.manifest.json')) as CorrectionsManifest;

/** A legacy append-only correction document, shaped like the real run19 record. */
function legacyRun19Document(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'append-only-lifecycle-correction',
    runId: RUN19,
    invocationId: 'd9cd61ba-3ca3-478e-b275-fefca2a41e05',
    assignmentId: 'final-profile-g1-cq-s5-final-20260929-19',
    sourceEvidence: {
      reportSha256: '89995fb89746fb369da06ae6ae7c2e86e52c4078789484b44196f3ac285bc081',
      taskOutcomeSha256: '940a11868a8298dfba81885742538ab857745dcb9697bd6f2d6e591b748d5f3d',
      supervisorLifecycleSha256: 'c5e44c5db34f58caaff1126990dcf6758f04837c2a4d4ca5b513ed0ec85e759e',
    },
    authoritativeNativeTerminal: 'timeout',
    supersededLifecycleProjections: [
      'execution.terminalCause=complete',
      'operationalStatus=complete',
      'table.operationalCompletionRate=1',
    ],
    normalWorkerCompletion: false,
    processTreeStopped: true,
    boundaryTermination: 'proven',
    boundaryExport: 'proven',
    exportReceiptPresent: true,
    originalArtifactsChanged: false,
  };
}

function lifecycleRecord(options: {
  overrides: CorrectionOverride[];
  authorityId?: string;
  supersedes?: string[];
  canonicalId?: string;
  recordedAt?: string | null;
  runId?: string;
  sourceEvidence?: Record<string, { path: string; sha256: string }>;
} = { overrides: [] }): CorrectionRecord {
  const doc = {
    schemaVersion: 1,
    kind: 'append-only-lifecycle-correction',
    runId: options.runId ?? RUN19,
    assignmentId: 'final-profile-g1-cq-s5-final-20260929-19',
    invocationId: 'd9cd61ba-3ca3-478e-b275-fefca2a41e05',
    authorityId: options.authorityId ?? AUTHORITY,
    recordedAt: options.recordedAt ?? null,
    sourceEvidence: options.sourceEvidence ?? {},
    supersedes: options.supersedes ?? [],
    overrides: options.overrides,
  };
  const adapted = adaptCorrectionRecord(doc, {
    ...(options.canonicalId ? { canonicalId: options.canonicalId } : {}),
  });
  if (!adapted.record) throw new Error(`fixture record rejected: ${adapted.rejection?.reason} ${adapted.rejection?.detail ?? ''}`);
  return adapted.record;
}

const RUN19_ORIGINAL = {
  'execution.terminalCause': 'complete',
  'execution.authoritativeNativeTerminal': null,
  'operationalStatus': 'complete',
  'table.operationalCompletionRate': 1,
  'taskResult.candidateCorrectness': true,
  'taskResult.formatConformance': false,
  'taskResult.assignedStrategySuccess': true,
};

describe('D22: no correction leaves the original untouched', () => {
  it('returns status none, keeps every original value and annotates the origin', () => {
    const original = Object.freeze({ ...RUN19_ORIGINAL });
    const result = selectCorrections({
      runId: RUN19,
      original: { ...original },
      records: [],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.status).toBe('none');
    expect(result.projection['operationalStatus'].value).toBe('complete');
    expect(result.projection['operationalStatus'].origin).toBe('original');
    expect(result.projection['operationalStatus'].recordSha256).toBeNull();
    // An unknown field with no record at all is absent from the projection; it
    // is never invented as false.
    expect('table.neverRecorded' in result.projection).toBe(false);
  });

  it('never mutates the original object', () => {
    const original = { ...RUN19_ORIGINAL };
    const before = canonicalJson(original);
    const derived = deriveLifecycleOverrides(legacyRun19Document(), 'a'.repeat(64), {
      terminalCause: 'unknown',
      operationalStatus: 'interrupted',
      completionRows: [{ operationalStatus: 'interrupted' }],
    });
    selectCorrections({
      runId: RUN19,
      original,
      records: [lifecycleRecord({ overrides: derived.overrides })],
      approvedAuthorities: [AUTHORITY],
    });
    expect(canonicalJson(original)).toBe(before);
  });

  it('is deterministic: identical input yields byte-identical output', () => {
    const record = lifecycleRecord({ overrides: [{ field: 'operationalStatus', value: 'interrupted' }] });
    const run = (): string =>
      canonicalJson(
        selectCorrections({ runId: RUN19, original: RUN19_ORIGINAL, records: [record], approvedAuthorities: [AUTHORITY] }),
      );
    expect(run()).toBe(run());
  });
});

describe('D22: the run19 timeout correction is honored without touching correctness', () => {
  const document = legacyRun19Document();
  const derived = deriveLifecycleOverrides(document, RECORDED_HASHES['run19-lifecycle-correction'], {
    terminalCause: 'unknown',
    operationalStatus: 'interrupted',
    completionRows: [{ operationalStatus: 'interrupted' }],
  });
  const record = lifecycleRecord({ overrides: derived.overrides });

  it('derives overrides through a versioned adapter anchored to the original hash', () => {
    expect(derived.adapterVersion).toBe(LIFECYCLE_ADAPTER_VERSION);
    expect(derived.originalRecordSha256).toBe(RECORDED_HASHES['run19-lifecycle-correction']);
    expect(derived.unmapped).toEqual([]);
  });

  it('preserves the authoritative terminal verbatim beside the schema-mapped value', () => {
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [record],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.status).toBe('selected');
    // 'timeout' is not in the pinned terminalCause enum, so the row value is
    // 'unknown' and the authoritative string is kept rather than invented away.
    expect(result.projection['execution.authoritativeNativeTerminal'].value).toBe('timeout');
    expect(result.projection['execution.terminalCause'].value).toBe('unknown');
    expect(result.projection['operationalStatus'].value).toBe('interrupted');
    expect(result.projection['normalWorkerCompletion'].value).toBe(false);
  });

  it('keeps correctness, format conformance and strategy success separate from completion', () => {
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [record],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.projection['taskResult.candidateCorrectness']).toEqual({
      origin: 'original',
      value: true,
      recordSha256: null,
      recordedAt: null,
    });
    expect(result.projection['taskResult.formatConformance'].value).toBe(false);
    expect(result.projection['taskResult.assignedStrategySuccess'].value).toBe(true);
  });

  it('recomputes the table rate instead of keeping the historic literal 1', () => {
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [record],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.projection['table.operationalCompletionRate'].value).toBe(0);
    expect(recomputeCompletionRate([{ operationalStatus: 'interrupted' }, { operationalStatus: 'complete' }])).toBe(0.5);
    expect(recomputeCompletionRate([])).toBe(0);
  });

  it('declines to emit a rate when no corrected rows are supplied', () => {
    const withoutRows = deriveLifecycleOverrides(document, 'a'.repeat(64), {
      terminalCause: 'unknown',
      operationalStatus: 'interrupted',
    });
    expect(withoutRows.unmapped.map((u) => u.field)).toEqual(['table.operationalCompletionRate']);
    expect(withoutRows.overrides.some((o) => o.field === 'table.operationalCompletionRate')).toBe(false);
  });

  it('rejects an attempt to overwrite judged correctness', () => {
    const problem = checkOverrideAllowed(record, { field: 'taskResult.candidateCorrectness', value: false });
    expect(problem?.reason).toBe('protected-correctness-field');
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [lifecycleRecord({ overrides: [{ field: 'taskResult.candidateCorrectness', value: false }] })],
      approvedAuthorities: [AUTHORITY],
    });
    // The claim is withheld, not applied and not silently reverted.
    expect(result.status).toBe('unresolved');
    expect(result.projection['taskResult.candidateCorrectness']).toBeUndefined();
    expect(result.withheld[0].reason).toBe('protected-correctness-field');
  });

  it('rejects a correction that asserts normal completion', () => {
    for (const field of ['execution.terminalCause', 'operationalStatus', 'normalWorkerCompletion']) {
      const value = field === 'normalWorkerCompletion' ? true : 'complete';
      expect(checkOverrideAllowed(record, { field, value })?.reason).toBe('completion-claim-not-retractable');
    }
  });

  it('rejects a field outside the lifecycle allowlist', () => {
    expect(checkOverrideAllowed(record, { field: 'judgement.candidatePatchSha256', value: 'x' })?.reason).toBe(
      'protected-correctness-field',
    );
    expect(checkOverrideAllowed(record, { field: 'table.someOtherRate', value: 1 })?.reason).toBe('disallowed-field');
  });
});

describe('D22: fail-closed selection', () => {
  it('withholds the claim when the authority is not approved', () => {
    const record = lifecycleRecord({ overrides: [{ field: 'operationalStatus', value: 'interrupted' }], authorityId: 'someone-else' });
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [record],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.status).toBe('unresolved');
    expect(result.withheld[0].reason).toBe('authority-unapproved');
    // A retracted favourable original is never used as the fallback.
    expect(result.projection['operationalStatus']).toBeUndefined();
  });

  it('withholds the claim when an artifact hash mismatches', () => {
    const record = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'interrupted' }],
      sourceEvidence: { reportSha256: { path: 'report.json', sha256: 'b'.repeat(64) } },
    });
    const binding = verifyCorrectionBinding(record, byteMapResolver({ 'report.json': 'different bytes' }));
    expect(binding.status).toBe('mismatch');
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [record],
      approvedAuthorities: [AUTHORITY],
      bindingStatus: () => binding.disposition,
    });
    expect(result.status).toBe('unresolved');
    expect(result.withheld[0].reason).toBe('artifact-binding-mismatch');
    expect(result.projection['operationalStatus']).toBeUndefined();
  });

  it('treats an unresolvable artifact as unresolved, never as agreement or absence', () => {
    const record = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'interrupted' }],
      sourceEvidence: { reportSha256: { path: 'report.json', sha256: 'b'.repeat(64) } },
    });
    const binding = verifyCorrectionBinding(record, byteMapResolver({}));
    expect(binding.status).toBe('unresolved');
    expect(binding.artifacts[0].status).toBe('unresolvable');
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [record],
      approvedAuthorities: [AUTHORITY],
      bindingStatus: () => binding.disposition,
    });
    expect(result.withheld[0].reason).toBe('artifact-binding-unresolved');
    expect(result.projection['operationalStatus']).toBeUndefined();
  });

  it('verifies a binding whose bytes match', () => {
    const bytes = 'the original report';
    const record = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'interrupted' }],
      sourceEvidence: { reportSha256: { path: 'report.json', sha256: sha256(bytes) } },
    });
    const binding = verifyCorrectionBinding(record, byteMapResolver({ 'report.json': bytes }));
    expect(binding.status).toBe('verified');
    expect(binding.artifacts[0].observedSha256).toBe(sha256(bytes));
  });

  it('reports a throwing resolver as unresolvable rather than crashing', () => {
    const record = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'interrupted' }],
      sourceEvidence: { reportSha256: { path: 'report.json', sha256: 'b'.repeat(64) } },
    });
    const verdict = verifyCorrectionBinding(record, () => {
      throw new Error('permission denied');
    });
    expect(verdict.status).toBe('unresolved');
    expect(verdict.artifacts[0].detail).toContain('permission denied');
  });

  it('resolves a successor by explicit supersession, not by recency', () => {
    const first = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'interrupted' }],
      canonicalId: 'a'.repeat(64),
      recordedAt: '2026-09-29T10:00:00Z',
    });
    const second = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'judge-failure' }],
      canonicalId: 'c'.repeat(64),
      supersedes: ['a'.repeat(64)],
      // Older timestamp, later record: recency is not authority.
      recordedAt: '2026-09-29T09:00:00Z',
    });
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [first, second],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.status).toBe('selected');
    expect(result.projection['operationalStatus'].value).toBe('judge-failure');
    expect(result.projection['operationalStatus'].recordSha256).toBe('c'.repeat(64));
    expect(result.provenance.find((p) => p.recordSha256 === 'a'.repeat(64))?.disposition.reason).toBe('superseded-by-successor');
  });

  it('fails closed on two competing successors that supersede neither other', () => {
    const left = lifecycleRecord({ overrides: [{ field: 'operationalStatus', value: 'interrupted' }], canonicalId: 'a'.repeat(64) });
    const right = lifecycleRecord({ overrides: [{ field: 'operationalStatus', value: 'judge-failure' }], canonicalId: 'b'.repeat(64) });
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [left, right],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.status).toBe('conflict');
    expect(result.projection['operationalStatus']).toBeUndefined();
    expect(result.withheld.every((w) => w.reason === 'conflicting-successors')).toBe(true);
  });

  it('fails closed on a supersession cycle', () => {
    const a = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'interrupted' }],
      canonicalId: 'a'.repeat(64),
      supersedes: ['b'.repeat(64)],
    });
    const b = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'judge-failure' }],
      canonicalId: 'b'.repeat(64),
      supersedes: ['a'.repeat(64)],
    });
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [a, b],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.status).toBe('conflict');
    expect(result.withheld[0].reason).toBe('supersession-cycle');
  });

  it('does not let timestamps break a substantive conflict', () => {
    const newer = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'interrupted' }],
      canonicalId: 'a'.repeat(64),
      recordedAt: '2026-09-29T23:59:59Z',
    });
    const older = lifecycleRecord({
      overrides: [{ field: 'operationalStatus', value: 'judge-failure' }],
      canonicalId: 'b'.repeat(64),
      recordedAt: '2026-09-29T00:00:00Z',
    });
    expect(
      selectCorrections({ runId: RUN19, original: RUN19_ORIGINAL, records: [older, newer], approvedAuthorities: [AUTHORITY] }).status,
    ).toBe('conflict');
  });

  it('treats the same canonical record supplied twice as one record', () => {
    const record = lifecycleRecord({ overrides: [{ field: 'operationalStatus', value: 'interrupted' }] });
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [record, record],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.status).toBe('selected');
    expect(result.projection['operationalStatus'].value).toBe('interrupted');
  });

  it('ignores a correction scoped to another run', () => {
    const record = lifecycleRecord({ overrides: [{ field: 'operationalStatus', value: 'interrupted' }], runId: RUN21 });
    const result = selectCorrections({
      runId: RUN19,
      original: RUN19_ORIGINAL,
      records: [record],
      approvedAuthorities: [AUTHORITY],
    });
    expect(result.status).toBe('none');
    expect(result.provenance[0].disposition.reason).toBe('scope-mismatch');
  });

  it('rejects a record whose declared identity does not match its content', () => {
    const adapted = adaptCorrectionRecord(
      { ...legacyRun19Document(), authorityId: AUTHORITY, recordSha256: 'd'.repeat(64), overrides: [] },
    );
    expect(adapted.record).toBeNull();
    expect(adapted.rejection?.reason).toBe('artifact-binding-mismatch');
  });

  it('rejects an unknown kind, an unknown schema version and a missing authority', () => {
    expect(adaptCorrectionRecord({ schemaVersion: 1, kind: 'mystery', runId: RUN19 }).rejection?.reason).toBe('scope-mismatch');
    expect(adaptCorrectionRecord({ schemaVersion: 2, kind: 'retention-binding', runId: RUN19, authorityId: AUTHORITY }).rejection?.reason).toBe('scope-mismatch');
    expect(adaptCorrectionRecord({ schemaVersion: 1, kind: 'retention-binding', runId: RUN19 }).rejection?.reason).toBe('authority-unapproved');
  });

  it('never synthesizes a timestamp for a legacy record', () => {
    const record = lifecycleRecord({ overrides: [{ field: 'operationalStatus', value: 'interrupted' }] });
    expect(record.recordedAt).toBeNull();
    const result = selectCorrections({ runId: RUN19, original: RUN19_ORIGINAL, records: [record], approvedAuthorities: [AUTHORITY] });
    expect(result.projection['operationalStatus'].recordedAt).toBeNull();
  });

  it('rejects a non-RFC3339 recordedAt', () => {
    expect(
      adaptCorrectionRecord({ schemaVersion: 1, kind: 'retention-binding', runId: RUN19, authorityId: AUTHORITY, recordedAt: 'yesterday' })
        .rejection?.reason,
    ).toBe('scope-mismatch');
  });

  it('derives identity from content, so key order does not change it', () => {
    const a = canonicalRecordHash({ b: 1, a: 2 });
    const b = canonicalRecordHash({ a: 2, b: 1 });
    expect(a).toBe(b);
  });
});

describe('D22: typed retention separates patch, auth and the lost full candidate', () => {
  const run18Bytes = repoFile('runner/boundary/evidence/fallback/run18-retention-audit.public.json');
  const run18 = JSON.parse(run18Bytes) as Record<string, unknown>;
  const ref = { path: 'runner/boundary/evidence/fallback/run18-retention-audit.public.json', sha256: sha256(run18Bytes) };

  it('matches the in-repo audit to its pinned hash', () => {
    expect(ref.sha256).toBe(RECORDED_HASHES['run18-retention-audit']);
    expect(manifestEntry(manifest, 'run18-retention-audit')?.sha256).toBe(ref.sha256);
  });

  it('reports the run18 full candidate as absent and never reconstructs it', () => {
    const view = projectRetention({ runId: RUN18, record: run18, recordRef: ref });
    expect(view.resources.fullCandidate.state).toBe('absent');
    expect(view.resources.fullCandidate.reason).toContain('fullCandidateAvailable=false');
  });

  it('reports the surviving patch as retained and the surviving judgement as not the candidate', () => {
    const view = projectRetention({ runId: RUN18, record: run18, recordRef: ref });
    expect(view.resources.patch.state).toBe('retained');
    expect(view.resources.fullCandidate.state).toBe('absent');
    expect(JSON.stringify(run18)).toBe(JSON.stringify(JSON.parse(run18Bytes)));
  });

  it('leaves auth recovery unknown for run18 rather than inheriting the candidate state', () => {
    const view = projectRetention({ runId: RUN18, record: run18, recordRef: ref });
    expect(view.resources.auth.state).toBe('unknown');
    expect(view.resources.auth.reason).toContain('auth');
    expect(retentionIsFullyAccountedFor(view)).toBe(false);
  });

  it('states task/context volumes and published host separately', () => {
    const view = projectRetention({ runId: RUN18, record: run18, recordRef: ref });
    expect(view.resources.taskVolume.state).toBe('absent');
    expect(view.resources.contextVolume.state).toBe('absent');
    expect(view.resources.publishedHost.state).toBe('absent');
  });

  it('keeps the historical conflated field as a note, not as a resource state', () => {
    const view = projectRetention({
      runId: RUN19,
      record: { runtimeRecoveryRetained: true, authRecoveryPresent: true, fullCandidateAvailable: true, hostWorkspacePresent: false },
      recordRef: { path: 'evidence/run19-retention-binding.json', sha256: RECORDED_HASHES['run19-retention-binding'] },
    });
    expect(view.conflatedField).toEqual({ field: 'runtimeRecoveryRetained', value: true });
    // The conflated true does not make the published host retained.
    expect(view.resources.publishedHost.state).toBe('absent');
    expect(view.resources.auth.state).toBe('retained');
    expect(view.resources.fullCandidate.state).toBe('retained');
  });

  it('reads the per-volume inventory rather than a coarse boolean', () => {
    const view = projectRetention({
      runId: RUN19,
      record: {
        recoveryVolumesOwnedAndUnattached: true,
        volumes: [
          { kind: 'task', ownershipVerified: true },
          { kind: 'context', ownershipVerified: false },
        ],
      },
      recordRef: { path: 'evidence/run19-retention-binding.json', sha256: RECORDED_HASHES['run19-retention-binding'] },
    });
    expect(view.resources.taskVolume.state).toBe('retained');
    expect(view.resources.contextVolume.state).toBe('unknown');
  });

  it('returns unknown, not absent, for a record that states nothing', () => {
    const view = projectRetention({ runId: RUN19, record: {}, recordRef: { path: 'empty.json', sha256: 'e'.repeat(64) } });
    for (const state of Object.values(view.resources)) expect(state.state).toBe('unknown');
  });
});

describe('D77: the status view is a projection of cited records, not prose', () => {
  const run21Ref = { path: 'evidence/run21-g1-contract-audit.json', sha256: RECORDED_HASHES['run21-g1-contract-audit'] };
  const piTimeoutRef = { path: 'evidence/pi-timeout-g1-contract-audit.json', sha256: RECORDED_HASHES['pi-timeout-g1-contract-audit'] };
  const piWorkspaceRef = { path: 'evidence/pi-workspace-g1-contract-audit.json', sha256: RECORDED_HASHES['pi-workspace-g1-contract-audit'] };

  const claim = (dimension: DimensionClaim['dimension'], value: boolean | null, record: { path: string; sha256: string }): DimensionClaim => ({
    dimension,
    value,
    record,
    recordedAt: null,
  });

  const statusInput = (): StatusViewInput => ({
    asOf: '2026-09-29T12:00:00Z',
    routes: [
      {
        route: 'codex-gpt-6-sol',
        lane: 'actual',
        claims: [
          claim('codeFixed', true, run21Ref),
          claim('developmentTested', true, run21Ref),
          // The run21 audit itself records g2Qualified:false, so the route is not qualified.
          claim('actualRouteQualified', false, run21Ref),
        ],
      },
      {
        route: 'pi-space-bunny',
        lane: 'actual',
        claims: [
          claim('actualRouteQualified', true, piTimeoutRef),
          claim('developmentTested', true, piWorkspaceRef),
        ],
      },
      {
        route: 'pk14-development-lane',
        lane: 'development',
        claims: [claim('actualRouteQualified', true, piWorkspaceRef)],
      },
    ],
  });

  it('keeps the four dimensions separate per route', () => {
    const view = projectStatusView(statusInput());
    const codex = view.routes[0];
    expect(codex.dimensions.codeFixed.value).toBe(true);
    expect(codex.dimensions.actualRouteQualified.value).toBe(false);
    expect(codex.dimensions.campaignComplete.value).toBeNull();
    expect(codex.dimensions.campaignComplete.reason).toContain('no cited record');
  });

  it('does not let a scoped route pass imply campaign completion', () => {
    const view = projectStatusView(statusInput());
    expect(view.campaignComplete.value).toBeNull();
    expect(view.campaignComplete.reason).toContain('route passes do not imply campaign completion');
  });

  it('refuses a campaign-complete claim that conflicts with an unqualified route', () => {
    const view = projectStatusView({
      ...statusInput(),
      campaign: claim('campaignComplete', true, run21Ref),
    });
    expect(view.campaignComplete.value).toBeNull();
    expect(view.campaignComplete.reason).toContain('conflicts with unqualified routes');
  });

  it('never qualifies an actual route from a development lane', () => {
    const view = projectStatusView(statusInput());
    const development = view.routes[2];
    expect(development.dimensions.actualRouteQualified.value).toBeNull();
    expect(development.dimensions.actualRouteQualified.reason).toContain('development lane');
  });

  it('resolves disagreeing records to unknown instead of preferring the newer one', () => {
    const view = projectStatusView({
      asOf: '2026-09-29T12:00:00Z',
      routes: [
        {
          route: 'codex-gpt-6-sol',
          lane: 'actual',
          claims: [
            { dimension: 'actualRouteQualified', value: false, record: run21Ref, recordedAt: '2026-09-29T09:00:00Z' },
            { dimension: 'actualRouteQualified', value: true, record: piWorkspaceRef, recordedAt: '2026-09-29T11:00:00Z' },
          ],
        },
      ],
    });
    const state = view.routes[0].dimensions.actualRouteQualified;
    expect(state.value).toBeNull();
    expect(state.reason).toContain('disagree');
    expect(state.evidence).toHaveLength(2);
  });

  it('lists every unknown dimension with a reason', () => {
    const view = projectStatusView(statusInput());
    expect(view.unresolved.length).toBeGreaterThan(0);
    expect(view.unresolved.every((u) => u.reason.length > 0)).toBe(true);
  });

  it('renders unknown and no differently', () => {
    const lines = renderStatusLines(projectStatusView(statusInput()));
    const codex = lines.find((l) => l.startsWith('codex-gpt-6-sol')) as string;
    expect(codex).toContain('actualRouteQualified=no');
    expect(codex).toContain('campaignComplete=unknown');
  });

  it('ignores a campaign claim supplied for the wrong dimension', () => {
    const view = projectStatusView({ ...statusInput(), campaign: claim('actualRouteQualified', true, run21Ref) });
    expect(view.campaignComplete.value).toBeNull();
    expect(view.campaignComplete.reason).toContain('not campaignComplete');
  });
});

describe('D77: the board is reproducible and separates the four states', () => {
  const run21Ref = { path: 'evidence/run21-g1-contract-audit.json', sha256: RECORDED_HASHES['run21-g1-contract-audit'] };
  const statusInput: StatusViewInput = {
    asOf: '2026-09-29T12:00:00Z',
    routes: [
      {
        route: 'codex-gpt-6-sol',
        lane: 'actual',
        claims: [
          { dimension: 'codeFixed', value: true, record: run21Ref, recordedAt: '2026-09-29T10:30:00Z' },
          { dimension: 'actualRouteQualified', value: false, record: run21Ref, recordedAt: '2026-09-29T10:30:00Z' },
        ],
      },
      { route: 'glm', lane: 'actual', claims: [] },
    ],
  };

  it('derives generatedAt from the newest cited record, not a clock', () => {
    const board = buildCorrectionAwareBoard({ asOf: '2026-09-29T12:00:00Z', status: statusInput });
    expect(board.generatedAt).toBe('2026-09-29T10:30:00Z');
    expect(board.generatedAtIsAsOfFallback).toBe(false);
  });

  it('flags the as-of fallback when no record carries a timestamp', () => {
    const board = buildCorrectionAwareBoard({
      asOf: '2026-09-29T12:00:00Z',
      status: { ...statusInput, routes: [{ route: 'glm', lane: 'actual', claims: [] }] },
    });
    expect(board.generatedAt).toBe('2026-09-29T12:00:00Z');
    expect(board.generatedAtIsAsOfFallback).toBe(true);
  });

  it('separates fixed, development-tested, route-qualified and campaign-complete rows', () => {
    const board = buildCorrectionAwareBoard({ asOf: '2026-09-29T12:00:00Z', status: statusInput });
    const byDimension = Object.fromEntries(board.dimensions.map((d) => [d.dimension, d]));
    expect(byDimension.codeFixed.yes).toEqual(['codex-gpt-6-sol']);
    expect(byDimension.actualRouteQualified.no).toEqual(['codex-gpt-6-sol']);
    expect(byDimension.actualRouteQualified.unknown.map((u) => u.route)).toEqual(['glm']);
    expect(byDimension.campaignComplete.unknown.map((u) => u.route)).toEqual(['campaign']);
    // false and unknown are never merged into one bucket.
    expect(byDimension.actualRouteQualified.no).not.toContain('glm');
  });

  it('renders retention unknown as unknown, never as 0 or no', () => {
    const run18Bytes = repoFile('runner/boundary/evidence/fallback/run18-retention-audit.public.json');
    const board = buildCorrectionAwareBoard({
      asOf: '2026-09-29T12:00:00Z',
      status: statusInput,
      retention: [
        projectRetention({
          runId: RUN18,
          record: JSON.parse(run18Bytes),
          recordRef: { path: 'runner/boundary/evidence/fallback/run18-retention-audit.public.json', sha256: sha256(run18Bytes) },
        }),
      ],
    });
    expect(board.retention[0].resources).toMatchObject({ patch: 'retained', auth: 'unknown', fullCandidate: 'absent' });
    expect(board.retention[0].unaccounted).toEqual(['auth']);
    const markdown = renderBoardMarkdown(board);
    expect(markdown).toContain('fullCandidate=absent');
    expect(markdown).toContain('unaccounted (unknown, not zero): auth');
  });

  it('is byte-identical across runs over the same evidence', () => {
    const first = renderBoardMarkdown(buildCorrectionAwareBoard({ asOf: '2026-09-29T12:00:00Z', status: statusInput }));
    const second = renderBoardMarkdown(buildCorrectionAwareBoard({ asOf: '2026-09-29T12:00:00Z', status: statusInput }));
    expect(first).toBe(second);
  });
});

describe('pinned manifest and vocabulary', () => {
  it('pins every record to its independently recorded hash', () => {
    for (const [id, expected] of Object.entries(RECORDED_HASHES)) {
      const entry = manifestEntry(manifest, id);
      expect(entry, `manifest is missing ${id}`).not.toBeNull();
      expect(entry?.sha256).toBe(expected);
      expect(entry?.recordedAt).toBeNull();
    }
  });

  it('approves exactly one authority', () => {
    expect(approvedAuthorities(manifest)).toEqual([AUTHORITY]);
  });

  it('marks a record that was not supplied as unresolvable, not verified', () => {
    const verification = verifyManifest(manifest, () => null);
    expect(verification.ok).toBe(false);
    expect(verification.unverified.every((e) => e.status === 'unresolvable')).toBe(true);
  });

  it('detects byte drift and identity drift separately', () => {
    const entry = manifestEntry(manifest, 'run18-retention-audit')!;
    const bytes = repoFile(entry.path);
    // Byte drift: the same meaning, different bytes.
    const byteDrift = verifyManifest(manifest, () => (entry.id === 'run18-retention-audit' ? `${bytes} ` : null));
    expect(byteDrift.unverified.find((e) => e.id === entry.id)?.status).toBe('byte-mismatch');
    // Identity drift: bytes match their pin, but the pinned canonical identity
    // is wrong. Only reachable by a wrong pin, which is exactly what this
    // guards against silently changing a record's identity in the graph.
    const wrongIdentity: CorrectionsManifest = {
      ...manifest,
      entries: manifest.entries.map((e) => (e.id === entry.id ? { ...e, canonicalId: 'f'.repeat(64) } : e)),
    };
    const identityDrift = verifyManifest(wrongIdentity, () => (entry.id === 'run18-retention-audit' ? bytes : null));
    const drifted = identityDrift.entries.find((e) => e.id === entry.id);
    expect(drifted?.status).toBe('canonical-mismatch');
    expect(drifted?.observedCanonicalId).toBe(entry.canonicalId);
    expect(identityDrift.ok).toBe(false);
  });

  it('keeps the pinned outcome vocabulary equal to the PK03-owned schema', () => {
    const schema = JSON.parse(repoFile('schema/result-row.schema.json')) as {
      properties: {
        outcomes: { properties: { operationalStatus: { enum: string[] } } };
        taskOutcome: { properties: { execution: { properties: { terminalCause: { enum: string[] } } } } };
      };
    };
    expect(PINNED_TERMINAL_CAUSES).toEqual(schema.properties.taskOutcome.properties.execution.properties.terminalCause.enum);
    expect(PINNED_OPERATIONAL_STATUSES).toEqual(schema.properties.outcomes.properties.operationalStatus.enum);
  });

  it('wires consumption into the other-owned entrypoints under the granted lease', () => {
    // SEAM-1 is granted: the runner entrypoint and the aggregate lane now
    // consume the sidecar, so the old "not wired anywhere" assertion no longer
    // describes reality. It is replaced by a statement of HOW it is wired, so
    // a silent unwiring is still a test failure.
    for (const owned of ['runner/index.ts', 'runner/aggregate.ts']) {
      expect(repoFile(owned)).toContain('reporting/');
    }
    // The seam is re-exported from the PUBLIC entrypoint, not merely imported,
    // so a consumer can reach it without importing sidecar internals.
    expect(repoFile('runner/index.ts')).toMatch(/export\s*\{[^}]*consumeRunReport/s);
    expect(repoFile('runner/index.ts')).toMatch(/export\s*\{[^}]*aggregateCorrected/s);
    // And the sidecar still does not reach INTO PK02-owned modules: the
    // dependency runs one way, so the sidecar stays a pure sidecar.
    for (const file of ['index.ts', 'consumer.ts', 'corrections.ts', 'retention.ts', 'status-view.ts', 'board.ts', 'manifest.ts']) {
      const source = repoFile(`runner/reporting/${file}`);
      expect(source).not.toContain("../aggregate.ts");
      expect(source).not.toContain("../index.ts");
    }
  });

  it('leaves the PK03-owned public schemas untouched', () => {
    // SEAM-2 is NOT granted. Consumption reaches a report through derived rows
    // and through the returned correction state, never through a new
    // schema-owned column. If a future packet widens these files, this fails.
    for (const schema of ['schema/result-row.schema.json', 'schema/comparison-table.schema.json']) {
      const text = repoFile(schema);
      expect(text).not.toContain('correction');
      expect(text).not.toContain('retention');
      expect(text).not.toContain('recordSha256');
    }
  });
});

describe('artifact binding primitives', () => {
  it('reports a matching artifact as verified and a differing one as a mismatch', () => {
    const binding = { path: 'a.json', sha256: sha256('bytes') };
    expect(verifyArtifactBinding('a', binding, byteMapResolver({ 'a.json': 'bytes' })).status).toBe('verified');
    expect(verifyArtifactBinding('a', binding, byteMapResolver({ 'a.json': 'other' })).status).toBe('mismatch');
  });

  it('verifies vacuously and says so for a record with no named artifacts', () => {
    const verdict = verifyCorrectionBinding(lifecycleRecord({ overrides: [] }), byteMapResolver({}));
    expect(verdict.status).toBe('verified');
    expect(verdict.artifacts).toEqual([]);
  });
});

// ===========================================================================
// D22: the CONSUMER. Selection unit tests above prove which record speaks;
// these prove what a REPORT may then say, and what it must not.
// ===========================================================================

const FIXTURE_RUN19 = 'runner/reporting/fixtures/run19-lifecycle-correction.fixture.json';

/** The checked-in fixture must be byte-identical to the pinned corpus record. */
describe('D22: the in-repo fixture is the pinned record, byte for byte', () => {
  it('hashes to the manifest pin, so the fixture is not a second source of truth', () => {
    const pinnedEntry = manifestEntry(manifest, 'run19-lifecycle-correction')!;
    expect(sha256(repoFile(FIXTURE_RUN19))).toBe(pinnedEntry.sha256);
    expect(RECORDED_HASHES['run19-lifecycle-correction']).toBe(pinnedEntry.sha256);
  });

  it('resolves the in-repo run18 retention audit against its own pin', () => {
    const entry = manifestEntry(manifest, 'run18-retention-audit')!;
    expect(entry.root).toBe('repo');
    const verification = verifyManifest(manifest, (candidate) => (candidate.id === 'run18-retention-audit' ? repoFile(candidate.path) : null));
    const check = verification.entries.find((e) => e.id === 'run18-retention-audit')!;
    expect(check.status).toBe('verified');
  });

  it('fails closed on every corpus-rooted record when the corpus is not supplied', () => {
    // The research corpus is not part of this checkout. Not having a record is
    // UNRESOLVED, never "verified" and never "does not exist".
    const verification = verifyManifest(manifest, () => null);
    expect(verification.ok).toBe(false);
    for (const check of verification.unverified) {
      expect(check.status).toBe('unresolvable');
      expect(check.detail).toMatch(/unresolved, not absent/);
    }
  });
});

describe('D22: fail-closed loading of pinned records', () => {
  const realManifest = manifest;

  it('loads the run19 lifecycle record and declares its versioned adapter', () => {
    const pinned = loadPinnedCorrections(realManifest, (entry) => (entry.path.endsWith('run19-lifecycle-correction.json') ? repoFile(FIXTURE_RUN19) : null), {
      mapping: { terminalCause: 'unknown', operationalStatus: 'interrupted' },
    });
    const loaded = pinned.records.find((r) => r.entry.id === 'run19-lifecycle-correction')!;
    expect(loaded.record).not.toBeNull();
    expect(loaded.derivation!.adapterVersion).toBe(LIFECYCLE_ADAPTER_VERSION);
    // The adapter is anchored to the ORIGINAL BYTE hash it read.
    expect(loaded.derivation!.originalRecordSha256).toBe(loaded.entry.sha256);
    // A legacy record carries no timestamp, and none is invented.
    expect(loaded.record!.recordedAt).toBeNull();
  });

  it('refuses an adapter mapping outside the pinned vocabulary', () => {
    const pinned = loadPinnedCorrections(realManifest, (entry) => (entry.path.endsWith('run19-lifecycle-correction.json') ? repoFile(FIXTURE_RUN19) : null), {
      mapping: { terminalCause: 'timeout', operationalStatus: 'interrupted' },
    });
    const loaded = pinned.records.find((r) => r.entry.id === 'run19-lifecycle-correction');
    // 'timeout' is the AUTHORITATIVE string, not a schema terminalCause. The
    // sidecar keeps it verbatim and refuses to invent a lifecycle label for it.
    expect(loaded).toBeUndefined();
    expect(pinned.failures.some((f) => f.entryId === 'run19-lifecycle-correction' && /pinned execution.terminalCause vocabulary/.test(f.disposition.detail ?? ''))).toBe(true);
  });

  it('refuses an adapter that would assert normal completion', () => {
    const pinned = loadPinnedCorrections(realManifest, (entry) => (entry.path.endsWith('run19-lifecycle-correction.json') ? repoFile(FIXTURE_RUN19) : null), {
      mapping: { terminalCause: 'unknown', operationalStatus: 'complete' },
    });
    expect(pinned.records.find((r) => r.entry.id === 'run19-lifecycle-correction')).toBeUndefined();
    expect(pinned.failures.some((f) => f.disposition.reason === 'completion-claim-not-retractable')).toBe(true);
  });

  it('classifies a legacy retention record by its PIN, since its bytes declare no kind', () => {
    const bytes = repoFile('runner/boundary/evidence/fallback/run18-retention-audit.public.json');
    const doc = JSON.parse(bytes) as Record<string, unknown>;
    expect(doc.kind).toBeUndefined();
    const single: CorrectionsManifest = {
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [{
        id: 'run18', kind: 'retention-binding', root: 'repo', path: 'x.json',
        sha256: sha256(bytes), canonicalId: canonicalRecordHash(doc), authorityId: AUTHORITY, recordedAt: null,
      }],
    };
    const pinned = loadPinnedCorrections(single, () => bytes);
    expect(pinned.ok).toBe(true);
    const loaded = pinned.records[0]!;
    // An evidence record is READ, not overridden: it gets no typed record.
    expect(loaded.record).toBeNull();
    expect(loaded.document.runId).toBe(RUN18);
  });

  it('rejects a record whose declared kind disagrees with its pin', () => {
    const bytes = repoFile(FIXTURE_RUN19);
    const doc = JSON.parse(bytes) as Record<string, unknown>;
    const lying: CorrectionsManifest = {
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [{
        id: 'run19', kind: 'retention-binding', root: 'repo', path: 'x.json',
        sha256: sha256(bytes), canonicalId: canonicalRecordHash(doc), authorityId: AUTHORITY, recordedAt: null,
      }],
    };
    const pinned = loadPinnedCorrections(lying, () => bytes);
    expect(pinned.ok).toBe(false);
    expect(pinned.failures[0]!.disposition.reason).toBe('artifact-binding-mismatch');
  });
});

describe('D22: what the consumer may publish', () => {
  /** The real run19 correction, with an evidence resolver the test controls. */
  function run19Consumer(resolveEvidence: (binding: { path: string }) => string | null) {
    const bytes = repoFile(FIXTURE_RUN19);
    const doc = JSON.parse(bytes) as Record<string, unknown>;
    const single: CorrectionsManifest = {
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [{
        id: 'run19', kind: 'append-only-lifecycle-correction', root: 'repo', path: 'x.json',
        sha256: sha256(bytes), canonicalId: canonicalRecordHash(doc), authorityId: AUTHORITY, recordedAt: null,
      }],
    };
    const pinned = loadPinnedCorrections(single, () => bytes, {
      mapping: { terminalCause: 'unknown', operationalStatus: 'interrupted' },
    });
    return { pinned, report: consumeRunReport<CorrectableRow>({
      runId: RUN19,
      rows: [{
        runId: RUN19,
        outcomes: { operationalStatus: 'complete', candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: true },
        taskOutcome: { operationalStatus: 'complete', execution: { terminalCause: 'complete' } },
      }],
      original: { 'execution.terminalCause': 'complete', operationalStatus: 'complete', 'table.operationalCompletionRate': 1 },
      corrections: pinned,
      resolveEvidence,
    }) };
  }

  it('never republishes the retracted completion rate of 1 when artifacts are unresolvable', () => {
    // The run19 record names six private native artifacts that were never
    // exported, so no consumer in this checkout can re-hash them.
    const { report } = run19Consumer(() => null);
    expect(report.state.applied).toBe(false);
    expect(report.state.completionRateWithheld).toBe(true);
    expect(report.state.correctedCompletionRate).toBeNull();
    expect(report.state.historicCompletionRate).toBe(1);
    // The rows are untouched: nothing qualified, so nothing is asserted.
    expect(report.correctedRows[0]!.outcomes!.operationalStatus).toBe('complete');
    expect(JSON.stringify(report.rawRows)).toBe(JSON.stringify(report.correctedRows));
  });

  it('reports the authoritative terminal verbatim beside the mapped value', () => {
    const { report } = run19Consumer(() => null);
    const annotation = report.state.annotations.find((a) => a.field === 'execution.authoritativeNativeTerminal');
    // Withheld here (artifacts unresolvable), so it must NOT be projected as
    // a value; the selection projection is what carries the origin.
    expect(annotation).toBeUndefined();
    expect(report.state.withheld.map((w) => w.field)).toContain('execution.authoritativeNativeTerminal');
  });

  it('keeps an unverified pin out of the record set entirely', () => {
    const bytes = repoFile(FIXTURE_RUN19);
    const doc = JSON.parse(bytes) as Record<string, unknown>;
    const single: CorrectionsManifest = {
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [{
        id: 'run19', kind: 'append-only-lifecycle-correction', root: 'repo', path: 'x.json',
        sha256: sha256(bytes), canonicalId: canonicalRecordHash(doc), authorityId: AUTHORITY, recordedAt: null,
      }],
    };
    // Identity drift: the bytes are right, the pinned canonicalId is not.
    const drifted: CorrectionsManifest = { ...single, entries: [{ ...single.entries[0]!, canonicalId: 'a'.repeat(64) }] };
    const pinned = loadPinnedCorrections(drifted, () => bytes, { mapping: { terminalCause: 'unknown', operationalStatus: 'interrupted' } });
    expect(pinned.ok).toBe(false);
    expect(pinned.records).toHaveLength(0);
    expect(pinned.failures[0]!.disposition.reason).toBe('artifact-binding-mismatch');
  });

  it('treats an unapproved authority as unresolved rather than selecting', () => {
    const bytes = repoFile(FIXTURE_RUN19);
    const doc = JSON.parse(bytes) as Record<string, unknown>;
    const single: CorrectionsManifest = {
      schemaVersion: 1,
      // An authority that is NOT the manifest-approved one.
      approvedAuthorities: ['someone-else'],
      entries: [{
        id: 'run19', kind: 'append-only-lifecycle-correction', root: 'repo', path: 'x.json',
        sha256: sha256(bytes), canonicalId: canonicalRecordHash(doc), authorityId: AUTHORITY, recordedAt: null,
      }],
    };
    const pinned = loadPinnedCorrections(single, () => bytes, { mapping: { terminalCause: 'unknown', operationalStatus: 'interrupted' } });
    const report = consumeRunReport<CorrectableRow>({
      runId: RUN19,
      rows: [{ runId: RUN19, outcomes: { operationalStatus: 'complete' } }],
      original: { 'table.operationalCompletionRate': 1 },
      corrections: pinned,
      resolveEvidence: () => null,
    });
    expect(report.state.applied).toBe(false);
    expect(report.state.withheld.length).toBeGreaterThan(0);
  });
});

describe('D22: retention consumption reconciles by evidence, never by recency', () => {
  function retentionCase(state: 'absent' | 'retained') {
    const doc = { runId: RUN18, fullCandidateAvailable: state === 'absent' ? false : true };
    const bytes = JSON.stringify(doc);
    const single: CorrectionsManifest = {
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [{
        id: `r-${state}`, kind: 'retention-binding', root: 'repo', path: `r-${state}.json`,
        sha256: sha256(bytes), canonicalId: canonicalRecordHash(doc), authorityId: AUTHORITY, recordedAt: null,
      }],
    };
    return { single, state, resolve: (() => bytes) as (entry: ManifestEntry) => string };
  }

  it('returns null for a run no pinned record covers', () => {
    const { single, resolve } = retentionCase('absent');
    const pinned = loadPinnedCorrections(single, resolve);
    expect(consumeRetention({ runId: RUN21, corrections: pinned }).view).toBeNull();
  });

  it('fails closed to null when two records contradict each other', () => {
    const absent = retentionCase('absent');
    const retained = retentionCase('retained');
    const merged: CorrectionsManifest = { ...absent.single, entries: [...absent.single.entries, ...retained.single.entries] };
    const bytesById: Record<string, string> = {
      'r-absent': JSON.stringify({ runId: RUN18, fullCandidateAvailable: false }),
      'r-retained': JSON.stringify({ runId: RUN18, fullCandidateAvailable: true }),
    };
    const pinned = loadPinnedCorrections(merged, (entry) => bytesById[entry.id] ?? null);
    const consumed = consumeRetention({ runId: RUN18, corrections: pinned });
    // retained vs absent is a real contradiction. The consumer does not pick a
    // winner by timestamp; the resource goes to unknown and the view is null.
    expect(consumed.view).toBeNull();
    expect(consumed.blockers.map((b) => b.reason)).toContain('conflicting-successors');
  });

  it('merges a downgrade to unknown without inventing a conflict', () => {
    const bytesA = JSON.stringify({ runId: RUN18, fullCandidateAvailable: true });
    const bytesB = JSON.stringify({ runId: RUN18 });
    const docA = JSON.parse(bytesA) as Record<string, unknown>;
    const docB = JSON.parse(bytesB) as Record<string, unknown>;
    const merged: CorrectionsManifest = {
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [
        { id: 'a', kind: 'retention-binding', root: 'repo', path: 'a.json', sha256: sha256(bytesA), canonicalId: canonicalRecordHash(docA), authorityId: AUTHORITY, recordedAt: null },
        { id: 'b', kind: 'retention-binding', root: 'repo', path: 'b.json', sha256: sha256(bytesB), canonicalId: canonicalRecordHash(docB), authorityId: AUTHORITY, recordedAt: null },
      ],
    };
    const pinned = loadPinnedCorrections(merged, (entry) => (entry.id === 'a' ? bytesA : bytesB));
    const consumed = consumeRetention({ runId: RUN18, corrections: pinned });
    expect(consumed.view).not.toBeNull();
    // A silent second record does not retract the first, and does not conflict.
    expect(consumed.view!.resources.fullCandidate.state).toBe('retained');
  });
});

// ===========================================================================
// D22 + D77: the PRODUCER path.
//
// Everything above exercises a projection function in process. These tests
// exercise the PRODUCER: the non-test functions that read a pinned manifest
// from DISK, re-verify every pin against real bytes, resolve the artifacts a
// correction names from a real evidence directory, consume a run's report,
// re-aggregate the derived rows through the unchanged aggregate lane, and write
// their output exclusively.
//
// They are DEVELOPMENT regressions for the consumption seam. They are not
// actual-route evidence, not factory/lifecycle evidence, and they satisfy no
// campaign acceptance criterion. In particular nothing here makes run19's six
// private native artifacts available, and nothing here upgrades the historic
// literal completion rate of 1 to a corrected claim.
// ===========================================================================

/** A fresh, empty producer workspace: a corpus root, an evidence dir, an out. */
function producerWorkspace(): { corpus: string; evidence: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'cq-pk14-producer-'));
  const corpus = join(root, 'corpus');
  const evidence = join(root, 'private-native-artifacts');
  const out = join(root, 'out');
  mkdirSync(join(corpus, 'evidence'), { recursive: true });
  mkdirSync(evidence, { recursive: true });
  return { corpus, evidence, out };
}

const REPORT_ARTIFACT = 'private native report bytes\n';
const OUTCOME_ARTIFACT = 'private native task outcome bytes\n';

/**
 * A lifecycle correction in the same legacy shape as the real run19 record:
 * bare-hash `sourceEvidence`, and a set of superseded lifecycle projections
 * that name exactly the D22 problem — a `complete` terminal cause, a `complete`
 * operational status and a table rate of 1.
 */
function producerRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'append-only-lifecycle-correction',
    runId: RUN19,
    assignmentId: 'final-profile-g1-cq-s5-final-20260929-19',
    invocationId: 'd9cd61ba-3ca3-478e-b275-fefca2a41e05',
    sourceEvidence: { reportSha256: sha256(REPORT_ARTIFACT), taskOutcomeSha256: sha256(OUTCOME_ARTIFACT) },
    authoritativeNativeTerminal: 'timeout',
    supersededLifecycleProjections: ['execution.terminalCause=complete', 'operationalStatus=complete', 'table.operationalCompletionRate=1'],
    normalWorkerCompletion: false,
    processTreeStopped: true,
    boundaryTermination: 'proven',
    boundaryExport: 'proven',
    candidateCorrectness: true,
    formatConformance: false,
    assignedStrategySuccess: true,
  };
}

/** The immutable original rows.jsonl a producing run reads. Campaign rows. */
function producerRows(): string {
  const row = {
    role: 'fixer-worker', suite: 'fixer-worker', case: 'case-1', model: 'luna-subscription', driver: 'codex-exec',
    outcome: { score: 0.5, passed: 1, total: 2 }, costUSD: null, wallTimeMs: 1000,
    tokens: { input: 100, output: 10 },
    runId: RUN19, timestamp: '2026-09-29T00:00:00.000Z',
    experiment: {
      campaignId: 'cq', cohortId: 's5', experimentId: RUN19, taskId: 'task-1', repeatId: '0',
      assignmentId: 'final-profile-g1-cq-s5-final-20260929-19', stageId: 'final', attemptId: '1',
      track: 'default', strategyId: 's', settingsId: 'set', budgetId: 'b', profileId: 'p', frozenWeight: 1,
      substrateId: 'sub', judgePin: 'pin',
    },
    outcomes: { candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: true, operationalStatus: 'complete' },
    taskOutcome: {
      identity: {
        campaignId: 'cq', cohortId: 's5', experimentId: RUN19, taskId: 'task-1', substrateId: 'sub', track: 'default',
        repeatId: '0', assignmentId: 'final-profile-g1-cq-s5-final-20260929-19', strategyId: 's', role: 'fixer-worker',
        budgetId: 'b', frozenWeight: 1, judgeManifest: { sourcePin: 'pin', dependencies: [] },
      },
      candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: true, operationalStatus: 'complete',
      execution: { launched: true, terminalCause: 'complete', sourceInvocationIds: ['d9cd61ba-3ca3-478e-b275-fefca2a41e05'] },
      stages: [], judgements: [],
    },
  } as unknown as ResultRow;
  return `${JSON.stringify(row)}\n`;
}

/** The immutable original published projection, verbatim. Rate 1, as recorded. */
const HISTORIC_PROJECTION = `${JSON.stringify({
  'execution.terminalCause': 'complete',
  'operationalStatus': 'complete',
  'table.operationalCompletionRate': 1,
}, null, 2)}\n`;

/**
 * A workspace with a real manifest, a real record, real private evidence and
 * real original rows/projection on disk — everything the producer needs, and
 * nothing that could be satisfied by an in-memory stand-in.
 */
function seededProducer(dir: { corpus: string; evidence: string; out: string }): {
  corpus: string; evidence: string; out: string; manifestPath: string;
  rowsPath: string; projectionPath: string; rowsBytes: string; projectionBytes: string;
} {
  const record = producerRecord();
  const recordBytes = JSON.stringify(record, null, 2);
  writeFileSync(join(dir.corpus, 'evidence/run19-lifecycle-correction.json'), recordBytes);
  writeFileSync(join(dir.evidence, 'reportSha256'), REPORT_ARTIFACT);
  writeFileSync(join(dir.evidence, 'taskOutcomeSha256'), OUTCOME_ARTIFACT);

  const manifest = {
    schemaVersion: 1,
    approvedAuthorities: [AUTHORITY],
    entries: [{
      id: 'run19-lifecycle-correction', kind: 'append-only-lifecycle-correction', root: 'corpus' as const,
      path: 'evidence/run19-lifecycle-correction.json',
      sha256: sha256(recordBytes), canonicalId: canonicalRecordHash(record), authorityId: AUTHORITY, recordedAt: null,
    }],
  };
  const manifestPath = join(dir.corpus, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const rowsPath = join(dir.corpus, 'rows.jsonl');
  const rowsBytes = producerRows();
  writeFileSync(rowsPath, rowsBytes);
  const projectionPath = join(dir.corpus, 'original-projection.json');
  writeFileSync(projectionPath, HISTORIC_PROJECTION);

  return { ...dir, manifestPath, rowsPath, projectionPath, rowsBytes, projectionBytes: HISTORIC_PROJECTION };
}

describe('D22: the producer reads and re-verifies the real pinned manifest', () => {
  const REAL_MANIFEST = join(REPO_ROOT, 'runner/reporting/corrections.manifest.json');

  it('verifies the repo-rooted pin against real bytes and fails the corpus closed', () => {
    // The corpus was NOT supplied, so every corpus-rooted record is
    // `unresolvable`. That is reported, never read as agreement — and the
    // repo-rooted run18 audit, which really is in this checkout, verifies.
    const report = produceCorrectionAwareReport({
      manifestPath: REAL_MANIFEST,
      repoRoot: REPO_ROOT,
      corpusRoot: null,
      runs: [{ runId: RUN19 }, { runId: RUN18 }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
    });

    expect(report.manifest.verified).toContain('run18-retention-audit');
    const unverified = report.manifest.unverified.map((entry) => entry.id);
    expect(unverified).toContain('run19-lifecycle-correction');
    for (const entry of report.manifest.unverified) expect(entry.status).toBe('unresolvable');
    expect(report.pinnedOk).toBe(false);

    // run19 is therefore NOT publishable, and its claims are withheld rather
    // than asserted. Withheld is null, not 0 and not 1.
    const run19 = report.runs.find((run) => run.runId === RUN19)!;
    expect(run19.publishable).toBe(false);
    expect(run19.rateClaim.value).toBeNull();
    expect(run19.rateClaim.published).toBe(false);
    // The record never loaded, so it never spoke about the rate: the
    // field-level `completionRateWithheld` is therefore false while the
    // run-level `rateClaim.published` is the answer a publisher must read.
    expect(run19.state.correctedCompletionRate).toBeNull();
    expect(run19.rateClaim.reason).toMatch(/pinned set is not whole/);
    // No rows were supplied, so re-aggregation is SKIPPED and says why. A
    // fabricated empty denominator is never produced.
    expect(run19.reaggregation.status).toBe('skipped');
    expect(run19.reaggregation.reason).toMatch(/no qualified denominator/);
  });

  it('reports a byte-mismatch when the supplied record drifts from its pin', () => {
    // A record with the right MEANING but different bytes: the pin binds the
    // original bytes, so this is a binding failure, not a re-interpretation.
    const dir = producerWorkspace();
    const record = producerRecord();
    const bytes = JSON.stringify(record, null, 2);
    writeFileSync(join(dir.corpus, 'evidence/run19-lifecycle-correction.json'), `${bytes} `);
    const manifest = {
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [{
        id: 'drifted', kind: 'append-only-lifecycle-correction', root: 'corpus' as const,
        path: 'evidence/run19-lifecycle-correction.json',
        sha256: sha256(bytes), canonicalId: canonicalRecordHash(record), authorityId: AUTHORITY, recordedAt: null,
      }],
    };
    const manifestPath = join(dir.corpus, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const report = produceCorrectionAwareReport({
      manifestPath, repoRoot: REPO_ROOT, corpusRoot: dir.corpus,
      runs: [{ runId: RUN19 }], asOf: '2026-09-29T21:47:07Z', scopes: [],
    });

    expect(report.pinnedOk).toBe(false);
    const check = report.manifest.unverified.find((entry) => entry.id === 'drifted')!;
    expect(check.status).toBe('byte-mismatch');
    expect(check.observedSha256).not.toBe(check.expectedSha256);
    // The drifted record is not believed, so nothing about it is published.
    const run19 = report.runs.find((run) => run.runId === RUN19)!;
    expect(run19.state.applied).toBe(false);
    expect(run19.state.correctedCompletionRate).toBeNull();
    expect(run19.state.blockers.map((b) => b.reason)).toContain('artifact-binding-mismatch');
  });

  it('refuses a manifest path that escapes the root it is pinned against', () => {
    // A pinned path is data, not a licence to read outside the named root.
    const dir = producerWorkspace();
    const record = producerRecord();
    const bytes = JSON.stringify(record, null, 2);
    writeFileSync(join(dir.corpus, 'real-record.json'), bytes);
    const manifest = {
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [{
        id: 'escaping', kind: 'append-only-lifecycle-correction', root: 'corpus' as const,
        path: '../real-record.json',
        sha256: sha256(bytes), canonicalId: canonicalRecordHash(record), authorityId: AUTHORITY, recordedAt: null,
      }],
    };
    const manifestPath = join(dir.corpus, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const report = produceCorrectionAwareReport({
      manifestPath, repoRoot: REPO_ROOT, corpusRoot: dir.corpus,
      runs: [{ runId: RUN19 }], asOf: '2026-09-29T21:47:07Z', scopes: [],
    });
    expect(report.manifest.unverified.find((entry) => entry.id === 'escaping')?.status).toBe('unresolvable');
  });
});

describe('D22: the producer consumes, re-aggregates and writes exclusively', () => {
  it('rewrites only the derived rows, recomputes the rate, and preserves the originals', () => {
    const dir = producerWorkspace();
    const { corpus, evidence, out, rowsPath, projectionPath, rowsBytes, projectionBytes } = seededProducer(dir);

    const report = produceCorrectionAwareReport({
      manifestPath: join(corpus, 'manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: corpus,
      evidenceRoots: [evidence],
      runs: [{ runId: RUN19, rowsPath, originalPath: projectionPath }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
      adapter: { terminalCause: 'unknown', operationalStatus: 'interrupted', completionRows: [{ operationalStatus: 'complete' }] },
      outDir: out,
    });

    // The pin was verified from real bytes, so the correction qualified.
    expect(report.pinnedOk, JSON.stringify(report.manifest.unverified)).toBe(true);
    const run = report.runs[0]!;
    expect(run.publishable).toBe(true);
    expect(run.state.selectionStatus).toBe('selected');

    // The DERIVED rows carry the correction; the original ones do not. Both
    // hashes are reported, and they differ.
    expect(run.rowsPreserved.identical).toBe(false);
    expect(run.state.correctedFields).toEqual(expect.arrayContaining([
      'execution.authoritativeNativeTerminal', 'execution.terminalCause', 'normalWorkerCompletion', 'operationalStatus',
    ]));

    // The rate is RECOMPUTED by the aggregate lane over the corrected rows. It
    // is never the historic literal 1, and re-aggregation genuinely ran.
    expect(run.state.historicCompletionRate).toBe(1);
    expect(run.reaggregation.status).toBe('reaggregated');
    expect(run.reaggregation.originalTables).toBeGreaterThan(0);
    expect(run.reaggregation.correctedCompletionRate).toBe(0);
    expect(run.reaggregation.correctedCompletionRate).not.toBe(1);

    // The ORIGINAL historical evidence is byte-for-byte untouched by a
    // producing run. This is the immutability guarantee, asserted on the
    // bytes on disk rather than on a claim.
    expect(readFileSync(rowsPath, 'utf8')).toBe(rowsBytes);
    expect(readFileSync(projectionPath, 'utf8')).toBe(projectionBytes);

    // The produced report, the board and a manifest of what was written all
    // exist beside the evidence, not in place of it.
    expect(report.outputs.map((output) => basename(output.path)).sort()).toEqual([
      'correction-board.md', 'correction-report.json', 'producer-manifest.json',
    ]);
    for (const output of report.outputs) expect(sha256(readFileSync(output.path))).toBe(output.sha256);
    const written = JSON.parse(readFileSync(join(out, 'producer-manifest.json'), 'utf8')) as {
      runs: Array<{ runId: string; historicCompletionRate: number; correctedCompletionRate: number; completionRateWithheld: boolean }>;
    };
    expect(written.runs[0]!.historicCompletionRate).toBe(1);
    expect(written.runs[0]!.correctedCompletionRate).toBe(0);
    expect(written.runs[0]!.completionRateWithheld).toBe(false);
  });

  it('keeps correctness, compliance and completion separate in the produced report', () => {
    const dir = producerWorkspace();
    const { corpus, evidence, rowsPath, projectionPath } = seededProducer(dir);
    const report = produceCorrectionAwareReport({
      manifestPath: join(corpus, 'manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: corpus,
      evidenceRoots: [evidence],
      runs: [{ runId: RUN19, rowsPath, originalPath: projectionPath }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
      adapter: { terminalCause: 'unknown', operationalStatus: 'interrupted', completionRows: [{ operationalStatus: 'complete' }] },
    });

    const run = report.runs[0]!;
    // A lifecycle correction retracts an OPERATIONAL completion claim. The
    // judged outcomes it did not speak about are not touched, and the record's
    // own declarations are surfaced separately rather than merged into a row.
    expect(run.recordDeclaredOutcomes).toEqual({
      candidateCorrectness: true, formatConformance: false, assignedStrategySuccess: true, normalWorkerCompletion: false,
    });
    // The record speaks to OPERATIONAL completion only. Nothing it did not
    // speak about was projected, and no correctness value was rewritten.
    const projection = run.selection.projection;
    expect(Object.keys(projection).some((field) => /correctness|conformance|strategy/i.test(field))).toBe(false);
    expect(projection['operationalStatus']!.origin).toBe('correction');
    expect(projection['operationalStatus']!.value).toBe('interrupted');
    // Only the two row-writable lifecycle fields may reach a ROW. Everything
    // else the record spoke about is kept as a sidecar annotation, so a fact
    // the schema has no column for is visible rather than forced into one.
    const rowWritten = run.state.correctedFields.filter((field) => ROW_WRITABLE_CORRECTION_FIELDS.includes(field)).sort();
    expect(rowWritten).toEqual(['execution.terminalCause', 'operationalStatus']);
    expect(run.state.annotations.map((a) => a.field)).toContain('normalWorkerCompletion');
    // A completion claim may be retracted but never asserted.
    expect(run.state.correctedFields).toContain('normalWorkerCompletion');
    expect(projection['normalWorkerCompletion']!.value).toBe(false);
  });

  it('withholds the corrected rate when a named artifact cannot be re-hashed', () => {
    // The run19 six private native artifacts are not in the public checkout.
    // They are NOT supplied, so the binding is unresolved: the claim is
    // withheld, the historic 1 is not republished, and nothing is zeroed.
    const dir = producerWorkspace();
    const { corpus, rowsPath, projectionPath, out } = seededProducer(dir);
    const report = produceCorrectionAwareReport({
      manifestPath: join(corpus, 'manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: corpus,
      // No evidence roots at all.
      runs: [{ runId: RUN19, rowsPath, originalPath: projectionPath }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
      adapter: { terminalCause: 'unknown', operationalStatus: 'interrupted', completionRows: [{ operationalStatus: 'complete' }] },
      outDir: out,
    });

    const run = report.runs[0]!;
    expect(run.state.applied).toBe(false);
    expect(run.state.selectionStatus).toBe('unresolved');
    expect(run.state.completionRateWithheld).toBe(true);
    expect(run.rateClaim.published).toBe(false);
    expect(run.rateClaim.value).toBeNull();
    expect(run.state.correctedCompletionRate).toBeNull();
    expect(run.state.correctedCompletionRate).not.toBe(0);
    expect(run.state.correctedCompletionRate).not.toBe(1);
    expect(run.state.withheld.map((field) => field.field)).toContain('table.operationalCompletionRate');
    expect(run.state.blockers.map((b) => b.reason)).toContain('artifact-binding-unresolved');
    expect(run.publishable).toBe(false);
    expect(run.rateClaim.reason).toMatch(/retracted the rate and could not replace it/);
    // The rows are untouched, so re-aggregation produces no corrected table
    // rather than a corrected table that happens to equal the original.
    expect(run.rowsPreserved.identical).toBe(true);
    expect(run.reaggregation.correctedTables).toBe(0);
    // The withheld claim is on the board, in the words of the record.
    const board = readFileSync(join(out, 'correction-board.md'), 'utf8');
    expect(board).toContain('withheld table.operationalCompletionRate');
  });

  it('withholds a claim whose named artifact resolves with DIFFERENT bytes', () => {
    // A resolved-but-different artifact is an integrity failure, reported as
    // loudly as an unreadable one. Neither becomes a zero.
    const dir = producerWorkspace();
    const { corpus, evidence, rowsPath, projectionPath } = seededProducer(dir);
    writeFileSync(join(evidence, 'reportSha256'), 'tampered native report\n');
    const report = produceCorrectionAwareReport({
      manifestPath: join(corpus, 'manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: corpus,
      evidenceRoots: [evidence],
      runs: [{ runId: RUN19, rowsPath, originalPath: projectionPath }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
      adapter: { terminalCause: 'unknown', operationalStatus: 'interrupted', completionRows: [{ operationalStatus: 'complete' }] },
    });

    const run = report.runs[0]!;
    expect(run.state.applied).toBe(false);
    expect(run.state.correctedCompletionRate).toBeNull();
    expect(run.state.blockers.map((b) => b.reason)).toContain('artifact-binding-mismatch');
    expect(run.state.blockers.some((b) => b.detail?.includes('reportSha256'))).toBe(true);
  });

  it('never overwrites an existing output, and reports only what it actually wrote', () => {
    const dir = producerWorkspace();
    const { corpus, evidence, out, rowsPath, projectionPath } = seededProducer(dir);
    const options = {
      manifestPath: join(corpus, 'manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: corpus,
      evidenceRoots: [evidence],
      runs: [{ runId: RUN19, rowsPath, originalPath: projectionPath }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
      adapter: { terminalCause: 'unknown', operationalStatus: 'interrupted', completionRows: [{ operationalStatus: 'complete' }] },
    };

    const first = produceCorrectionAwareReport({ ...options, outDir: out });
    expect(first.outputs).toHaveLength(3);
    const boardBytes = readFileSync(join(out, 'correction-board.md'), 'utf8');

    // A second run over the same evidence produces identical BYTES, and
    // refuses to overwrite what is already there rather than racing it.
    const second = produceCorrectionAwareReport({ ...options, outDir: out });
    expect(second.outputs).toEqual([]);
    expect(readFileSync(join(out, 'correction-board.md'), 'utf8')).toBe(boardBytes);
  });

  it('requires an explicit as-of and refuses an implicit clock', () => {
    const dir = producerWorkspace();
    const { corpus, manifestPath } = seededProducer(dir);
    expect(() => produceCorrectionAwareReport({
      manifestPath, repoRoot: REPO_ROOT, corpusRoot: corpus,
      runs: [{ runId: RUN19 }], asOf: 'today', scopes: [],
    })).toThrow(/explicit RFC3339/);
  });

  it('refuses an original projection that is not a flat projection object', () => {
    // A published table ARRAY would have to be reduced to a single historic
    // rate, and that reduction is a decision the producer does not make for
    // the operator. It fails loud instead of picking one cell.
    const dir = producerWorkspace();
    const { corpus, manifestPath } = seededProducer(dir);
    const tablePath = join(corpus, 'table.json');
    writeFileSync(tablePath, JSON.stringify([{ role: 'fixer-worker', suite: 'fixer-worker', generatedAt: 'x', cells: [] }]));
    expect(() => produceCorrectionAwareReport({
      manifestPath, repoRoot: REPO_ROOT, corpusRoot: corpus,
      runs: [{ runId: RUN19, originalPath: tablePath }], asOf: '2026-09-29T21:47:07Z', scopes: [],
    })).toThrow(/flat object/);
  });
});

describe('D77: the producer renders a per-route board with cited status', () => {
  it('keeps route scope, remaining criterion and campaign completion distinct', () => {
    const dir = producerWorkspace();
    const audit = {
      schemaVersion: 1, kind: 'g1-contract-audit', scope: 'final-container Codex',
      // The G1 evidence lives under `g1Evidence`, which is the shape
      // `consumeStatus` reads. A record that states no G1 field leaves
      // actualRouteQualified UNKNOWN, never false.
      g1Evidence: {
        workspaceSeparation: true, frozenBaselineTree: true, independentJudgement: true,
        timeoutStopSettlementExport: true, nullableUsagePreserved: true,
      },
      actualPiTimeoutCancellationLeg: 'not-run: no second distinguishable workspace',
      campaignComplete: false,
    };
    const auditBytes = JSON.stringify(audit, null, 2);
    mkdirSync(join(dir.corpus, 'evidence'), { recursive: true });
    writeFileSync(join(dir.corpus, 'evidence/run21-g1-contract-audit.json'), auditBytes);
    const manifest = {
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [{
        id: 'run21-g1-contract-audit', kind: 'g1-contract-audit', root: 'corpus' as const,
        path: 'evidence/run21-g1-contract-audit.json',
        sha256: sha256(auditBytes), canonicalId: canonicalRecordHash(audit), authorityId: AUTHORITY, recordedAt: null,
      }],
    };
    const manifestPath = join(dir.corpus, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const report = produceCorrectionAwareReport({
      manifestPath, repoRoot: REPO_ROOT, corpusRoot: dir.corpus,
      runs: [{ runId: RUN21 }],
      asOf: '2026-09-29T21:47:07Z',
      // The scope is DECLARED by the operator. An audit with no declared scope
      // qualifies nothing and is listed as unread.
      scopes: [{ entryId: 'run21-g1-contract-audit', route: 'final-container Codex', lane: 'actual' }],
    });

    expect(report.pinnedOk, JSON.stringify(report.manifest.unverified)).toBe(true);
    const route = report.status.routes[0]!;
    expect(route.scope).toBe('final-container Codex');
    expect(route.remainingCriterion).toBe('not-run: no second distinguishable workspace');
    expect(report.status.unreadEntries).toEqual([]);

    const markdown = renderBoardMarkdown(report.board);
    // A route pass is not a campaign pass, and the board says which is which.
    expect(markdown).toContain('| actualRouteQualified | final-container Codex | — | — |');
    expect(markdown).toContain('| campaignComplete | — | campaign |');
    expect(markdown).toContain('Campaign complete: false');
    // Uncited dimensions are UNKNOWN, never a confident "no".
    expect(markdown).toMatch(/\| codeFixed \| — \| — \| final-container Codex \(no cited record\)/);
    expect(markdown).toContain('| campaignComplete | — | — | final-container Codex (no cited record)');
  });

  it('lists a route whose audit never verified as unread rather than unqualified', () => {
    const report = produceCorrectionAwareReport({
      manifestPath: join(REPO_ROOT, 'runner/reporting/corrections.manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: null,
      runs: [{ runId: RUN19 }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [{ entryId: 'run21-g1-contract-audit', route: 'final-container Codex', lane: 'actual' }],
    });
    expect(report.status.unreadEntries).toEqual(['run21-g1-contract-audit']);
    const route = report.status.routes[0]!;
    // An unread route claims nothing. The reason is carried on the report's
    // blockers, because the route itself asserted no dimension at all.
    expect(route.claims).toEqual([]);
    expect(route.scope).toBeNull();
    expect(route.remainingCriterion).toBeNull();
    expect(report.status.blockers.map((b) => b.reason)).toContain('no-approval-proof');
    // An unread route is unknown on the board, not "no".
    const dimensions = report.board.dimensions.find((d) => d.dimension === 'actualRouteQualified')!;
    expect(dimensions.yes).toEqual([]);
    expect(dimensions.no).toEqual([]);
    expect(dimensions.unknown.map((u) => u.route)).toContain('final-container Codex');
  });
});

describe('D22: the producer RUNTIME entry point', () => {
  it('produces a report from a real child process, fail-closed on the unavailable run19 artifacts', () => {
    const dir = producerWorkspace();
    const { corpus, rowsPath, projectionPath, out } = seededProducer(dir);
    const rowsBefore = readFileSync(rowsPath);
    const projectionBefore = readFileSync(projectionPath);

    // Run the SCRIPT, not the exported function. This is the non-test caller
    // the independent acceptance found missing, invoked exactly as an operator
    // would invoke it.
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(REPO_ROOT, 'runner/reporting/produce-correction-report.ts'),
        '--as-of', '2026-09-29T21:47:07Z',
        '--manifest', join(corpus, 'manifest.json'),
        '--repo-root', REPO_ROOT,
        '--corpus-root', corpus,
        '--run', RUN19,
        '--rows', `${RUN19}=${rowsPath}`,
        '--original', `${RUN19}=${projectionPath}`,
        '--adapter-terminal-cause', 'unknown',
        '--adapter-operational-status', 'interrupted',
        '--out', out,
      ],
      { encoding: 'utf8' },
    );

    // Producing a report that WITHHELDS is a successful run. The withheld
    // claim is not a producer failure and is never reported as a zero.
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain(`${RUN19}: selection=unresolved`);
    expect(child.stdout).toContain('corrected completion rate WITHHELD (null, not 0)');
    expect(child.stdout).not.toContain('rate 0');
    // The unresolvable artifacts are named on stderr, loudly, and the retracted
    // rate is withdrawn rather than restated. The adapter declared no
    // `completionRows` here, so the rate is `adapter-unmapped`: KNOWN to be
    // retracted with no qualified replacement. The historic 1 is not reused.
    expect(child.stderr).toContain('reportSha256');
    expect(child.stderr).toContain('table.operationalCompletionRate withheld (adapter-unmapped)');
    expect(child.stderr).toContain('the original value is not reused for a retracted projection');

    // The historical originals are byte-identical after a producing run.
    expect(readFileSync(rowsPath)).toEqual(rowsBefore);
    expect(readFileSync(projectionPath)).toEqual(projectionBefore);

    // And the report it wrote says the same thing the exit code implied.
    const written = JSON.parse(readFileSync(join(out, 'correction-report.json'), 'utf8')) as {
      pinnedOk: boolean;
      runs: Array<{ runId: string; state: { correctedCompletionRate: number | null; completionRateWithheld: boolean } }>;
    };
    expect(written.runs[0]!.state.correctedCompletionRate).toBeNull();
    expect(written.runs[0]!.state.completionRateWithheld).toBe(true);
  });

  it('exits 2 on a usage error and 1 under --require-publishable with a withheld claim', () => {
    const usage = spawnSync(
      process.execPath,
      ['--experimental-strip-types', join(REPO_ROOT, 'runner/reporting/produce-correction-report.ts'), '--as-of', '2026-09-29T21:47:07Z'],
      { encoding: 'utf8' },
    );
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('--run is required');

    const dir = producerWorkspace();
    const { corpus, rowsPath, projectionPath, out } = seededProducer(dir);
    const gate = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(REPO_ROOT, 'runner/reporting/produce-correction-report.ts'),
        '--as-of', '2026-09-29T21:47:07Z',
        '--manifest', join(corpus, 'manifest.json'),
        '--repo-root', REPO_ROOT,
        '--corpus-root', corpus,
        '--run', RUN19,
        '--rows', `${RUN19}=${rowsPath}`,
        '--original', `${RUN19}=${projectionPath}`,
        '--out', out,
        '--require-publishable',
      ],
      { encoding: 'utf8' },
    );
    // A run whose claims are all withheld satisfies a gate that demands a
    // publishable claim. It does not pass as a zero.
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain('--require-publishable');
  });
});

// ===========================================================================
// D22: PATH CONTAINMENT for the producer's resolvers.
//
// The independent acceptance of 92f9b872 at integrated head a7059c5 blocked
// acceptance on a source-correction defect: `resolveWithin` enforced
// containment LEXICALLY only, and `readFileSync` follows symlinks. A link
// planted inside a named root therefore redirected BOTH resolvers to bytes
// outside it. The pin's SHA256 still applied, so the escape was caught by
// nothing: the defect is that the named-root contract is about WHERE bytes may
// be read from, and that was not enforced.
//
// These are negative regressions for that defect. They are DEVELOPMENT
// regressions: not actual-route evidence, not factory evidence, and they
// satisfy no campaign acceptance criterion.
// ===========================================================================

/** A named root plus a sibling "outside" directory holding decoy bytes. */
function containmentWorkspace(): { root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'cq-pk14-containment-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  // A genuine in-root file, so "reads nothing" is distinguishable from
  // "reads the right things and refuses the wrong ones".
  mkdirSync(join(root, 'real'), { recursive: true });
  writeFileSync(join(root, 'real', 'record.json'), 'in-root-record\n');
  writeFileSync(join(outside, 'secret'), OUTSIDE_SECRET);
  return { root, outside };
}

const OUTSIDE_SECRET = 'SECRET-OUTSIDE-ROOT-BYTES\n';

/** A manifest entry for `path` inside the `repo` root. */
function repoEntry(path: string): ManifestEntry {
  return {
    id: 'probe', kind: 'append-only-lifecycle-correction', root: 'repo', path,
    sha256: '0'.repeat(64), canonicalId: '1'.repeat(64), authorityId: AUTHORITY, recordedAt: null,
  };
}

describe('D22: producer resolvers refuse to read outside a named root', () => {
  it('refuses a symlink component that redirects to outside bytes (both resolvers)', () => {
    // The acceptance's exact negative probe: a link inside the root pointing
    // at a sibling directory whose bytes live outside it.
    const { root, outside } = containmentWorkspace();
    symlinkSync(outside, join(root, 'link'), 'dir');
    const resolveManifest = createManifestResolver({ repoRoot: root, corpusRoot: root });
    const resolveEvidence = createEvidenceResolver([root]);

    expect(resolveManifest(repoEntry('link/secret'))).toBeNull();
    expect(resolveEvidence({ path: 'link/secret', sha256: '0'.repeat(64) })).toBeNull();
    // Positive control: a genuine in-root file still reads through BOTH.
    expect(resolveManifest(repoEntry('real/record.json'))?.toString()).toBe('in-root-record\n');
    expect(resolveEvidence({ path: 'real/record.json', sha256: '0'.repeat(64) })?.toString()).toBe('in-root-record\n');
  });

  it('refuses a symlink at the FINAL component, not just in a parent directory', () => {
    // The final component is the easiest case to get wrong: `..` and
    // mid-path traversal both look clean, and only an lstat of the leaf catches
    // a link that points straight out of the root.
    const { root, outside } = containmentWorkspace();
    symlinkSync(join(outside, 'secret'), join(root, 'link-to-secret'), 'file');
    const resolveManifest = createManifestResolver({ repoRoot: root, corpusRoot: root });
    const resolveEvidence = createEvidenceResolver([root]);

    expect(resolveManifest(repoEntry('link-to-secret'))).toBeNull();
    expect(resolveEvidence({ path: 'link-to-secret', sha256: '0'.repeat(64) })).toBeNull();
  });

  it('refuses a link that points at a directory only ONE level up', () => {
    // `link -> ..` is the textbook escape: it leaves the root while every
    // lexical component still reads as a plain relative name.
    const base = mkdtempSync(join(tmpdir(), 'cq-pk14-updown-'));
    const root = join(base, 'root');
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(base, 'secret'), OUTSIDE_SECRET);
    symlinkSync('..', join(root, 'nested', 'up'), 'dir');

    const resolveManifest = createManifestResolver({ repoRoot: root, corpusRoot: root });
    const resolveEvidence = createEvidenceResolver([root]);
    expect(resolveManifest(repoEntry('nested/up/secret'))).toBeNull();
    expect(resolveEvidence({ path: 'nested/up/secret', sha256: '0'.repeat(64) })).toBeNull();
  });

  it('refuses a DANGLING symlink whose target does not exist', () => {
    // A link to nowhere is still a link. It must be refused as a link, not
    // quietly reported as an ordinary missing file, so the refusal cannot be
    // confused with a legitimate unresolvable record.
    const { root } = containmentWorkspace();
    symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling'), 'file');
    const resolveManifest = createManifestResolver({ repoRoot: root, corpusRoot: root });
    const resolveEvidence = createEvidenceResolver([root]);

    expect(resolveManifest(repoEntry('dangling'))).toBeNull();
    expect(resolveEvidence({ path: 'dangling', sha256: '0'.repeat(64) })).toBeNull();
  });

  it('accepts a symlinked ROOT itself, because the operator named it', () => {
    // Containment is about the PINNED PATH, not about the caller's own choice
    // of where to point the root. A symlinked root resolves to its target and
    // that canonical directory becomes the boundary; an in-root file under it
    // must still read, or a legitimate deployment layout would break.
    const { root } = containmentWorkspace();
    const linkedRoot = join(root, '..', 'linked-root');
    symlinkSync(root, linkedRoot, 'dir');
    const resolveManifest = createManifestResolver({ repoRoot: linkedRoot, corpusRoot: linkedRoot });
    const resolveEvidence = createEvidenceResolver([linkedRoot]);

    expect(resolveManifest(repoEntry('real/record.json'))?.toString()).toBe('in-root-record\n');
    expect(resolveEvidence({ path: 'real/record.json', sha256: '0'.repeat(64) })?.toString()).toBe('in-root-record\n');
    // And containment still holds relative to the canonical boundary.
    symlinkSync(join(root, '..', 'outside'), join(root, 'escape'), 'dir');
    expect(resolveManifest(repoEntry('escape/secret'))).toBeNull();
  });

  it('still refuses absolute paths and `..` traversal, and reports absent files as null', () => {
    const { root } = containmentWorkspace();
    const resolveManifest = createManifestResolver({ repoRoot: root, corpusRoot: root });
    const resolveEvidence = createEvidenceResolver([root]);
    expect(resolveManifest(repoEntry('/etc/passwd'))).toBeNull();
    expect(resolveManifest(repoEntry('../outside/secret'))).toBeNull();
    expect(resolveManifest(repoEntry(''))).toBeNull();
    expect(resolveEvidence({ path: '../outside/secret', sha256: '0'.repeat(64) })).toBeNull();
    // A genuinely absent in-root file is unresolvable, not an escape and not
    // an empty read.
    expect(resolveManifest(repoEntry('real/absent.json'))).toBeNull();
  });

  it('reports a symlinked record as UNVERIFIABLE, never as matching bytes', () => {
    // End to end through the producer: a pin whose path is a symlink to
    // outside bytes cannot verify, so the record is not believed and no claim
    // is published from it. The outside bytes are never returned.
    const { root, outside } = containmentWorkspace();
    const record = producerRecord();
    const recordBytes = JSON.stringify(record, null, 2);
    writeFileSync(join(outside, 'run19-lifecycle-correction.json'), recordBytes);
    symlinkSync(join(outside, 'run19-lifecycle-correction.json'), join(root, 'linked-record.json'), 'file');
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      approvedAuthorities: [AUTHORITY],
      entries: [{
        id: 'linked', kind: 'append-only-lifecycle-correction', root: 'repo' as const, path: 'linked-record.json',
        sha256: sha256(recordBytes), canonicalId: canonicalRecordHash(record), authorityId: AUTHORITY, recordedAt: null,
      }],
    }, null, 2));

    const report = produceCorrectionAwareReport({
      manifestPath: join(root, 'manifest.json'),
      repoRoot: root,
      corpusRoot: null,
      runs: [{ runId: RUN19 }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
    });
    expect(report.manifest.unverified.find((entry) => entry.id === 'linked')?.status).toBe('unresolvable');
    expect(report.pinnedOk).toBe(false);
    expect(report.runs[0]!.publishable).toBe(false);
    expect(report.runs[0]!.rateClaim.value).toBeNull();
  });

  it('preserves hash verification and exclusive writes after the fix', () => {
    // The correction must not have disturbed the behaviour that was already
    // accepted: a verified pin still qualifies, and a second producing run
    // still writes nothing over existing bytes.
    const dir = producerWorkspace();
    const { corpus, evidence, out, rowsPath, projectionPath, rowsBytes, projectionBytes } = seededProducer(dir);
    const options = {
      manifestPath: join(corpus, 'manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: corpus,
      evidenceRoots: [evidence],
      runs: [{ runId: RUN19, rowsPath, originalPath: projectionPath }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
      adapter: { terminalCause: 'unknown', operationalStatus: 'interrupted', completionRows: [{ operationalStatus: 'complete' }] },
    };

    const first = produceCorrectionAwareReport({ ...options, outDir: out });
    // Hash verification intact: 7 pins of real bytes still qualify, and the
    // corrected rate is still recomputed rather than the historic literal.
    expect(first.pinnedOk, JSON.stringify(first.manifest.unverified)).toBe(true);
    expect(first.runs[0]!.publishable).toBe(true);
    expect(first.runs[0]!.reaggregation.correctedCompletionRate).toBe(0);
    expect(first.outputs).toHaveLength(3);

    // Exclusive write intact: a second run writes nothing and changes nothing.
    const second = produceCorrectionAwareReport({ ...options, outDir: out });
    expect(second.outputs).toEqual([]);
    expect(readFileSync(rowsPath, 'utf8')).toBe(rowsBytes);
    expect(readFileSync(projectionPath, 'utf8')).toBe(projectionBytes);
  });

  it('still reads the REAL repository and corpus pins through the fixed resolver', () => {
    // The fix must not have broken the production path: the real repo-rooted
    // run18 audit lives at runner/boundary/evidence/fallback/... and is
    // several directories deep, which is exactly what a naive containment
    // check gets wrong.
    const report = produceCorrectionAwareReport({
      manifestPath: join(REPO_ROOT, 'runner/reporting/corrections.manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: null,
      runs: [{ runId: RUN18 }, { runId: RUN19 }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
    });
    expect(report.manifest.verified).toContain('run18-retention-audit');
    // The corpus was not supplied, so those records are unresolved — which is
    // the fail-closed result, not a containment failure.
    for (const entry of report.manifest.unverified) expect(entry.status).toBe('unresolvable');
  });
});

// ===========================================================================
// D22: the check/read race (TOCTOU) in the producer's resolvers.
//
// The follow-up review of 56ca767 was correct. That revision claimed its
// realpath layer "closed the TOCTOU window"; it did not. It computed
// `realpath(lexical)`, checked containment, and then RETURNED THE LEXICAL
// PATH, which the caller re-opened by name. A deterministic probe that swapped
// an in-root directory for a symlink to an outside directory in the window
// between the check and the `readFileSync` made the resolver return the
// OUTSIDE bytes while every containment layer had already reported success.
//
// A SHA256 check does not catch this. A hash says the BYTES match a pin; it
// does not say the bytes came from inside the root the caller named, and an
// attacker chooses the pin's contents too.
//
// The fix reads through a descriptor that was opened with O_NOFOLLOW and whose
// device+inode were compared against the leaf that was validated, so the bytes
// come from the verified object regardless of what happens to the path.
//
// These regressions drive the producer in a child process with a generated ESM
// resolve hook, so the swap happens at an exact syscall boundary without
// mocking node:fs for the whole file.
// ===========================================================================

/**
 * Run the producer in a child process where `node:fs` is intercepted ONLY for
 * the producer module, and the supplied hook fires at the `openSync` call.
 * That is the true race window: containment has already passed, and only the
 * descriptor identity check can still catch a redirect.
 */
function runWithOpenHook(): { result: string | null; evidence: string | null; opened: number } {
  const dir = mkdtempSync(join(tmpdir(), 'cq-pk14-toctou-'));
  const shim = join(dir, 'shim.mjs');
  const loader = join(dir, 'loader.mjs');
  const probe = join(dir, 'probe.mts');
  writeFileSync(shim, `
import * as real from 'node:fs';
export * from 'node:fs';
export function openSync(p, ...rest) {
  globalThis.__HOOK__(String(p));
  return real.openSync(p, ...rest);
}
`);
  writeFileSync(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:fs' && context.parentURL && context.parentURL.includes('runner/reporting/producer.ts')) {
    return { url: ${JSON.stringify(pathToFileURL(shim).href)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);
  writeFileSync(probe, `
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManifestResolver, createEvidenceResolver } from ${JSON.stringify(join(REPO_ROOT, 'runner/reporting/producer.ts'))};

const base = mkdtempSync(join(tmpdir(), 'cq-pk14-race-'));
const root = join(base, 'root');
const inside = join(root, 'rec');
const outside = join(base, 'outside');
mkdirSync(inside, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(inside, 'record'), 'GOOD-IN-ROOT-BYTES\\n');
writeFileSync(join(outside, 'record'), 'EVIL-OUTSIDE-BYTES\\n');

const opened = [];
globalThis.__HOOK__ = (p) => { opened.push(p); if (p.endsWith('/rec/record')) globalThis.__SWAP__(); };
globalThis.__SWAP__ = () => {
  rmSync(inside, { recursive: true, force: true });
  symlinkSync(outside, inside, 'dir');
};

const manifest = createManifestResolver({ repoRoot: root, corpusRoot: root });
const evidence = createEvidenceResolver([root]);
const entry = { id: 'p', kind: 'append-only-lifecycle-correction', root: 'repo', path: 'rec/record',
  sha256: '0'.repeat(64), canonicalId: '1'.repeat(64), authorityId: 'cq-settings-execution-orchestrator', recordedAt: null };
const m = manifest(entry);
const e = evidence({ path: 'rec/record', sha256: '0'.repeat(64) });
console.log(JSON.stringify({
  opened: opened.filter((p) => p.endsWith('/rec/record')).length,
  manifest: m === null ? null : m.toString(),
  evidence: e === null ? null : e.toString(),
}));
`);
  const register = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(pathToFileURL(loader).href)});`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--import', register, probe], { encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
  const parsed = JSON.parse(child.stdout.trim().split('\n').pop()!) as { opened: number; manifest: string | null; evidence: string | null };
  return { result: parsed.manifest, evidence: parsed.evidence, opened: parsed.opened };
}

describe('D22: the producer cannot be redirected between validation and read', () => {
  it('refuses bytes from a directory swapped for an outside symlink mid-flight', () => {
    // `root/rec` is an ordinary in-root DIRECTORY when the checks run, so all
    // three containment layers pass. The hook then replaces it with a symlink
    // to a sibling outside the root, immediately before the open. The open
    // itself succeeds and the kernel follows the new link; only the
    // device+inode identity check distinguishes the two files, and it must
    // refuse rather than return the outside bytes.
    const { result, evidence, opened } = runWithOpenHook();
    // The hook really did fire at the open, so this is not a vacuous refusal.
    expect(opened).toBeGreaterThan(0);
    expect(result).toBeNull();
    expect(evidence).toBeNull();
    expect(result).not.toBe('EVIL-OUTSIDE-BYTES\n');
    expect(evidence).not.toBe('EVIL-OUTSIDE-BYTES\n');
  });

  it('still reads the genuine in-root bytes when nothing is swapped', () => {
    // The control for the test above: with no swap the same resolver returns
    // the real bytes. A resolver that simply always returned null would pass
    // the negative test and fail here.
    const dir = containmentWorkspace();
    const resolve = createManifestResolver({ repoRoot: dir.root, corpusRoot: dir.root });
    expect(resolve(repoEntry('real/record.json'))?.toString()).toBe('in-root-record\n');
  });

  it('reads only through a descriptor, so a path swap after the open cannot alter the bytes', () => {
    // After the verified descriptor is open, the bytes are read from the
    // descriptor rather than by re-resolving the path, so a swap that lands
    // after the open changes the filesystem but not what was read. The probe
    // below swaps on EVERY open attempt and still yields the in-root bytes
    // for the first, already-validated read.
    const { result, evidence } = runWithOpenHook();
    expect(result === null || result === 'GOOD-IN-ROOT-BYTES\n').toBe(true);
    expect(evidence === null || evidence === 'GOOD-IN-ROOT-BYTES\n').toBe(true);
    expect(result).not.toBe('EVIL-OUTSIDE-BYTES\n');
    expect(evidence).not.toBe('EVIL-OUTSIDE-BYTES\n');
  });

  it('still refuses a symlinked leaf and a symlinked directory after the fix', () => {
    // The original containment regressions must still hold now that reads go
    // through O_NOFOLLOW and a descriptor: refusal is unchanged, and in-root
    // reads are unaffected.
    const { root, outside } = containmentWorkspace();
    symlinkSync(join(outside, 'secret'), join(root, 'leaf-link'), 'file');
    symlinkSync(outside, join(root, 'dir-link'), 'dir');
    const resolve = createManifestResolver({ repoRoot: root, corpusRoot: root });
    const evidence = createEvidenceResolver([root]);
    expect(resolve(repoEntry('leaf-link'))).toBeNull();
    expect(resolve(repoEntry('dir-link/secret'))).toBeNull();
    expect(evidence({ path: 'leaf-link', sha256: '0'.repeat(64) })).toBeNull();
    expect(evidence({ path: 'dir-link/secret', sha256: '0'.repeat(64) })).toBeNull();
    expect(resolve(repoEntry('real/record.json'))?.toString()).toBe('in-root-record\n');
  });

  it('preserves hash verification, corrected-rate recomputation and exclusive writes', () => {
    // The descriptor-based read must not have disturbed accepted behaviour:
    // real pins still verify, the corrected rate is still recomputed rather
    // than the historic literal, and a second producing run still writes
    // nothing over existing bytes.
    const dir = producerWorkspace();
    const { corpus, evidence, out, rowsPath, projectionPath, rowsBytes, projectionBytes } = seededProducer(dir);
    const options = {
      manifestPath: join(corpus, 'manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: corpus,
      evidenceRoots: [evidence],
      runs: [{ runId: RUN19, rowsPath, originalPath: projectionPath }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
      adapter: { terminalCause: 'unknown', operationalStatus: 'interrupted', completionRows: [{ operationalStatus: 'complete' }] },
    };
    const first = produceCorrectionAwareReport({ ...options, outDir: out });
    expect(first.pinnedOk, JSON.stringify(first.manifest.unverified)).toBe(true);
    expect(first.runs[0]!.publishable).toBe(true);
    expect(first.runs[0]!.reaggregation.correctedCompletionRate).toBe(0);
    expect(first.outputs).toHaveLength(3);
    const second = produceCorrectionAwareReport({ ...options, outDir: out });
    expect(second.outputs).toEqual([]);
    expect(readFileSync(rowsPath, 'utf8')).toBe(rowsBytes);
    expect(readFileSync(projectionPath, 'utf8')).toBe(projectionBytes);
  });

  it('still reads the REAL repository pin through the descriptor path', () => {
    // The real repo-rooted run18 audit is several directories deep. A
    // descriptor-based read must still reach it, or the fix would have broken
    // the production path it was meant to protect.
    const report = produceCorrectionAwareReport({
      manifestPath: join(REPO_ROOT, 'runner/reporting/corrections.manifest.json'),
      repoRoot: REPO_ROOT,
      corpusRoot: null,
      runs: [{ runId: RUN18 }, { runId: RUN19 }],
      asOf: '2026-09-29T21:47:07Z',
      scopes: [],
    });
    expect(report.manifest.verified).toContain('run18-retention-audit');
    for (const entry of report.manifest.unverified) expect(entry.status).toBe('unresolvable');
  });
});
