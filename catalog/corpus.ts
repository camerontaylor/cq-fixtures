// Corpus discovery + static evidence inventory (plan WB-6 §F7). This module
// walks every suite under `suites/` (skipping `deprecated/` and `quarantine/`
// segments), inventories the FAULT.json records and fixture directories the
// discovered fixer cases reference, and proves the STATIC half of the
// adequacy gate without spawning a judge. `catalog/gate.ts` owns the CLI;
// importing this module is side-effect free.

import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { declaredTitles, duplicateTitles, runCasePipeline, type CaseReport } from './pipeline.ts';
import { faultRecordAbsPath, loadFaultForFixture, type FaultRecord } from './fault.ts';
import { isFixerCase, loadSuite } from '../runner/suite.ts';

/** Suites under these path segments are retired/holding pens, never discovery roots. */
const EXCLUDED_SEGMENTS = new Set(['deprecated', 'quarantine']);
/** The documented hand-seeded, record-less micro suite (phase-3 J3). */
const GRANDFATHERED_MICRO_SUITE = 'suites/fixer-worker/micro';

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
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
    const segments = toPosix(relative(repoRoot, child)).split('/');
    if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) continue;
    walkForSuites(child, repoRoot, found);
  }
}

/** Every `suites/**` directory carrying a `suite.json`, excluding deprecated/quarantine segments. */
export function discoverSuiteDirs(repoRoot: string): string[] {
  const found: string[] = [];
  walkForSuites(join(repoRoot, 'suites'), repoRoot, found);
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
  const grandfatheredFixtures = new Set(legacy.filter((c) => c.suiteRel === GRANDFATHERED_MICRO_SUITE).map((c) => c.fixture));
  for (const entry of readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(fixturesDir, entry.name, 'check.mjs'))) continue;
    const fixtureRef = `fixtures/${entry.name}`;
    if (!referencedFixtures.has(fixtureRef) && !grandfatheredFixtures.has(fixtureRef)) {
      issues.push(`orphan fixture ${entry.name}`);
    }
  }

  return { issues, recordBacked, legacy };
}

/**
 * The corpus gate: static evidence first (cheap, no judge), then the
 * executing pipeline for every record-backed case. Green iff the inventory is
 * clean and every case passes.
 */
export function runCorpusGate(repoRoot: string, opts?: { full?: boolean }): { issues: string[]; reports: CaseReport[]; failed: number } {
  const evidence = checkCorpusEvidence(repoRoot);
  const issues = [...evidence.issues];
  if (issues.length > 0) return { issues, reports: [], failed: 0 };
  const reports: CaseReport[] = [];
  for (const c of evidence.recordBacked) {
    try {
      reports.push(runCasePipeline(c.fixture, { repoRoot, full: opts?.full ?? true }));
    } catch (e) {
      issues.push(`case ${c.suiteRel}/${c.caseId}: ${(e as Error).message}`);
    }
  }
  const failed = reports.filter((report) => !report.pass).length;
  return { issues, reports, failed };
}
