import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCorpusEvidence, discoverFixerCases } from '../catalog/corpus.ts';

// F7 hygiene gates (plan WB-6). The STATIC half of the corpus gate: every
// non-deprecated fixer case carries a FAULT.json record with complete
// both-states evidence and a unique single-statement adequacy target, and the
// CI static job runs that inventory. The EXECUTING half lives in
// test/breadth.test.ts (discovery-driven over every record-backed case).

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

describe('corpus evidence inventory (F7 static gate)', () => {
  it('checkCorpusEvidence reports zero issues for the committed corpus', () => {
    const evidence = checkCorpusEvidence(REPO_ROOT);
    expect(evidence.issues, evidence.issues.join('\n')).toEqual([]);
    expect(evidence.recordBacked.length).toBeGreaterThanOrEqual(40);
  });

  it('every fixtures/*.FAULT.json is referenced exactly once by a discovered case', () => {
    const discovered = discoverFixerCases(REPO_ROOT).filter((c) => c.recordBacked);
    const refs = new Map<string, number>();
    for (const c of discovered) {
      const rel = `${c.fixture}.FAULT.json`;
      refs.set(rel, (refs.get(rel) ?? 0) + 1);
    }
    const records = readdirSync(FIXTURES_DIR)
      .filter((name) => name.endsWith('.FAULT.json'))
      .sort();
    expect(records.length).toBeGreaterThanOrEqual(40);
    for (const name of records) {
      expect(refs.get(`fixtures/${name}`), `fixtures/${name}`).toBe(1);
    }
  });

  it('the only legacy (record-less) cases are the grandfathered micro-1..5 set', () => {
    const evidence = checkCorpusEvidence(REPO_ROOT);
    expect(evidence.legacy.map((c) => c.fixture).sort()).toEqual(
      ['micro-1', 'micro-2', 'micro-3', 'micro-4', 'micro-5'].map((id) => `fixtures/${id}`),
    );
    for (const c of evidence.legacy) expect(c.suiteRel, c.caseId).toBe('suites/fixer-worker/micro');
  });
});

describe('CI static job runs the corpus gate (F7)', () => {
  const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('the static job runs catalog/gate.ts --check after Unit tests', () => {
    const staticStart = ci.indexOf('\n  static:');
    expect(staticStart, 'static job present').toBeGreaterThan(-1);
    const staticBlock = ci.slice(staticStart);
    expect(staticBlock).toContain('Fixture gate — both-states + adequacy evidence (every case)');
    expect(staticBlock).toContain('node --experimental-strip-types catalog/gate.ts --check');
    // The step lands AFTER `Unit tests` (F4 owns the region above it).
    expect(staticBlock.indexOf('Fixture gate —')).toBeGreaterThan(staticBlock.indexOf('- name: Unit tests'));
  });
});

describe('canary separation (F7 Slice B; tolerated until the suite lands)', () => {
  const canarySuiteJson = join(REPO_ROOT, 'suites', 'fixer-worker', 'canary', 'suite.json');

  it('a canary suite, when present, is its own filespace', () => {
    if (!existsSync(canarySuiteJson)) return;
    const discovered = discoverFixerCases(REPO_ROOT);
    const canary = discovered.filter((c) => c.suiteRel === 'suites/fixer-worker/canary');
    expect(canary.length).toBeGreaterThan(0);
    const breadthIds = new Set(
      discovered
        .filter((c) => c.suiteRel.endsWith('breadth-verified') || c.suiteRel.endsWith('breadth-tail'))
        .map((c) => c.caseId),
    );
    for (const c of canary) expect(breadthIds.has(c.caseId), c.caseId).toBe(false);
  });
});
