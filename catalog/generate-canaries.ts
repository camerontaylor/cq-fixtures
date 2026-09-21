// Canary-fixture generator (plan WB-6, F7 slice B). `CANARY_RECIPES`
// (catalog/canary-recipes.ts) are four synthetic reproductions of well-known
// public bug classes; this module materializes `fixtures/canary-01..04/` +
// `fixtures/canary-0N.FAULT.json` and the separate, never-headline
// `suites/fixer-worker/canary/suite.json`. It reuses `renderCase`/`caseEntry`
// from the breadth generator (catalog/generate-cases.ts), so a canary is
// materialized by the identical deterministic path as a breadth case.
//
// Run `--write` to (re)generate the committed canary corpus and `--check` to
// prove the committed corpus still matches the recipes (CI). Generation is
// authoring tooling only: it never runs the filter chain — catalog/pipeline.ts
// is what proves each canary is red-buggy / green-fixed.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CANARY_RECIPES } from './canary-recipes.ts';
import { REPO_ROOT, caseEntry, checkCase, renderCase } from './generate-cases.ts';

const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');
const CANARY_SUITE_DIR = join(REPO_ROOT, 'suites', 'fixer-worker', 'canary');
const CANARY_SUITE_FILE = join(CANARY_SUITE_DIR, 'suite.json');

interface CanarySuite {
  name: string;
  role: 'fixer-worker';
  provenance: { origin: string; reference: string };
  cases: Array<ReturnType<typeof caseEntry>>;
}

const SUITE_PROVENANCE = {
  origin:
    'public-bug-canary: four synthetic reproductions of well-known public bug classes (F7 slice B, 2026-09-21); reported separately from the headline breadth corpus; no content vendored',
  reference:
    'public bug classes only — half-open interval off-by-one; defensive-copy aliasing; missing-radix parseInt; prototype pollution (behavior of lodash CVE-2019-10744 / CVE-2018-3721); no code copied',
};

/** The canary suite document (schema/suite.schema.json shape) for the recipes. */
export function canarySuiteDoc(): CanarySuite {
  return {
    name: 'canary',
    role: 'fixer-worker',
    provenance: { ...SUITE_PROVENANCE },
    cases: CANARY_RECIPES.map(caseEntry),
  };
}

function writeCase(recipe: (typeof CANARY_RECIPES)[number]): void {
  const { files, fault } = renderCase(recipe);
  const fixtureDir = join(FIXTURES_DIR, recipe.id);
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const [rel, content] of files) {
    const target = join(fixtureDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(join(FIXTURES_DIR, `${recipe.id}.FAULT.json`), JSON.stringify(fault, null, 2) + '\n');
}

/** Materialize every canary fixture + record and sync the canary suite.json. */
export function writeCanaries(): void {
  for (const recipe of CANARY_RECIPES) writeCase(recipe);
  mkdirSync(CANARY_SUITE_DIR, { recursive: true });
  writeFileSync(CANARY_SUITE_FILE, JSON.stringify(canarySuiteDoc(), null, 2) + '\n');
}

const CANARY_IDS = new Set<string>(CANARY_RECIPES.map((r) => r.id));

/** Verify the committed canary suite.json entries match the recipes. */
function checkSuiteEntries(): string[] {
  const mismatches: string[] = [];
  let doc: CanarySuite;
  try {
    doc = JSON.parse(readFileSync(CANARY_SUITE_FILE, 'utf8')) as CanarySuite;
  } catch {
    return ['suites/fixer-worker/canary/suite.json: missing or unparseable'];
  }
  const expected = canarySuiteDoc();
  if (doc.name !== expected.name || doc.role !== expected.role || JSON.stringify(doc.provenance) !== JSON.stringify(expected.provenance)) {
    mismatches.push('suites/fixer-worker/canary/suite.json: suite header differs from the canary generator');
  }
  for (const recipe of CANARY_RECIPES) {
    const entry = doc.cases.find((c) => c.id === recipe.id);
    if (entry === undefined) mismatches.push(`${recipe.id}: not in the canary suite`);
    else if (JSON.stringify(entry) !== JSON.stringify(caseEntry(recipe))) mismatches.push(`${recipe.id}: suite.json entry differs from the recipe`);
  }
  for (const id of doc.cases.map((c) => c.id)) {
    if (!CANARY_IDS.has(id)) mismatches.push(`${id}: in the canary suite but not a canary recipe`);
  }
  return mismatches;
}

/** Return human-readable mismatches between the recipes and the committed canaries. */
export function checkCanaries(): string[] {
  return [...CANARY_RECIPES.flatMap(checkCase), ...checkSuiteEntries()];
}

function main(argv: readonly string[]): number {
  const mode = argv[0];
  if (mode !== '--write' && mode !== '--check') {
    console.error('usage: node --experimental-strip-types catalog/generate-canaries.ts --write|--check');
    return 2;
  }
  if (mode === '--write') {
    writeCanaries();
    console.log(`generated ${CANARY_RECIPES.length} canary cases and wrote suites/fixer-worker/canary/suite.json`);
    return 0;
  }
  const mismatches = checkCanaries();
  if (mismatches.length > 0) {
    for (const m of mismatches) console.error(`MISMATCH ${m}`);
    return 1;
  }
  console.log(`all ${CANARY_RECIPES.length} canary cases match their recipes`);
  return 0;
}

// Direct-invocation guard: importing this module must stay side-effect free.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
