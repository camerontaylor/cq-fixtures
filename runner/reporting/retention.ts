// PK14 / D22: typed retention projection, per resource type.
//
// The D22 finding is that a single conflated field ("recoveryRetained")
// asserted recovery while the full candidate was already gone. This module
// therefore states retention per resource type, as a TRI-STATE:
//
//   retained - a cited record affirms the resource survived.
//   absent   - a cited record proves it is gone.
//   unknown  - no proof exists. NOT an observed zero.
//
// It reads the EXISTING public audit shapes rather than defining a new format,
// and it never reconstructs a lost artifact: a surviving patch and a surviving
// judgement do not lift `fullCandidate` off `absent`, and a missing namespace
// does not prove anything about a volume's contents.

import type { ArtifactBinding, RetentionState, ResourceKind } from './types.ts';

export interface RetentionFact {
  state: RetentionState;
  /** The immutable record(s) the state was read from. */
  evidence: ArtifactBinding[];
  /** Authentic timestamp of the deciding record, or null. */
  recordedAt: string | null;
  /** Why the state is what it is. Always populated, including for `retained`. */
  reason: string;
}

export type RetentionProjection = Record<ResourceKind, RetentionFact>;

export interface RetentionView {
  runId: string;
  resources: RetentionProjection;
  /** Byte-bound reference to the record the projection was read from. */
  recordRef: ArtifactBinding;
  /**
   * The conflated field the historical record used, kept for contrast. It is
   * reported as a note, never as a substitute for the per-resource states.
   */
  conflatedField?: { field: string; value: unknown };
}

const RESOURCE_KINDS: ResourceKind[] = ['patch', 'auth', 'fullCandidate', 'taskVolume', 'contextVolume', 'publishedHost'];

function fact(state: RetentionState, reason: string, recordRef: ArtifactBinding, recordedAt: string | null): RetentionFact {
  return { state, evidence: [recordRef], recordedAt, reason };
}

/** Field names that, per existing record family, decide a resource state. */
const FIELD_SOURCES: Record<ResourceKind, string[]> = {
  // The D22 conflation: `fullCandidateAvailable` is about the candidate, never
  // about auth recovery. They are read from different fields on purpose.
  fullCandidate: ['fullCandidateAvailable'],
  auth: ['authRecoveryPresent'],
  taskVolume: ['taskVolumeAvailable', 'recoveryVolumesOwnedAndUnattached'],
  contextVolume: ['contextVolumeAvailable', 'recoveryVolumesOwnedAndUnattached'],
  publishedHost: ['publishedHostAvailable', 'hostWorkspacePresent'],
  // A surviving patch is evidenced by the surviving-artifact inventory, not by
  // a boolean, so it is resolved separately below.
  patch: [],
};

function booleanField(doc: Record<string, unknown>, name: string): boolean | null {
  const value = doc[name];
  return typeof value === 'boolean' ? value : null;
}

export interface ProjectRetentionInput {
  runId: string;
  /** The parsed immutable audit / retention record. Never mutated. */
  record: unknown;
  /** Byte-bound reference to that record. */
  recordRef: ArtifactBinding;
  recordedAt?: string | null;
}

/**
 * Project retention for one run from an existing retention-shaped record.
 *
 * Handles, read-only, the three record families already in evidence:
 *   - the in-repo public retention audit (`*Available` booleans plus
 *     `survivingArtifacts`),
 *   - the corpus retention binding (`authRecoveryPresent`,
 *     `hostWorkspacePresent`, a `volumes` inventory),
 *   - the contract audit (`recoveryVolumesOwnedAndUnattached`).
 *
 * Any resource with no decisive field in the record is `unknown`, with a
 * reason naming the field that was looked for and not found.
 */
export function projectRetention(input: ProjectRetentionInput): RetentionView {
  const { runId, record, recordRef } = input;
  const recordedAt = input.recordedAt ?? null;
  const doc = (record && typeof record === 'object' ? record : {}) as Record<string, unknown>;

  const resources = Object.fromEntries(
    RESOURCE_KINDS.map((kind) => [kind, fact('unknown', `no retention field for ${kind} in this record`, recordRef, recordedAt)]),
  ) as RetentionProjection;

  // Per-resource boolean fields.
  for (const kind of RESOURCE_KINDS) {
    for (const field of FIELD_SOURCES[kind]) {
      const value = booleanField(doc, field);
      if (value === null) continue;
      resources[kind] = fact(
        value ? 'retained' : 'absent',
        `${field}=${value} in ${recordRef.path}`,
        recordRef,
        recordedAt,
      );
      break;
    }
  }

  // The volume inventory, when present, is more specific than the coarse
  // "recoveryVolumesOwnedAndUnattached" boolean: an unowned volume is unknown,
  // not retained.
  const volumes = Array.isArray(doc.volumes) ? (doc.volumes as Record<string, unknown>[]) : null;
  if (volumes) {
    for (const kind of ['task', 'context'] as const) {
      const resource = `${kind}Volume` as ResourceKind;
      const entry = volumes.find((v) => v.kind === kind);
      if (!entry) continue;
      if (entry.ownershipVerified === true) {
        resources[resource] = fact('retained', `volumes[${kind}].ownershipVerified=true in ${recordRef.path}`, recordRef, recordedAt);
      } else {
        resources[resource] = fact('unknown', `volumes[${kind}] exists but ownershipVerified is not true`, recordRef, recordedAt);
      }
    }
  }

  // Patch retention comes from the surviving-artifact inventory, which is a
  // list of hash-bound survivors rather than a boolean.
  const survivors = Array.isArray(doc.survivingArtifacts) ? (doc.survivingArtifacts as Record<string, unknown>[]) : null;
  if (survivors) {
    const patch = survivors.find((a) => typeof a.kind === 'string' && a.kind.endsWith('.patch'));
    if (patch) {
      resources.patch = fact(
        'retained',
        `survivingArtifacts contains ${String(patch.kind)} (${String(patch.sha256 ?? 'unbound')})`,
        recordRef,
        recordedAt,
      );
    } else {
      resources.patch = fact('absent', `survivingArtifacts contains no .patch entry in ${recordRef.path}`, recordRef, recordedAt);
    }
  }

  // A surviving judgement is evidence about a judgement, not about the
  // candidate it judged. It is deliberately NOT allowed to lift fullCandidate.
  if (survivors && resources.fullCandidate.state === 'absent' && survivors.some((a) => a.kind === 'judgement')) {
    resources.fullCandidate = fact(
      'absent',
      `fullCandidateAvailable=false; a surviving judgement is not the candidate and does not restore it (${recordRef.path})`,
      recordRef,
      recordedAt,
    );
  }

  const conflated = typeof doc.runtimeRecoveryRetained === 'boolean'
    ? { field: 'runtimeRecoveryRetained', value: doc.runtimeRecoveryRetained }
    : undefined;

  return { runId, resources, recordRef, ...(conflated ? { conflatedField: conflated } : {}) };
}

/** True only when the two views agree. `unknown` never counts as agreement. */
export function retentionIsFullyAccountedFor(view: RetentionView): boolean {
  return RESOURCE_KINDS.every((kind) => view.resources[kind].state !== 'unknown');
}
