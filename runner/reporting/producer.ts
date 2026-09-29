// PK14 / D22 + D77: the correction-aware REPORT PRODUCER.
//
// This is the non-test producer that makes the sidecar actually produce a
// report. Everything else under runner/reporting/ is a pure projection with no
// caller; the independent PK14 acceptance recorded `productionConsumption:
// not established` because nothing in the runner invoked
// loadPinnedCorrections / consumeRunReport / aggregateCorrected. This module is
// that caller, and runner/reporting/produce-correction-report.ts is its
// runtime entry point.
//
// What makes it a real producer and not a wrapper around the projection API:
//
//   * the manifest is read from DISK and every pin is re-verified against real
//     bytes before any record is believed;
//   * the artifact resolver reads the FILESYSTEM inside explicitly named roots,
//     never an in-memory map supplied by a caller that could assert agreement;
//   * the run's original rows.jsonl and original published projection are read
//     from disk, hashed, and passed through the consumer verbatim;
//   * re-aggregation runs through the UNCHANGED aggregate lane (aggregate.ts),
//     the same lane that produces every other rate;
//   * the output is written to a caller-named directory, and every write is
//     exclusive, so a run of the producer can never overwrite the historical
//     evidence it is reporting on.
//
// Three disciplines are load-bearing and are not negotiable here:
//
//   1. FAIL CLOSED. An artifact that cannot be read is `unresolvable`, which
//      withholds the affected claim. It is never `0`, never `false`, never
//      "absent therefore fine", and it is never repaired by a later record.
//      run19's six private native artifacts are exactly this case: the public
//      checkout does not carry them, so the corrected completion rate is
//      WITHHELD — not asserted as 0, and the historic literal rate of 1 is
//      never reused in its place.
//   2. NULL IS NOT ZERO. Every absent claim is `null`/absent. An unaccounted
//      resource is `unknown`, never `0`; a missing rate is `null`, never `0`.
//   3. DIMENSIONS STAY SEPARATE. Correctness, format compliance, assigned
//      strategy success and operational completion are distinct axes. A
//      lifecycle correction may retract an OPERATIONAL completion claim; it may
//      never rewrite a correctness outcome. Values a record DECLARES about its
//      own candidate are surfaced under `recordDeclaredOutcomes` and are never
//      merged into the row.
//
// Scope: this producer reads and writes only what its caller names. It does not
// widen the public result-row or comparison-table schemas, does not touch the
// PK00-owned campaign source manifest, and does not read a clock — the as-of
// instant is always an explicit input.

import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { aggregateCorrected, type ResultRow } from '../aggregate.ts';
import { buildCorrectionAwareBoard, renderBoardMarkdown, type CorrectionAwareBoard } from './board.ts';
import { canonicalJson, sha256Hex, type DeriveLifecycleOptions, type SelectionResult } from './corrections.ts';
import {
  consumeRetention,
  consumeRunReport,
  consumeStatus,
  loadPinnedCorrections,
  type ConsumedRetention,
  type ConsumedRunReport,
  type ConsumedStatus,
  type ReportState,
} from './consumer.ts';
import type { CorrectionsManifest, EntryVerification, ManifestEntry, ManifestResolver } from './manifest.ts';
import type { RouteView, StatusViewInput } from './status-view.ts';
import type { ArtifactBinding, Disposition } from './types.ts';

export const PRODUCER_SCHEMA_VERSION = 1;

/** A misuse of the producer, as opposed to evidence that failed to qualify. */
export class ProducerError extends Error {
  constructor(message: string) {
    super(`produce-correction-report: ${message}`);
    this.name = 'ProducerError';
  }
}

// ---------------------------------------------------------------------------
// Filesystem resolvers
// ---------------------------------------------------------------------------

/**
 * Join a manifest-relative path onto a root, refusing anything that escapes it.
 *
 * A pinned path is data, not a location the producer may follow anywhere: an
 * absolute path, a `..` escape, or a SYMLINK is a malformed pin, not a reason
 * to read outside the roots the caller named.
 *
 * Containment is enforced in three layers, because a purely lexical check is
 * not containment at all: `readFileSync` follows symlinks, so a lexical join
 * happily hands back a path whose bytes live somewhere else entirely.
 *
 *   1. The ROOT is canonicalised once per call with `realpath`, and that
 *      canonical directory is the boundary. The operator named the root, so a
 *      symlinked root path is the caller's own choice and its target is the
 *      boundary — what is refused is a link the PINNED PATH introduces.
 *   2. Every path component between the boundary and the target is `lstat`ed
 *      and rejected if it is a symbolic link. Checking only the final
 *      component is not enough: a symlinked directory in the middle of a
 *      pinned path redirects the read just as effectively.
 *   3. The fully resolved target is `realpath`ed and re-checked against the
 *      boundary, so a link swapped in between the walk and the read still
 *      fails closed.
 *
 * A path that does not exist, or that cannot be canonicalised, is `null` —
 * unresolvable, never an empty read and never a silent success.
 */
