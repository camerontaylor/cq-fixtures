// F6 (WB-5.2a): persist the prediction. A run's fixer patches and classifier
// structured outputs are written with the tables so a regrade has something to
// re-judge and the human-verified tier has an artifact to sample. Every
// artifact is size-bounded and denylist-scanned BEFORE it is written — a
// withheld artifact is diagnosable, never silently published.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findDenylistMatch, loadDenylistRules } from './denylist.ts';

/** Per-artifact size caps (bytes) — a worker must not publish unbounded output. */
export const MAX_PATCH_BYTES = 262144; // 256 KiB
export const MAX_OUTPUT_BYTES = 65536; // 64 KiB
/** Appended when an artifact exceeds its cap; re-judge refuses truncated artifacts. */
export const TRUNCATION_MARKER_PREFIX = '# [cq-fixtures] artifact truncated:';

/** The marker appended to an over-cap artifact (keeps the published bytes honest). */
export function truncationMarker(full: number, cap: number): string {
  return `\n${TRUNCATION_MARKER_PREFIX} full ${full} bytes exceeds cap ${cap}\n`;
}

/** True when `content` carries the truncation marker (regrade must not re-judge it). */
export function isTruncated(content: string): boolean {
  return content.includes(TRUNCATION_MARKER_PREFIX);
}

/**
 * F6: a case id becomes a filename segment (`patches/<id>.patch`,
 * `outputs/<id>.json`). The suite schema only requires a non-empty unique id,
 * so a `/`, `\`, or `..` id could escape `<out>`; every artifact path is
 * built from this guard and an unsafe id is withheld/diagnosed, never written
 * (publish) or read (regrade).
 */
export function isSafeCaseSegment(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** One artifact a run produced for a case (raw, not yet bounded/scanned). */
export interface CaseArtifact {
  case: string;
  kind: 'patch' | 'output';
  content: string;
}

export interface PublishedArtifact {
  case: string;
  kind: 'patch' | 'output';
  /** out-dir-relative path the artifact lives at (or would live at). */
  relPath: string;
  /** denylist rule id when the artifact was withheld (never written). */
  withheld?: string;
  truncated?: boolean;
}

export interface PublishResult {
  published: PublishedArtifact[];
  diagnostics: string[];
}

/**
 * Bound each artifact to its cap, denylist-scan it, and write it under
 * `<outDir>/patches/<case>.patch` or `<outDir>/outputs/<case>.json`. A
 * withheld artifact is NOT written and is recorded as a diagnostic; a
 * truncated one is written with the marker appended. Never throws on a single
 * bad artifact (only a missing/unparseable denylist policy throws, failing the
 * emit loud rather than publishing unscanned predictions).
 */
export function publishArtifacts(
  outDir: string,
  artifacts: readonly CaseArtifact[],
  repoRoot: string,
): PublishResult {
  const rules = loadDenylistRules(repoRoot);
  const published: PublishedArtifact[] = [];
  const diagnostics: string[] = [];
  for (const a of artifacts) {
    if (!isSafeCaseSegment(a.case)) {
      diagnostics.push(`case ${a.case}: ${a.kind} withheld — case id is not a path-safe segment`);
      published.push({ case: a.case, kind: a.kind, relPath: '', withheld: 'unsafe-case-id' });
      continue;
    }
    const cap = a.kind === 'patch' ? MAX_PATCH_BYTES : MAX_OUTPUT_BYTES;
    let content = a.content;
    let truncated = false;
    const full = Buffer.byteLength(content, 'utf8');
    if (full > cap) {
      // Byte cap, not UTF-16 code units: slice the UTF-8 buffer and walk back
      // to the last complete code point, so the retained prefix never ends on
      // a split multibyte sequence (a decoded prefix that re-encodes shorter
      // than the slice means the slice cut a code point).
      const buf = Buffer.from(content, 'utf8');
      let end = cap;
      let prefix = buf.subarray(0, end).toString('utf8');
      while (end > 0 && Buffer.byteLength(prefix, 'utf8') !== end) {
        end -= 1;
        prefix = buf.subarray(0, end).toString('utf8');
      }
      content = prefix + truncationMarker(full, cap);
      truncated = true;
      diagnostics.push(`case ${a.case}: ${a.kind} truncated at ${cap} bytes (full ${full})`);
    }
    const relPath = a.kind === 'patch' ? `patches/${a.case}.patch` : `outputs/${a.case}.json`;
    const match = findDenylistMatch(content, relPath, rules);
    if (match !== undefined) {
      diagnostics.push(`case ${a.case}: ${a.kind} withheld — denylist ${match.id} matched`);
      published.push({
        case: a.case,
        kind: a.kind,
        relPath,
        withheld: match.id,
        ...(truncated ? { truncated: true } : {}),
      });
      continue;
    }
    const abs = join(outDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    published.push({ case: a.case, kind: a.kind, relPath, ...(truncated ? { truncated: true } : {}) });
  }
  return { published, diagnostics };
}

/** F6 run manifest — the suite identity + toolkit/suite provenance a regrade needs. */
export interface RunManifestEntry {
  role: string;
  suite: string;
  /** repo-root-relative suite directory (e.g. "suites/fixer-worker/micro"). */
  suiteDir: string;
  model: string;
  driver: string;
  variant: string;
  /** the pinned toolkit.lock value at run time (null when the file is absent). */
  toolkitLock: string | null;
  /** the suite checkout's git SHA (null when unknown). */
  suiteSha: string | null;
  runId: string;
  generatedAt: string;
  /** F1b (WB-1): non-model driver causes classified as dispatch-only
   * absences — those cases published NO row. SURFACED BY `run.json` so the
   * workflow can render a warning + step summary + DISPATCH-ONLY marker
   * instead of publishing a driver-error zero. */
  absences?: Array<{ case: string; cause: string }>;
}

export interface RunManifest {
  runs: RunManifestEntry[];
}

/** Write `<outDir>/run.json` — one entry per suite run (a process may run several). */
export function writeRunManifest(outDir: string, entries: readonly RunManifestEntry[]): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({ runs: entries }, null, 2) + '\n');
}
