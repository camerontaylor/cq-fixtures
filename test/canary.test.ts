import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANARY_RECIPES } from '../catalog/canary-recipes.ts';
import { CASE_RECIPES } from '../catalog/recipes.ts';
import { checkCanaries } from '../catalog/generate-canaries.ts';
import { discoverFixerCases } from '../catalog/corpus.ts';
import { loadFaultForFixture } from '../catalog/fault.ts';
import { isFixerCase, loadSuite } from '../runner/suite.ts';

// F7 slice B: the contamination canaries are STATIC here — no judge or
// breadth execution. They prove the four canary cases exist, are record-backed
// with public-bug provenance, are kept OUT of the breadth mix, are discovered
// only under their own suite, and that the committed corpus still matches the
// recipes. Their both-states + adequacy execution is covered by the
// discovery-driven gate in test/breadth.test.ts (and catalog/gate.ts --all).

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CANARY_SUITE_DIR = join(REPO_ROOT, 'suites', 'fixer-worker', 'canary');
const CANARY_REL = 'suites/fixer-worker/canary';
const CANARY_IDS = CANARY_RECIPES.map((r) => r.id);

describe('contamination canaries (F7 slice B)', () => {
  it('defines exactly the four canary-01..04 recipes', () => {
    expect(CANARY_IDS).toEqual(['canary-01', 'canary-02', 'canary-03', 'canary-04']);
  });

  it('every canary record carries origin public-bug-canary with a reference and a license', () => {
    for (const recipe of CANARY_RECIPES) {
      const record = loadFaultForFixture(REPO_ROOT, `fixtures/${recipe.id}`);
      expect(record.provenance.origin, recipe.id).toBe('public-bug-canary');
      expect(record.provenance.reference, `${recipe.id} reference`).toBeTruthy();
      expect(record.provenance.license, `${recipe.id} license`).toBeTruthy();
    }
  });

  it('keeps every canary id out of the breadth CASE_RECIPES', () => {
    for (const id of CANARY_IDS) expect(CASE_RECIPES.some((r) => r.id === id), id).toBe(false);
    expect(CASE_RECIPES.some((r) => r.id.startsWith('canary-'))).toBe(false);
  });

  it('discovers the canary cases only under suites/fixer-worker/canary', () => {
    expect(loadSuite(CANARY_SUITE_DIR).cases.filter(isFixerCase)).toHaveLength(4);
    const discovered = discoverFixerCases(REPO_ROOT);
    const found = discovered.filter((c) => CANARY_IDS.includes(c.caseId));
    expect(found.map((c) => c.caseId).sort()).toEqual([...CANARY_IDS].sort());
    for (const c of found) {
      expect(c.suiteRel, c.caseId).toBe(CANARY_REL);
      expect(c.recordBacked, c.caseId).toBe(true);
    }
    expect(discovered.filter((c) => CANARY_IDS.includes(c.caseId) && c.suiteRel !== CANARY_REL)).toEqual([]);
  });

  it('the canary generator --check function returns no mismatches', () => {
    const mismatches = checkCanaries();
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});