function resolveWithin(root: string, relativePath: string): string | null {
  if (relativePath.length === 0) return null;
  if (isAbsolute(relativePath)) return null;

  // Layer 1: the canonical boundary.
  const base = realpathOrNull(root);
  if (base === null) return null;

  // Cheap lexical rejection of `..` escapes and absolute paths.
  const lexical = resolve(base, relativePath);
  const rel = relative(base, lexical);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;

  // Layer 2: no symlink anywhere along the pinned path.
  if (hasSymlinkComponent(base, rel)) return null;

  // Layer 3: the resolved target is still inside the boundary.
  const real = realpathOrNull(lexical);
  if (real === null) return null;
  const realRel = relative(base, real);
  if (realRel.length === 0 || realRel.startsWith('..') || isAbsolute(realRel)) return null;

  return lexical;
}

/** The canonical path of an existing file or directory, or null. */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // Absent, or not resolvable. Unresolvable is not absence and not agreement.
    return null;
  }
}

/**
 * True when ANY component of `rel` (relative to the canonical `base`) is a
 * symbolic link. Components are walked one at a time with `lstat`, which does
 * not itself follow links, so a link is observed rather than traversed.
 */
function hasSymlinkComponent(base: string, rel: string): boolean {
  let current = base;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // A component that cannot be stat'd cannot be read either, and the
      // caller's realpath check reports that as unresolvable. It is not an
      // escape, so it is not reported as one.
      return false;
    }
  }
  return false;
}

/**
 * The real manifest resolver: read each pinned record from the root the
 * manifest itself names.
 *
 * `repo` entries resolve inside `repoRoot`; `corpus` entries resolve inside
 * `corpusRoot`. A corpus root that was not supplied resolves to `null`, which
 * the manifest layer records as `unresolvable` — "we were not given it", kept
 * distinct from "it is not there" and from "it matches".
 *
 * Containment is real, not lexical: `resolveWithin` canonicalises the root and
 * rejects any symlinked path component, so a link planted inside a named root
 * cannot redirect this resolver to bytes outside it. A redirected read would
 * otherwise still have to pass the pin's SHA256, but the named-root contract is
 * about WHERE bytes may be read from, and that is enforced here rather than
 * left to a later hash to catch by accident.
 */
export function createManifestResolver(roots: { repoRoot: string; corpusRoot: string | null }): ManifestResolver {
  return (entry: ManifestEntry): Buffer | null => {
    const root = entry.root === 'repo' ? roots.repoRoot : roots.corpusRoot;
    if (root === null || root === undefined) return null;
    const target = resolveWithin(root, entry.path);
    if (target === null) return null;
    try {
      return readFileSync(target);
    } catch {
      return null;
    }
  };
}

/**
 * The real artifact resolver for the evidence a correction names.
 *
 * Only the directories the caller supplies are searched, each searched for the
 * artifact under the path the record itself recorded. No directory is walked
 * and no path is guessed: a correction that names `reportSha256` is asking for
 * a file called `reportSha256`, and if the operator has not placed one there
 * the honest answer is `unresolvable`.
 *
 * With no roots supplied (the default for a public checkout) every named
 * artifact resolves to `null`. That is the correct state for run19's six
 * private native artifacts, and it withholds their claims rather than
 * asserting anything about them.
 *
 * As with the manifest resolver, containment is real rather than lexical: a
 * symlink planted inside a named evidence root is rejected, so an artifact
 * cannot be smuggled in from outside the roots the caller named. The operator
 * who supplies a private artifact directory needs those bytes to BE there.
 */
