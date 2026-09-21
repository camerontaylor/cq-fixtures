// Corpus discovery + static evidence inventory (plan WB-6 §F7). This module
// walks every suite under `suites/` (skipping `deprecated/` and `quarantine/`
// segments for discovery, but checking those retired suites for their dated
// retirement notes), inventories the FAULT.json records and fixture
// directories the discovered fixer cases reference, and proves the STATIC half
// of the adequacy gate without spawning a judge. `catalog/gate.ts` owns the
// CLI; importing this module is side-effect free.

import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { declaredTitles, duplicateTitles, runCasePipeline, type CaseReport } from './pipeline.ts';
import { faultRecordAbsPath, loadFaultForFixture, type FaultRecord } from './fault.ts';
import { isFixerCase, loadSuite } from '../runner/suite.ts';

/** Suites under these path segments are retired/holding pens, never discovery roots. */
const EXCLUDED_SEGMENTS = new Set(['deprecated', 'quarantine']);
/** The documented hand-seeded, record-less micro suite (phase-3 J3). */
const GRANDFATHERED_MICRO_SUITE = 'suites/fixer-worker/micro';
/**
 * The five grandfathered hand-seeded micro fixtures. Static (not derived from
 * discovery) so a micro fixture dropped from `suite.json` is still exempt from
 * the orphan-fixture check, exactly as the grandfather rule documents.
 */
const GRANDFATHERED_MICRO_FIXTURES = new Set([
  'fixtures/micro-1',
  'fixtures/micro-2',
  'fixtures/micro-3',
  'fixtures/micro-4',
  'fixtures/micro-5',
]);
/** The separate contamination-canary suite; the only home for public-bug-canary records. */
const CANARY_SUITE = 'suites/fixer-worker/canary';

/**
 * Suites the FULL filter chain runs for (both-states + adequacy + determinism
 * ×3 + the format/tell pass). Explicit tiering: `test/breadth.test.ts` used to
 * infer this from an `endsWith('-verified')` heuristic, which silently mis-
 * tiered any future record-backed suite whose name happened not to match.
 */
export const FULL_CHAIN_SUITES = new Set(['suites/fixer-worker/breadth-verified']);
/** Suites the both-states + adequacy chain runs for (no determinism/format pass). */
export const BOTH_STATES_SUITES = new Set(['suites/fixer-worker/breadth-tail', 'suites/fixer-worker/canary']);

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function hasExcludedSegment(repoRel: string): boolean {
  return repoRel.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function walkForSuites(dir: string, repoRoot: string, found: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A missing suites root yields no suites, not a throw.
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === 'suite.json')) found.push(dir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    if (hasExcludedSegment(toPosix(relative(repoRoot, child)))) continue;
    walkForSuites(child, repoRoot, found);
  }
}

/** Every `suites/**` directory carrying a `suite.json`, excluding deprecated/quarantine segments. */
export function discoverSuiteDirs(repoRoot: string): string[] {
  const found: string[] = [];
  walkForSuites(join(repoRoot, 'suites'), repoRoot, found);
  return found.sort();
}

function walkRetiredSuites(dir: string, repoRoot: string, found: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const rel = toPosix(relative(repoRoot, dir));
  if (hasExcludedSegment(rel) && entries.some((e) => e.isFile() && e.name === 'suite.json')) {
    found.push(rel);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    walkRetiredSuites(join(dir, entry.name), repoRoot, found);
  }
}

/**
 * Repo-relative POSIX paths of suites sitting under a `deprecated/` or
 * `quarantine/` segment (the inverse filter of `discoverSuiteDirs`). These are
 * never discovery roots, but a lingering `suite.json` inside one is the signal
 * that its dated retirement note must exist beside it.
 */
export function discoverRetiredSuiteDirs(repoRoot: string): string[] {
  const found: string[] = [];
  walkRetiredSuites(join(repoRoot, 'suites'), repoRoot, found);
  return found.sort();
}

export interface DiscoveredCase {
  readonly suiteDir: string;
  readonly suiteRel: string;
  readonly suiteName: string;
  readonly caseId: string;
  readonly fixture: string;
  readonly recordBacked: boolean;
}

/**
 * Every fixer case in every discovered suite, with its fixture's record
 * status. Legacy (record-less) cases are returned too, flagged
 * `recordBacked: false` — the evidence gate decides whether they are still
 * grandfathered.
 */
export function discoverFixerCases(repoRoot: string): DiscoveredCase[] {
  const discovered: DiscoveredCase[] = [];
  for (const suiteDir of discoverSuiteDirs(repoRoot)) {
    const suite = loadSuite(suiteDir);
    const suiteRel = toPosix(relative(repoRoot, suiteDir));
    for (const c of suite.cases.filter(isFixerCase)) {
      discovered.push({
        suiteDir,
        suiteRel,
        suiteName: suite.name,
        caseId: c.id,
        fixture: c.fixture,
        recordBacked: existsSync(faultRecordAbsPath(repoRoot, c.fixture)),
      });
    }
  }
  return discovered.sort((a, b) =>
    a.suiteRel === b.suiteRel ? a.caseId.localeCompare(b.caseId) : a.suiteRel.localeCompare(b.suiteRel),
  );
}

