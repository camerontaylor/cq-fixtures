// Deterministic case generator for the F3 breadth corpus (plan WB-2.3). Each
// recipe in `recipes.ts` names a clean substrate and its mutation(s); this
// module materializes `fixtures/<id>/` (faulted) and
// `fixtures/<id>.FAULT.json` (with the canonical fix = the clean substrate
// content). Run `--write` to regenerate the committed corpus and `--check` to
// prove the committed corpus still matches the recipes (CI).
//
// Generation is authoring tooling only: it never runs the filter chain. The
// validation pipeline (`catalog/pipeline.ts`) is what proves each generated
// case is red-buggy / green-fixed.

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_RECIPES, type CaseRecipe } from './recipes.ts';
import type { FaultRecord } from './fault.ts';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUBSTRATES_DIR = join(REPO_ROOT, 'catalog', 'substrates');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((rel) => statSync(join(dir, rel)).isFile());
}

export interface RenderedCase {
  /** fixture-relative path -> file content. */
  readonly files: ReadonlyMap<string, string>;
  /** fixture-relative path -> clean (fixed) content, for mutated files only. */
  readonly fix: ReadonlyMap<string, string>;
  readonly fault: FaultRecord;
}

/** Build a case's faulted files + FAULT.json content without touching disk. */
export function renderCase(recipe: CaseRecipe): RenderedCase {
  const substrateDir = join(SUBSTRATES_DIR, recipe.substrate);
  const files = new Map<string, string>();
  for (const rel of walkFiles(substrateDir)) {
    files.set(rel, readFileSync(join(substrateDir, rel), 'utf8'));
  }
  const fix = new Map<string, string>();
  for (const mutation of recipe.mutations) {
    const current = files.get(mutation.file);
    if (current === undefined) throw new Error(`${recipe.id}: mutation targets missing file '${mutation.file}'`);
    const occurrences = current.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${recipe.id}: '${mutation.find}' must occur exactly once in ${mutation.file} (found ${occurrences})`);
    }
    if (!fix.has(mutation.file)) fix.set(mutation.file, current);
    files.set(mutation.file, current.replace(mutation.find, mutation.replace));
  }
  files.set('package.json', JSON.stringify({ name: recipe.id, private: true, version: '0.0.0', type: 'module' }, null, 2) + '\n');
  // The adequacy target must be a UNIQUE statement in the fixed source — the
  // gate deletes it by first-occurrence replace, so a repeated statement would
  // silently delete the wrong one.
  const adequacySource = fix.get(recipe.adequacy.file) ?? files.get(recipe.adequacy.file) ?? '';
  const adequacyOccurrences = adequacySource.split(recipe.adequacy.delete).length - 1;
  if (adequacyOccurrences !== 1) {
    throw new Error(`${recipe.id}: adequacy.delete must occur exactly once in ${recipe.adequacy.file} (found ${adequacyOccurrences})`);
  }
  files.set(
    'check.mjs',
    `// Thin judge shim for the ${recipe.id} fixture. ALL judge logic lives in the\n` +
      `// shared, never-materialized fixtures/judge-lib.mjs.\n` +
      `import { runVitestJudge } from '../judge-lib.mjs';\n\n` +
      `runVitestJudge({ judgeUrl: import.meta.url, judgeLabel: '${recipe.id} judge' });\n`,
  );
  const fault: FaultRecord = {
    bug_type: recipe.bugType,
    failure_symptoms: recipe.failureSymptoms,
    operator: recipe.operator,
    difficulty: recipe.difficulty,
    provenance: {
      origin: recipe.origin,
      generator: recipe.generator,
      seed: recipe.seed,
      engine_version: recipe.engineVersion,
    },
    validation: {
      f2p: [...recipe.f2p],
      p2p: [...recipe.p2p],
      fix: Object.fromEntries([...fix.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
    adequacy: { file: recipe.adequacy.file, delete: recipe.adequacy.delete },
    tell_audit: { critic: recipe.tellAudit.critic, verdict: recipe.tellAudit.verdict, ...(recipe.tellAudit.notes !== undefined ? { notes: recipe.tellAudit.notes } : {}) },
  };
  return { files, fix, fault };
}

/** The suite case entry for a recipe (schema/suite.schema.json shape). */
export function caseEntry(recipe: CaseRecipe): {
  id: string;
  fixture: string;
  task: { prompt: string; notes: string };
  probe: { kind: 'check-rerun'; check: string };
} {
  return {
    id: recipe.id,
    fixture: `fixtures/${recipe.id}`,
    task: {
      prompt:
        'The workspace at the path below contains a TypeScript package whose vitest suite fails. ' +
        'Fix the source so the vitest suite passes (the scoring harness runs the suite for you; you do not need to install anything). ' +
        `Do not modify the tests. ${recipe.failureSymptoms}`,
      notes: `${recipe.difficulty} · ${recipe.operator} · ${recipe.bugType} · canonical fix in fixtures/${recipe.id}.FAULT.json`,
    },
    probe: { kind: 'check-rerun', check: `fixtures/${recipe.id}/check.mjs` },
  };
}

function writeCase(recipe: CaseRecipe): void {
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

/** Return human-readable mismatches between a recipe and the committed case. */
export function checkCase(recipe: CaseRecipe): string[] {
  const mismatches: string[] = [];
  const { files, fault } = renderCase(recipe);
  const fixtureDir = join(FIXTURES_DIR, recipe.id);
  for (const [rel, content] of files) {
    let committed: string | undefined;
    try {
      committed = readFileSync(join(fixtureDir, rel), 'utf8');
    } catch {
      mismatches.push(`${recipe.id}/${rel}: missing`);
      continue;
    }
    if (committed !== content) mismatches.push(`${recipe.id}/${rel}: content differs from recipe`);
  }
  const faultPath = join(FIXTURES_DIR, `${recipe.id}.FAULT.json`);
  let committedFault: string | undefined;
  try {
    committedFault = readFileSync(faultPath, 'utf8');
  } catch {
    mismatches.push(`${recipe.id}.FAULT.json: missing`);
  }
  if (committedFault !== undefined && committedFault !== JSON.stringify(fault, null, 2) + '\n') {
    mismatches.push(`${recipe.id}.FAULT.json: content differs from recipe`);
  }
  // A committed file the recipe does not produce is drift too (a stale file
  // left behind by an earlier recipe shape would otherwise pass `--check`).
  // walkFiles returns fixture-relative paths.
  let committedFiles: string[] = [];
  try {
    committedFiles = walkFiles(fixtureDir);
  } catch {
    committedFiles = [];
  }
  for (const rel of committedFiles) {
    if (!files.has(rel)) mismatches.push(`${recipe.id}/${rel}: committed but not produced by the recipe`);
  }
  return mismatches;
}

/** Copy a substrate verbatim (used by tooling/tests). */
export function copySubstrate(substrate: string, dest: string): void {
  cpSync(join(SUBSTRATES_DIR, substrate), dest, { recursive: true });
}

export function substrateNames(): string[] {
  return [...new Set(CASE_RECIPES.map((r) => r.substrate))].sort();
}

const SUITE_NAMES = ['breadth-verified', 'breadth-tail'] as const;

interface SuiteDoc {
  name: string;
  role: string;
  provenance: unknown;
  cases: Array<Record<string, unknown>>;
}

function readSuiteDoc(name: string): SuiteDoc {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'suites', 'fixer-worker', name, 'suite.json'), 'utf8')) as SuiteDoc;
}

function suiteNameForCase(id: string): (typeof SUITE_NAMES)[number] {
  const matches = SUITE_NAMES.filter((name) => readSuiteDoc(name).cases.some((c) => c.id === id));
  if (matches.length !== 1) throw new Error(`${id}: expected exactly one suite entry, found ${matches.length}`);
  return matches[0]!;
}

/** Verify each recipe's suite.json case entry matches `caseEntry(recipe)`. */
export function checkSuiteEntries(): string[] {
  const mismatches: string[] = [];
  for (const name of SUITE_NAMES) {
    const cases = readSuiteDoc(name).cases;
    for (const recipe of CASE_RECIPES) {
      const entry = cases.find((c) => c.id === recipe.id);
      if (entry === undefined) continue; // this recipe belongs to the other suite
      if (JSON.stringify(entry) !== JSON.stringify(caseEntry(recipe))) mismatches.push(`${recipe.id}: suite.json entry differs from the recipe`);
    }
  }
  for (const recipe of CASE_RECIPES) {
    const count = SUITE_NAMES.reduce((n, name) => n + readSuiteDoc(name).cases.filter((c) => c.id === recipe.id).length, 0);
    if (count !== 1) mismatches.push(`${recipe.id}: appears in ${count} suites (expected 1)`);
  }
  return mismatches;
}

/** Upsert every recipe's suite.json case entry (the `--write` repair path). */
function writeSuiteEntries(): void {
  const docs = new Map(SUITE_NAMES.map((name) => [name, readSuiteDoc(name)]));
  for (const recipe of CASE_RECIPES) {
    const name = suiteNameForCase(recipe.id);
    const cases = docs.get(name)!.cases;
    const idx = cases.findIndex((c) => c.id === recipe.id);
    const entry = caseEntry(recipe) as unknown as Record<string, unknown>;
    if (idx === -1) cases.push(entry);
    else cases[idx] = entry;
  }
  for (const [name, doc] of docs) {
    writeFileSync(join(REPO_ROOT, 'suites', 'fixer-worker', name, 'suite.json'), JSON.stringify(doc, null, 2) + '\n');
  }
}

function main(argv: readonly string[]): number {
  const mode = argv[0];
  if (mode !== '--write' && mode !== '--check') {
    console.error('usage: node --experimental-strip-types catalog/generate-cases.ts --write|--check');
    return 2;
  }
  if (mode === '--write') {
    for (const recipe of CASE_RECIPES) writeCase(recipe);
    writeSuiteEntries();
    console.log(`generated ${CASE_RECIPES.length} cases and synced their suite entries`);
    return 0;
  }
  const mismatches = [...CASE_RECIPES.flatMap(checkCase), ...checkSuiteEntries()];
  if (mismatches.length > 0) {
    for (const m of mismatches) console.error(`MISMATCH ${m}`);
    return 1;
  }
  console.log(`all ${CASE_RECIPES.length} generated cases match their recipes`);
  return 0;
}

// Direct-invocation guard: importing this module must stay side-effect free.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
