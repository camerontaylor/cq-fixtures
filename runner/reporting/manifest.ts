// PK14: the pinned correction/audit manifest.
//
// The correction and audit records for D22 and D77 live in the research corpus,
// not in this checkout, and PK00 owns the campaign source manifest. Rather than
// edit a manifest this packet does not own, the pins live here, under
// PK14-owned paths, and drift fails closed.
//
// Two hashes are recorded per entry and they are NOT interchangeable:
//   sha256       SHA256 of the record's original bytes, for binding verification.
//   canonicalId  the deterministic canonical-record hash, which is the record's
//                IDENTITY in the supersession graph. It is derived from the
//                parsed document, so a re-serialized file with identical meaning
//                keeps its identity while its byte hash changes.
//
// `recordedAt` is null for every current entry: these legacy records carry no
// authentic timestamp and none is synthesized. A null here means "unrecorded",
// not "recent" and not "old".

import { canonicalRecordHash, sha256Hex } from './corrections.ts';
import type { BindingRoot } from './types.ts';

export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestEntry {
  id: string;
  kind: string;
  root: BindingRoot;
  /** Path relative to the entry's root. */
  path: string;
  /** SHA256 of the original record bytes. */
  sha256: string;
  /** Deterministic canonical-record hash, i.e. the record's identity. */
  canonicalId: string;
  /** The authority allowed to issue a correction anchored to this record. */
  authorityId: string;
  /** Authentic timestamp or null. Never synthesized. */
  recordedAt: string | null;
}

export interface CorrectionsManifest {
  schemaVersion: number;
  /** Approved authority identities. A record from any other authority is unresolved. */
  approvedAuthorities: string[];
  entries: ManifestEntry[];
}

export interface EntryVerification {
  id: string;
  path: string;
  expectedSha256: string;
  observedSha256: string | null;
  expectedCanonicalId: string;
  observedCanonicalId: string | null;
  status: 'verified' | 'byte-mismatch' | 'canonical-mismatch' | 'unresolvable' | 'not-supplied';
  detail: string;
}

export interface ManifestVerification {
  ok: boolean;
  entries: EntryVerification[];
  unverified: EntryVerification[];
}

/** Resolves a record's bytes. Returns null when the record is not supplied. */
export type ManifestResolver = (entry: ManifestEntry) => string | Buffer | null | undefined;

/**
 * Verify every manifest entry against supplied bytes.
 *
 * A record that is not supplied is `unresolvable`, which keeps "we do not have
 * it" distinct from "it does not exist" and from "it matches". Callers decide
 * what an unverified entry means for their selection; this function never
 * treats absence as agreement.
 */
export function verifyManifest(manifest: CorrectionsManifest, resolve: ManifestResolver): ManifestVerification {
  const entries = manifest.entries.map((entry): EntryVerification => {
    let bytes: string | Buffer | null | undefined;
    try {
      bytes = resolve(entry);
    } catch (error) {
      return {
        id: entry.id,
        path: entry.path,
        expectedSha256: entry.sha256,
        observedSha256: null,
        expectedCanonicalId: entry.canonicalId,
        observedCanonicalId: null,
        status: 'unresolvable',
        detail: `resolver threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (bytes === null || bytes === undefined) {
      return {
        id: entry.id,
        path: entry.path,
        expectedSha256: entry.sha256,
        observedSha256: null,
        expectedCanonicalId: entry.canonicalId,
        observedCanonicalId: null,
        status: 'unresolvable',
        detail: 'record not supplied; unresolved, not absent and not verified',
      };
    }
    const observedSha256 = sha256Hex(bytes);
    if (observedSha256 !== entry.sha256) {
      return {
        id: entry.id,
        path: entry.path,
        expectedSha256: entry.sha256,
        observedSha256,
        expectedCanonicalId: entry.canonicalId,
        observedCanonicalId: null,
        status: 'byte-mismatch',
        detail: 'supplied bytes differ from the pinned SHA256',
      };
    }
    let observedCanonicalId: string | null = null;
    try {
      observedCanonicalId = canonicalRecordHash(JSON.parse(bytes.toString()));
    } catch {
      return {
        id: entry.id,
        path: entry.path,
        expectedSha256: entry.sha256,
        observedSha256,
        expectedCanonicalId: entry.canonicalId,
        observedCanonicalId: null,
        status: 'canonical-mismatch',
        detail: 'record bytes match but the document is not parseable JSON',
      };
    }
    if (observedCanonicalId !== entry.canonicalId) {
      return {
        id: entry.id,
        path: entry.path,
        expectedSha256: entry.sha256,
        observedSha256,
        expectedCanonicalId: entry.canonicalId,
        observedCanonicalId,
        status: 'canonical-mismatch',
        detail: 'supplied bytes match but the canonical record identity differs',
      };
    }
    return {
      id: entry.id,
      path: entry.path,
      expectedSha256: entry.sha256,
      observedSha256,
      expectedCanonicalId: entry.canonicalId,
      observedCanonicalId,
      status: 'verified',
      detail: 'bytes and canonical identity match the pins',
    };
  });

  const unverified = entries.filter((e) => e.status !== 'verified');
  return { ok: unverified.length === 0, entries, unverified };
}

/** Look up one pinned entry by id. */
export function manifestEntry(manifest: CorrectionsManifest, id: string): ManifestEntry | null {
  return manifest.entries.find((entry) => entry.id === id) ?? null;
}

/** Every authority the manifest approves. A record outside this set is unresolved. */
export function approvedAuthorities(manifest: CorrectionsManifest): string[] {
  return [...manifest.approvedAuthorities];
}