export interface CorpusIssues {
  readonly issues: string[];
  readonly recordBacked: DiscoveredCase[];
  readonly legacy: DiscoveredCase[];
}

/**
 * The static evidence inventory: no judge runs. Every violation is a string
 * naming the case or fixture it convicts, so the gate is greppable.
 */
export function checkCorpusEvidence(repoRoot: string): CorpusIssues {
  const issues: string[] = [];
  const discovered = discoverFixerCases(repoRoot);
  const recordBacked = discovered.filter((c) => c.recordBacked);
  const legacy = discovered.filter((c) => !c.recordBacked);
  const fixturesDir = join(repoRoot, 'fixtures');

  // 0. Every suite that evidences a record-backed fixer case must be
  // explicitly tiered: full-chain or both-states. Suites with no record-backed
  // cases (micro's grandfathered hand-seeded set, the classifier suites) are
  // exempt. The membership test is `exactly one of the two sets`, so a suite
  // accidentally listed in BOTH is an issue too.
  for (const suiteRel of [...new Set(recordBacked.map((c) => c.suiteRel))].sort()) {
    if (FULL_CHAIN_SUITES.has(suiteRel) === BOTH_STATES_SUITES.has(suiteRel)) {
      issues.push(
        `suite ${suiteRel}: record-backed suite is not classified as full-chain or both-states (add it to catalog/corpus.ts FULL_CHAIN_SUITES or BOTH_STATES_SUITES)`,
      );
    }
  }

  // 1. Every record must be referenced by EXACTLY ONE discovered fixer case.
  const recordRefs = new Map<string, number>();
  for (const c of recordBacked) {
    const rel = toPosix(relative(repoRoot, faultRecordAbsPath(repoRoot, c.fixture)));
    recordRefs.set(rel, (recordRefs.get(rel) ?? 0) + 1);
  }
  const records = readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.FAULT.json'))
    .sort();
  for (const name of records) {
    const rel = `fixtures/${name}`;
    const refs = recordRefs.get(rel) ?? 0;
    if (refs === 0) issues.push(`orphan record ${rel}`);
    else if (refs > 1) issues.push(`record ${rel} referenced by ${refs} cases`);
  }

  // 2 + 3. Per record-backed case: parse/validate, both-states bands, a
  // faulted-different fix, exactly-once adequacy, and declared-title truth.
  for (const c of recordBacked) {
    const label = `${c.suiteRel}/${c.caseId}`;
    let record: FaultRecord;
    try {
      record = loadFaultForFixture(repoRoot, c.fixture);
    } catch (e) {
      issues.push(`case ${label}: ${(e as Error).message}`);
      continue;
    }
    // Canary provenance placement: a public-bug-canary record lives ONLY in the
    // separate canary suite, and that suite carries ONLY public-bug-canary
    // records — the two are each other's proof of separation. A canary record
    // must also name its public reference and license (no code vendored).
    if (record.provenance.origin === 'public-bug-canary' && c.suiteRel !== CANARY_SUITE) {
      issues.push(`case ${label}: public-bug-canary record must live in ${CANARY_SUITE}`);
    }
    if (c.suiteRel === CANARY_SUITE && record.provenance.origin !== 'public-bug-canary') {
      issues.push(`case ${label}: canary suite case must carry provenance.origin public-bug-canary`);
    }
    if (record.provenance.origin === 'public-bug-canary') {
      const missing: string[] = [];
      if ((record.provenance.reference ?? '').length === 0) missing.push('provenance.reference');
      if ((record.provenance.license ?? '').length === 0) missing.push('provenance.license');
      if (missing.length > 0) issues.push(`case ${label}: public-bug-canary record must carry ${missing.join(' and ')}`);
    }
    if (record.validation.f2p.length < 1) issues.push(`case ${label}: validation.f2p must list at least one failing title`);
    if (record.validation.p2p.length < 1) issues.push(`case ${label}: validation.p2p must list at least one passing title`);
    if (Object.keys(record.validation.fix).length === 0) issues.push(`case ${label}: validation.fix must be non-empty`);
    for (const [rel, fixed] of Object.entries(record.validation.fix)) {
      let stored: string | undefined;
      try {
        stored = readFileSync(join(repoRoot, c.fixture, rel), 'utf8');
      } catch {
        stored = undefined;
      }
      if (stored === undefined) issues.push(`case ${label}: fix target ${rel} is missing from the fixture`);
      else if (stored === fixed) issues.push(`case ${label}: fix target ${rel} is not faulted`);
    }
    const adequacy = record.adequacy;
    if (adequacy === undefined) {
      issues.push(`case ${label}: adequacy target missing`);
    } else if (!Object.keys(record.validation.fix).includes(adequacy.file)) {
      issues.push(`case ${label}: adequacy.file ${adequacy.file} is not a key of validation.fix`);
    } else {
      const fixed = record.validation.fix[adequacy.file]!;
      const occurrences = fixed.split(adequacy.delete).length - 1;
      if (occurrences !== 1) {
        issues.push(`case ${label}: adequacy.delete occurs ${occurrences} times in ${adequacy.file} (must be exactly once)`);
      }
    }
    const titles = declaredTitles(repoRoot, c.fixture);
    const missingTitles = [...record.validation.f2p, ...record.validation.p2p].filter((title) => !titles.has(title));
    if (missingTitles.length > 0) issues.push(`case ${label}: declared titles missing from the fixture: ${missingTitles.join('; ')}`);
    const dupes = duplicateTitles(repoRoot, c.fixture);
    if (dupes.length > 0) issues.push(`case ${label}: duplicate declared titles: ${dupes.join('; ')}`);
    // Every declared fixture title must be classified: an unlabelled title is
    // invisible to the per-title F2P/P2P gates, so it can never be scored.
    const classified = new Set([...record.validation.f2p, ...record.validation.p2p]);
    for (const t of titles) if (!classified.has(t)) issues.push(`case ${label}: fixture test title not classified as f2p/p2p: ${t}`);
  }

  // 4. A record-less case is a violation unless it is the grandfathered
  // hand-seeded micro set.
  for (const c of legacy) {
    if (c.suiteRel === GRANDFATHERED_MICRO_SUITE) continue;
    issues.push(`case ${c.suiteRel}/${c.caseId}: no fixtures/<name>.FAULT.json record — every new seeded fixture must carry one`);
  }

  // 5. Every fixer fixture directory (a `fixtures/<id>/check.mjs`) must be
  // referenced by a discovered fixer case or be part of the grandfathered set.
  const referencedFixtures = new Set(discovered.map((c) => c.fixture));
  for (const entry of readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(fixturesDir, entry.name, 'check.mjs'))) continue;
    const fixtureRef = `fixtures/${entry.name}`;
    if (!referencedFixtures.has(fixtureRef) && !GRANDFATHERED_MICRO_FIXTURES.has(fixtureRef)) {
      issues.push(`orphan fixture ${entry.name}`);
    }
  }

  // 6. A retired suite (under `deprecated/` or `quarantine/`) is not a
  // discovery root, but if it still carries a `suite.json` it must also carry
  // its dated note — the audit trail is machine-checked, not merely
  // documented. Landing-zone dirs with only a README.md carry no suite.json,
  // so they are exempt.
  for (const suiteRel of discoverRetiredSuiteDirs(repoRoot)) {
    const note = suiteRel.split('/').includes('quarantine') ? 'QUARANTINE.md' : 'DEPRECATED.md';
    const notePath = join(repoRoot, ...suiteRel.split('/'), note);
    if (!existsSync(notePath)) {
      issues.push(`suite ${suiteRel}: contains suite.json but no ${note} dated note`);
    } else if (!/\d{4}-\d{2}-\d{2}/.test(readFileSync(notePath, 'utf8'))) {
      issues.push(`suite ${suiteRel}: ${note} has no YYYY-MM-DD retirement date`);
    }
  }

  return { issues, recordBacked, legacy };
}

