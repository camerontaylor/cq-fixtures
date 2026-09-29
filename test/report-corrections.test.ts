// PK14 / D22 + D77 regression: correction-aware report selection, typed
// retention, and the correction-aware status view.
//
// These tests are DEVELOPMENT regressions for a source gap. They are not
// actual-route evidence, not factory/lifecycle evidence, and they satisfy no
// campaign acceptance criterion. Nothing here proves that a report CONSUMES a
// correction: that requires the serialized PK02/PK03 wiring lease, and
// `does not claim wiring into other-owned code` below is the guard for it.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
import { approvedAuthorities, manifestEntry, verifyManifest, type CorrectionsManifest } from '../runner/reporting/manifest.ts';
import { PINNED_OPERATIONAL_STATUSES, PINNED_TERMINAL_CAUSES } from '../runner/reporting/vocabulary.ts';

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

  it('does not claim wiring into other-owned code', () => {
    for (const owned of ['runner/index.ts', 'runner/aggregate.ts']) {
      expect(repoFile(owned)).not.toContain('reporting/');
    }
    // And the sidecar does not reach into PK02-owned modules either.
    for (const file of ['index.ts', 'corrections.ts', 'retention.ts', 'status-view.ts', 'board.ts', 'manifest.ts']) {
      const source = repoFile(`runner/reporting/${file}`);
      expect(source).not.toContain("../aggregate.ts");
      expect(source).not.toContain("../index.ts");
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
