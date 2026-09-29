// PK14 / D22: artifact binding verification for correction records.
//
// A correction may only be qualified once every artifact it names has been
// re-hashed and matches the SHA256 recorded in the correction. The two failure
// modes are kept distinct and both fail CLOSED:
//
//   mismatch      - the artifact resolved and its bytes differ.
//   unresolvable  - the artifact could not be read at all.
//
// An unresolvable artifact is reported unresolved. It is never treated as
// "the artifact does not exist, therefore the correction is unnecessary" and
// never as "the artifact is gone, therefore the original value still holds".
// Later absence never repairs missing historical proof.

import { sha256Hex, type CorrectionRecord } from './corrections.ts';
import type { ArtifactBinding, Disposition } from './types.ts';

/** Reads an artifact by its recorded path, or null when it cannot be read. */
export type ArtifactResolver = (binding: ArtifactBinding) => Buffer | string | null | undefined;

export interface BindingDisposition {
  name: string;
  path: string;
  expectedSha256: string;
  observedSha256: string | null;
  status: 'verified' | 'mismatch' | 'unresolvable';
  detail: string;
}

export interface BindingVerdict {
  status: 'verified' | 'mismatch' | 'unresolved';
  /** Every named artifact, in the record's own key order, for provenance. */
  artifacts: BindingDisposition[];
  /** Ready-made disposition for selectCorrections(). */
  disposition: Disposition;
}

/** Re-hash one named artifact against the SHA256 the correction recorded. */
export function verifyArtifactBinding(name: string, binding: ArtifactBinding, resolve: ArtifactResolver): BindingDisposition {
  let bytes: Buffer | string | null | undefined;
  try {
    bytes = resolve(binding);
  } catch (error) {
    return {
      name,
      path: binding.path,
      expectedSha256: binding.sha256,
      observedSha256: null,
      status: 'unresolvable',
      detail: `resolver threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (bytes === null || bytes === undefined) {
    return {
      name,
      path: binding.path,
      expectedSha256: binding.sha256,
      observedSha256: null,
      status: 'unresolvable',
      detail: 'artifact could not be resolved; unresolved is not absence and not agreement',
    };
  }
  const observedSha256 = sha256Hex(bytes);
  return {
    name,
    path: binding.path,
    expectedSha256: binding.sha256,
    observedSha256,
    status: observedSha256 === binding.sha256 ? 'verified' : 'mismatch',
    detail: observedSha256 === binding.sha256 ? 'bytes match the recorded hash' : 'resolved bytes differ from the recorded hash',
  };
}

/**
 * Verify every mandatory artifact hash a correction depends on.
 *
 * A record with no named artifacts verifies vacuously: that is `verified` with
 * zero artifacts, and it is reported as such rather than being padded with a
 * fabricated binding.
 */
export function verifyCorrectionBinding(record: CorrectionRecord, resolve: ArtifactResolver): BindingVerdict {
  const artifacts = Object.entries(record.sourceEvidence).map(([name, binding]) =>
    verifyArtifactBinding(name, binding, resolve),
  );
  const mismatch = artifacts.find((a) => a.status === 'mismatch');
  if (mismatch) {
    return {
      status: 'mismatch',
      artifacts,
      disposition: {
        status: 'unresolved',
        reason: 'artifact-binding-mismatch',
        detail: `${mismatch.name}: expected ${mismatch.expectedSha256}, observed ${mismatch.observedSha256 ?? 'unreadable'}`,
      },
    };
  }
  const unresolvable = artifacts.find((a) => a.status === 'unresolvable');
  if (unresolvable) {
    return {
      status: 'unresolved',
      artifacts,
      disposition: {
        status: 'unresolved',
        reason: 'artifact-binding-unresolved',
        detail: `${unresolvable.name}: ${unresolvable.detail}`,
      },
    };
  }
  return {
    status: 'verified',
    artifacts,
    disposition: { status: 'accepted', reason: 'selected-correction', detail: `${artifacts.length} artifact binding(s) verified` },
  };
}

/**
 * A resolver backed by an in-memory byte map. Callers supply the bytes; this
 * module never reads the filesystem, so the projection stays pure and a test
 * can pin exact record bytes without touching a real evidence directory.
 */
export function byteMapResolver(bytes: Record<string, string | Buffer>): ArtifactResolver {
  return (binding) => bytes[binding.path] ?? null;
}