/**
 * The corpus gate: static evidence first (cheap, no judge), then the
 * executing pipeline for every record-backed case. Green iff the inventory is
 * clean and every case passes. `opts.full` forces one mode for every case;
 * when omitted, each case is tiered by `FULL_CHAIN_SUITES` membership.
 */
export function runCorpusGate(repoRoot: string, opts?: { full?: boolean }): { issues: string[]; reports: CaseReport[]; failed: number } {
  const evidence = checkCorpusEvidence(repoRoot);
  const issues = [...evidence.issues];
  if (issues.length > 0) return { issues, reports: [], failed: 0 };
  const reports: CaseReport[] = [];
  for (const c of evidence.recordBacked) {
    // An explicit `full` applies to every case (back-compat for callers that
    // want the whole chain). When omitted, tier each case by the same
    // FULL_CHAIN_SUITES membership `test/breadth.test.ts` uses, so the CLI
    // proof and the CI test proof cannot diverge.
    const full = typeof opts?.full === 'boolean' ? opts.full : FULL_CHAIN_SUITES.has(c.suiteRel);
    try {
      reports.push(runCasePipeline(c.fixture, { repoRoot, full }));
    } catch (e) {
      issues.push(`case ${c.suiteRel}/${c.caseId}: ${(e as Error).message}`);
    }
  }
  const failed = reports.filter((report) => !report.pass).length;
  return { issues, reports, failed };
}