export function createEvidenceResolver(evidenceRoots: readonly string[] = []): (binding: ArtifactBinding) => Buffer | null {
  if (evidenceRoots.length === 0) return () => null;
  return (binding: ArtifactBinding): Buffer | null => {
    for (const root of evidenceRoots) {
      const target = resolveWithin(root, binding.path);
      if (target === null) continue;
      try {
        return readFileSync(target);
      } catch {
        // Try the next named root; a miss is a miss, never a mismatch.
      }
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Reading the immutable originals
// ---------------------------------------------------------------------------

/** The PK03-owned result row, as persisted in a run's rows.jsonl. */
export interface ProducerRunInput {
  runId: string;
  /**
   * The run's immutable `rows.jsonl`. Supplied verbatim to the consumer and to
   * the aggregate lane. Omit when the run's rows are not in this checkout: the
   * producer then skips re-aggregation and SAYS so, rather than inventing rows
   * or aggregating an empty denominator.
   */
  rowsPath?: string;
  /**
   * The run's immutable published projection, as a flat JSON object of the
   * historic values (`{"table.operationalCompletionRate": 1, ...}`). Read
   * verbatim; the producer never derives a historic value it was not given.
   */
  originalPath?: string;
}

/** Read an immutable original, hashing the exact bytes that were read. */
function readOriginal(path: string | undefined, what: string): { binding: ArtifactBinding; bytes: string } | null {
  if (path === undefined) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new ProducerError(`${what} is not readable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { binding: { path, sha256: sha256Hex(bytes) }, bytes: bytes.toString('utf8') };
}

/** Parse the persisted NDJSON rows. A blank line is not a row. */
function readRows(path: string): ResultRow[] {
  const raw = readFileSync(path, 'utf8');
  const rows: ResultRow[] = [];
  let line = 0;
  for (const text of raw.split('\n')) {
    line += 1;
    const t = text.trim();
    if (t === '') continue;
    try {
      rows.push(JSON.parse(t) as ResultRow);
    } catch (error) {
      throw new ProducerError(`${path} line ${line} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Producing
// ---------------------------------------------------------------------------

export interface ProducerOptions {
  /** Path to the pinned corrections manifest. Read and re-verified from disk. */
  manifestPath: string;
  /** Repository root; the only place a `repo`-rooted pin may be read from. */
  repoRoot: string;
  /**
   * Research corpus root for `corpus`-rooted pins, or null when the corpus was
   * not supplied. Null means every corpus record is unresolved, which is
   * reported and never treated as agreement.
   */
  corpusRoot: string | null;
  /** Directories searched for the private artifacts a correction names. */
  evidenceRoots?: readonly string[];
  runs: readonly ProducerRunInput[];
  /**
   * Explicit as-of instant (RFC3339). Required: the board's timestamp is
   * derived from cited records or from this, and the wall clock is never read.
   */
  asOf: string;
  /**
   * The route each pinned audit speaks for. Explicit, because a route is a
   * scope: an entry with no declared scope is listed as unread rather than
   * rendered as a confident "no".
   */
  scopes: ReadonlyArray<{ entryId: string; route: string; lane: RouteView['lane'] }>;
  /**
   * The lifecycle adapter mapping for legacy records, supplied by the caller.
   * Omitted means the producer declares no mapping: a legacy record then loads
   * with no typed overrides and its retracted projections are WITHHELD rather
   * than silently left at their original values.
   */
  adapter?: DeriveLifecycleOptions;
  /**
   * Directory for the produced report. Omitted means nothing is written and the
   * projection is returned only. Every write is exclusive: an existing file is
   * never overwritten, so a producer run cannot mutate the historical evidence
   * it reports on.
   */
  outDir?: string;
}

/** What re-aggregation did, and whether it ran at all. */
export interface ProducedReaggregation {
  status: 'reaggregated' | 'skipped';
  /** Why re-aggregation did not run, or null when it did. */
  reason: string | null;
  originalTables: number;
  correctedTables: number;
  /**
   * The recomputed rate, or null when the claim is withheld. This is the only
   * rate a consumer may publish; the historic literal is reported beside it
   * for contrast and is never reused.
   */
  correctedCompletionRate: number | null;
}

/** One produced run report. */
export interface ProducedRun {
  runId: string;
  original: { rows: ArtifactBinding | null; projection: ArtifactBinding | null };
  selection: SelectionResult;
  state: ReportState;
  retention: ConsumedRetention;
  reaggregation: ProducedReaggregation;
  /**
   * The raw rows and the corrected rows, hashed. `identical` true means no
   * correction qualified; it is reported so a reader can tell "the correction
   * was withheld" from "the correction changed nothing".
   */
  rowsPreserved: { rawSha256: string; correctedSha256: string; identical: boolean };
  /**
   * Correctness / format / strategy / completion values the PINNED RECORD
   * declares about its own candidate, verbatim and segregated. They are
   * evidence about the record, not about the published row, and this producer
   * never merges them into one.
   */
  recordDeclaredOutcomes: {
    candidateCorrectness: boolean | null;
    formatConformance: boolean | null;
    assignedStrategySuccess: boolean | null;
    normalWorkerCompletion: boolean | null;
  } | null;
  /**
   * The rate claim a consumer may publish, stated once and unambiguously.
   *
   * `ReportState.completionRateWithheld` is a FIELD-level fact: it is true only
   * when a record spoke about the rate and could not replace it. A run whose
   * pinned records never loaded at all has said nothing about the rate, so that
   * field is false while no claim is publishable either. `published` here is
   * the run-level answer, and it is the only one a publisher should read.
   */
  rateClaim: { value: number | null; published: boolean; reason: string };
  /** A consumer that cannot publish the corrected claim must see why. */
  publishable: boolean;
  blockers: Disposition[];
}

export interface ProducedReport {
  schemaVersion: number;
  asOf: string;
  manifest: {
    path: string;
    sha256: string;
    entryCount: number;
    verified: string[];
    unverified: EntryVerification[];
  };
  /** True when EVERY pin verified. False is a reported state, not a throw. */
  pinnedOk: boolean;
  approvedAuthorities: string[];
  runs: ProducedRun[];
  status: ConsumedStatus;
  board: CorrectionAwareBoard;
  /** Files written by this run, with their bytes' hashes. */
  outputs: Array<{ path: string; sha256: string }>;
}

/** A lifecycle record's own declared candidate outcomes, read verbatim. */
function declaredOutcomes(pinned: readonly { record: unknown; document: Record<string, unknown> }[]): ProducedRun['recordDeclaredOutcomes'] {
  const lifecycle = pinned.find((entry) => entry.record !== null);
  if (lifecycle === undefined) return null;
  const doc = lifecycle.document;
  const read = (key: string): boolean | null => (typeof doc[key] === 'boolean' ? (doc[key] as boolean) : null);
  return {
    candidateCorrectness: read('candidateCorrectness'),
    formatConformance: read('formatConformance'),
    assignedStrategySuccess: read('assignedStrategySuccess'),
    normalWorkerCompletion: read('normalWorkerCompletion'),
  };
}

/** The published report document. Deterministic: no clock, no iteration order. */
function reportDocument(report: ProducedReport): Record<string, unknown> {
  return {
    schemaVersion: report.schemaVersion,
    producer: 'runner/reporting/producer.ts',
    asOf: report.asOf,
    manifest: report.manifest,
    pinnedOk: report.pinnedOk,
    approvedAuthorities: report.approvedAuthorities,
    runs: report.runs,
    status: {
      view: report.status.view,
      routes: report.status.routes,
      blockers: report.status.blockers,
      unreadEntries: report.status.unreadEntries,
    },
    board: report.board,
  };
}

/**
 * Produce the correction-aware report for the named runs.
 *
 * The order of operations is the contract: verify the pins, load the records,
 * consume each run's report, re-aggregate the DERIVED rows, consume retention
 * and route status, build the board, and only then write. A pin that does not
 * verify never reaches a row, and a run whose artifacts cannot be read yields a
 * WITHHELD claim rather than a substituted value.
 */
export function produceCorrectionAwareReport(options: ProducerOptions): ProducedReport {
  const { manifestPath, repoRoot, corpusRoot, asOf } = options;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(asOf)) {
    throw new ProducerError(`asOf must be an explicit RFC3339 instant, got '${asOf}'; the wall clock is never read`);
  }

  // 1. The manifest, from disk, with its own bytes hashed for provenance.
  const manifestRead = readOriginal(manifestPath, 'corrections manifest');
  if (manifestRead === null) throw new ProducerError('manifestPath is required');
  let manifest: CorrectionsManifest;
  try {
    manifest = JSON.parse(manifestRead.bytes) as CorrectionsManifest;
  } catch (error) {
    throw new ProducerError(`manifest at ${manifestPath} is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.approvedAuthorities)) {
    throw new ProducerError(`manifest at ${manifestPath} does not declare entries[] and approvedAuthorities[]`);
  }

  // 2. Load the pinned records, fail-closed, from the real filesystem.
  const resolveManifest = createManifestResolver({ repoRoot, corpusRoot });
  const pinned = loadPinnedCorrections(manifest, resolveManifest, options.adapter ? { mapping: options.adapter } : {});
  const resolveEvidence = createEvidenceResolver(options.evidenceRoots ?? []);

  // 3. Consume each named run.
  const produced: ProducedRun[] = [];
  for (const run of options.runs) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run.runId)) {
      throw new ProducerError(`unsafe run id '${run.runId}'`);
    }
    const rowsRead = readOriginal(run.rowsPath, `rows for ${run.runId}`);
    const projectionRead = readOriginal(run.originalPath, `original projection for ${run.runId}`);

    let original: Record<string, unknown> = {};
    if (projectionRead !== null) {
      try {
        const parsed: unknown = JSON.parse(projectionRead.bytes);
        // A flat projection object only. A published table ARRAY would have to
        // be reduced to a single historic rate, and that reduction is a
        // decision this producer does not get to make silently.
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new ProducerError(
            `original projection for ${run.runId} is ${Array.isArray(parsed) ? 'an array' : 'not an object'}; ` +
              'expected a flat object of the historic published values, e.g. {"table.operationalCompletionRate": 1}',
          );
        }
        original = parsed as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ProducerError) throw error;
        throw new ProducerError(`original projection for ${run.runId} is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Rows are passed to the consumer exactly as persisted. A run with no rows
    // in this checkout still gets its selection, retention and withheld
    // claims; it does not get a fabricated denominator.
    const rows: ResultRow[] = rowsRead === null ? [] : readRows(run.rowsPath!);
    const report: ConsumedRunReport<ResultRow> = consumeRunReport<ResultRow>({
      runId: run.runId,
      rows,
      original,
      ...(projectionRead !== null ? { originalRef: projectionRead.binding } : {}),
      corrections: pinned,
      resolveEvidence,
    });

    // Re-aggregation runs through the unchanged aggregate lane, so a corrected
    // rate is recomputed exactly the way every other rate is.
    let reaggregation: ProducedReaggregation;
    if (rowsRead === null) {
      reaggregation = {
        status: 'skipped',
        reason: 'this run\'s rows.jsonl was not supplied, so there is no qualified denominator to re-aggregate over; the rate stays withheld',
        originalTables: 0,
        correctedTables: 0,
        correctedCompletionRate: report.state.correctedCompletionRate,
      };
    } else {
      const tables = aggregateCorrected(report);
      reaggregation = {
        status: 'reaggregated',
        reason: null,
        originalTables: tables.original.length,
        correctedTables: tables.corrected.length,
        correctedCompletionRate: tables.correctedCompletionRate,
      };
    }

    const rawSha256 = sha256Hex(canonicalJson(report.rawRows));
    const correctedSha256 = sha256Hex(canonicalJson(report.correctedRows));
    const retention = consumeRetention({ runId: run.runId, corrections: pinned });
    const declared = declaredOutcomes(pinned.records.filter((entry) => entry.record?.identity.runId === run.runId));
    // Publishable means a corrected claim actually qualified on a WHOLE pinned
    // set. An unverified pin, or a record that never loaded, means the pinned
    // set is not whole, so nothing here is a publishable claim.
    const publishable = report.state.applied && pinned.ok;
    const blockers = [...report.state.blockers, ...retention.blockers];
    const rateClaim: ProducedRun['rateClaim'] = publishable
      ? { value: report.state.correctedCompletionRate, published: true, reason: 'a qualified correction recomputed the rate over the corrected rows' }
      : {
          value: null,
          published: false,
          reason: !pinned.ok
            ? 'the pinned set is not whole, so no claim on it is publishable; unresolved is not absence and not agreement'
            : report.state.completionRateWithheld
              ? 'the correction retracted the rate and could not replace it; the original value is not reused'
              : 'no correction qualified for this run, so no corrected rate exists; the historic literal is not republished as one',
        };

    produced.push({
      runId: run.runId,
      original: { rows: rowsRead?.binding ?? null, projection: projectionRead?.binding ?? null },
      selection: report.selection,
      state: report.state,
      retention,
      reaggregation,
      rowsPreserved: { rawSha256, correctedSha256, identical: rawSha256 === correctedSha256 },
      recordDeclaredOutcomes: declared,
      rateClaim,
      publishable,
      blockers,
    });
  }

  // 4. Route/campaign status, on an explicit as-of and explicit scopes.
  const status = consumeStatus({ corrections: pinned, asOf, scopes: options.scopes });

  // 5. The board, whose markdown is a diff target for stale narrative prose.
  const limitations: string[] = [];
  if (!pinned.ok) {
    limitations.push(
      `${pinned.failures.length} pinned record(s) did not verify; the pinned set is not whole, so every run report on it is incomplete. Unresolved is not absent and not agreement.`,
    );
  }
  for (const run of produced) {
    for (const field of run.state.withheld) {
      limitations.push(`${run.runId}: ${field.field} withheld (${field.reason}) — a withheld claim is not a zero and the original value is not reused`);
    }
  }
  // The board takes the SAME route inputs `consumeStatus` built its view from,
  // so the board cannot drift from the projection it is rendering.
  const statusInput: StatusViewInput = {
    asOf: status.view.asOf,
    routes: status.routes.map((route) => ({ route: route.route, lane: route.lane, claims: route.claims })),
    ...(status.view.campaignComplete.evidence.length > 0 || status.view.campaignComplete.value !== null
      ? {
          campaign: {
            dimension: 'campaignComplete',
            value: status.view.campaignComplete.value,
            record: status.view.campaignComplete.evidence[0] ?? { path: 'unread', sha256: '0'.repeat(64) },
            recordedAt: status.view.campaignComplete.recordedAt[0] ?? null,
          },
        }
      : {}),
  };
  const board = buildCorrectionAwareBoard({
    asOf,
    status: statusInput,
    corrections: produced.map((run) => run.selection),
    retention: produced.flatMap((run) => (run.retention.view === null ? [] : [run.retention.view])),
    limitations,
  });

  const report: ProducedReport = {
    schemaVersion: PRODUCER_SCHEMA_VERSION,
    asOf,
    manifest: {
      path: manifestRead.binding.path,
      sha256: manifestRead.binding.sha256,
      entryCount: manifest.entries.length,
      verified: pinned.verifications.filter((entry) => entry.status === 'verified').map((entry) => entry.id),
      unverified: pinned.verifications.filter((entry) => entry.status !== 'verified'),
    },
    pinnedOk: pinned.ok,
    approvedAuthorities: pinned.approvedAuthorities,
    runs: produced,
    status,
    board,
    outputs: [],
  };

  // 6. Write, exclusively. Nothing here overwrites anything.
  if (options.outDir !== undefined) report.outputs.push(...writeOutputs(options.outDir, report));
  return report;
}

/**
 * Write the produced report beside its board and a manifest of what was
 * written, each with an exclusive open. A refusal is a reported output, not a
 * silent overwrite and not a thrown error: the caller sees exactly which files
 * it may already own.
 */
function writeOutputs(outDir: string, report: ProducedReport): Array<{ path: string; sha256: string }> {
  mkdirSync(outDir, { recursive: true });
  const documents: Array<{ name: string; content: string }> = [
    { name: 'correction-report.json', content: `${JSON.stringify(reportDocument(report), null, 2)}\n` },
    { name: 'correction-board.md', content: `${renderBoardMarkdown(report.board)}\n` },
  ];
  const written: Array<{ path: string; sha256: string }> = [];
  for (const document of documents) {
    const target = join(outDir, document.name);
    try {
      const fd = openSync(target, 'wx');
      try {
        writeSync(fd, document.content);
      } finally {
        closeSync(fd);
      }
    } catch {
      // 'wx' fails when the path already exists. The original bytes are left
      // exactly as they were, and the file is not listed as produced.
      continue;
    }
    written.push({ path: target, sha256: sha256Hex(document.content) });
  }
  if (written.length === documents.length) {
    const manifestPath = join(outDir, 'producer-manifest.json');
    const content = `${JSON.stringify(
      {
        schemaVersion: PRODUCER_SCHEMA_VERSION,
        asOf: report.asOf,
        pinnedOk: report.pinnedOk,
        sourceManifest: report.manifest,
        outputs: written,
        runs: report.runs.map((run) => ({
          runId: run.runId,
          original: run.original,
          publishable: run.publishable,
          historicCompletionRate: run.state.historicCompletionRate,
          correctedCompletionRate: run.rateClaim.value,
          rateClaimPublished: run.rateClaim.published,
          rateClaimReason: run.rateClaim.reason,
          completionRateWithheld: run.state.completionRateWithheld,
        })),
      },
      null,
      2,
    )}\n`;
    try {
      const fd = openSync(manifestPath, 'wx');
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      written.push({ path: manifestPath, sha256: sha256Hex(content) });
    } catch {
      // Same exclusive rule as above.
    }
  }
  return written;
}
