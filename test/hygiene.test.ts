import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCorpusEvidence, discoverFixerCases, FULL_CHAIN_SUITES, BOTH_STATES_SUITES } from '../catalog/corpus.ts';

// F7 hygiene gates (plan WB-6). The STATIC half of the corpus gate: every
// non-deprecated fixer case carries a FAULT.json record with complete
// both-states evidence and a unique single-statement adequacy target, and the
// CI static job runs that inventory. The EXECUTING half lives in
// test/breadth.test.ts (discovery-driven over every record-backed case).
// Slice C adds the policy-doc describe: docs/hygiene-gates.md is the single
// deprecation/quarantine/license/canary policy file, and these tests pin its
// load-bearing phrases, its enforcing paths, and the inert landing zones.

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

// Synthetic repo-root builder for the provenance-placement checks. Nothing is
// executed: `checkCorpusEvidence` is static, so a minimal valid record-backed
// case is enough to isolate one provenance rule at a time.
function writeSyntheticCase(
  root: string,
  opts: { suiteRel: string; caseId: string; fixture: string; provenance: Record<string, unknown> },
): void {
  const { suiteRel, caseId, fixture, provenance } = opts;
  mkdirSync(join(root, suiteRel), { recursive: true });
  mkdirSync(join(root, fixture, 'src'), { recursive: true });
  mkdirSync(join(root, fixture, 'test'), { recursive: true });
  writeFileSync(join(root, fixture, 'src', 'a.ts'), 'export function f(x: number): number {\n  return x + 0;\n}\n');
  writeFileSync(
    join(root, fixture, 'test', 'a.test.ts'),
    "import { it } from 'vitest';\nit('f is identity', () => {});\nit('f stays bounded', () => {});\n",
  );
  writeFileSync(join(root, fixture, 'check.mjs'), '// synthetic probe (never spawned)\n');
  writeFileSync(
    join(root, suiteRel, 'suite.json'),
    JSON.stringify({
      name: suiteRel.split('/').pop(),
      role: 'fixer-worker',
      provenance: { origin: 'test-local synthetic root' },
      cases: [
        { id: caseId, fixture, task: { prompt: 'make the suite pass' }, probe: { kind: 'check-rerun', check: `${fixture}/check.mjs` } },
      ],
    }),
  );
  writeFileSync(
    join(root, `${fixture}.FAULT.json`),
    JSON.stringify({
      bug_type: 'operator misuse',
      failure_symptoms: 'synthetic provenance probe',
      operator: 'equality-boundary',
      difficulty: 'medium',
      provenance,
      validation: {
        f2p: ['f is identity'],
        p2p: ['f stays bounded'],
        fix: { 'src/a.ts': 'export function f(x: number): number {\n  return x;\n}\n' },
      },
      adequacy: { file: 'src/a.ts', delete: 'return x;' },
    }),
  );
}

function withSyntheticRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'cq-hygiene-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('canary provenance placement (F7 review round 1)', () => {
  it('a public-bug-canary record outside suites/fixer-worker/canary is an issue', () => {
    withSyntheticRoot((root) => {
      writeSyntheticCase(root, {
        suiteRel: 'suites/fixer-worker/breadth-tail',
        caseId: 'probe-01',
        fixture: 'fixtures/probe-01',
        provenance: {
          origin: 'public-bug-canary',
          generator: 'canary:public-bug-class',
          seed: 0,
          engine_version: 'synthetic-canary',
          reference: 'a well-known public bug class',
          license: 'no code vendored',
        },
      });
      expect(checkCorpusEvidence(root).issues).toEqual([
        'case suites/fixer-worker/breadth-tail/probe-01: public-bug-canary record must live in suites/fixer-worker/canary',
      ]);
    });
  });

  it('a non-canary record inside suites/fixer-worker/canary is an issue', () => {
    withSyntheticRoot((root) => {
      writeSyntheticCase(root, {
        suiteRel: 'suites/fixer-worker/canary',
        caseId: 'canary-99',
        fixture: 'fixtures/probe-02',
        provenance: { origin: 'operator-catalog', generator: 'catalog:x', seed: 0, engine_version: 'v' },
      });
      expect(checkCorpusEvidence(root).issues).toEqual([
        'case suites/fixer-worker/canary/canary-99: canary suite case must carry provenance.origin public-bug-canary',
      ]);
    });
  });

  it('a public-bug-canary record must name its reference and license', () => {
    withSyntheticRoot((root) => {
      writeSyntheticCase(root, {
        suiteRel: 'suites/fixer-worker/canary',
        caseId: 'canary-98',
        fixture: 'fixtures/probe-03',
        provenance: { origin: 'public-bug-canary', generator: 'canary:public-bug-class', seed: 0, engine_version: 'synthetic-canary' },
      });
      // The schema's `if/then` makes this schema-INVALID before the corpus
      // gate ever sees it, so `loadFaultForFixture` is the failure point here
      // (the runtime canary-reference check in checkCorpusEvidence is
      // belt-and-braces for records that reach it without schema validation).
      const issues = checkCorpusEvidence(root).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('failed fault.schema.json validation');
      expect(issues[0]).toContain("must have required property 'reference'");
      expect(issues[0]).toContain("must have required property 'license'");
    });
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

  it('the canary suite is never a matrix discovery root in suite.yml', () => {
    // Unconditional: this reads the workflow as text and does not depend on
    // the canary suite existing on disk. suite.yml discovers roots explicitly,
    // so the canary suite must never appear among them (it is reported in its
    // own namespace, never in headline breadth tables).
    const suiteYml = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'suite.yml'), 'utf8');
    expect(suiteYml).not.toContain('suites/fixer-worker/canary');
  });

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

describe('explicit pipeline tiering + retired-suite notes (F7 review round 2)', () => {
  it('every discovered record-backed suite is in exactly one tier set', () => {
    const suites = new Set(discoverFixerCases(REPO_ROOT).filter((c) => c.recordBacked).map((c) => c.suiteRel));
    expect(suites.size).toBeGreaterThan(0);
    for (const suiteRel of suites) {
      // Exactly one: neither (untiered) and both (ambiguous) are failures, so
      // `gate --all` and test/breadth.test.ts can never disagree on the mode.
      expect(
        FULL_CHAIN_SUITES.has(suiteRel) !== BOTH_STATES_SUITES.has(suiteRel),
        `${suiteRel} must be in exactly one of FULL_CHAIN_SUITES / BOTH_STATES_SUITES`,
      ).toBe(true);
    }
  });

  it('a record-backed suite in neither tier set is an issue', () => {
    withSyntheticRoot((root) => {
      writeSyntheticCase(root, {
        suiteRel: 'suites/fixer-worker/probe-suite',
        caseId: 'probe-10',
        fixture: 'fixtures/probe-10',
        provenance: { origin: 'operator-catalog', generator: 'catalog:x', seed: 0, engine_version: 'v' },
      });
      expect(checkCorpusEvidence(root).issues).toEqual([
        'suite suites/fixer-worker/probe-suite: record-backed suite is not classified as full-chain or both-states (add it to catalog/corpus.ts FULL_CHAIN_SUITES or BOTH_STATES_SUITES)',
      ]);
    });
  });

  it('a deprecated suite.json without a DEPRECATED.md dated note is an issue', () => {
    withSyntheticRoot((root) => {
      mkdirSync(join(root, 'fixtures'), { recursive: true });
      const suiteDir = join(root, 'suites', 'fixer-worker', 'deprecated', 'old-suite');
      mkdirSync(suiteDir, { recursive: true });
      writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({ name: 'old-suite', role: 'fixer-worker', provenance: {}, cases: [] }));
      expect(checkCorpusEvidence(root).issues).toEqual([
        'suite suites/fixer-worker/deprecated/old-suite: contains suite.json but no DEPRECATED.md dated note',
      ]);
    });
  });

  it('a deprecated suite.json with a dated DEPRECATED.md note is not an issue', () => {
    withSyntheticRoot((root) => {
      mkdirSync(join(root, 'fixtures'), { recursive: true });
      const suiteDir = join(root, 'suites', 'fixer-worker', 'deprecated', 'old-suite');
      mkdirSync(suiteDir, { recursive: true });
      writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({ name: 'old-suite', role: 'fixer-worker', provenance: {}, cases: [] }));
      writeFileSync(join(suiteDir, 'DEPRECATED.md'), '# old-suite — DEPRECATED 2026-09-20\n\n- Date retired: 2026-09-20 (UTC)\n');
      expect(checkCorpusEvidence(root).issues).toEqual([]);
    });
  });

  it('a deprecated suite.json with an undated DEPRECATED.md note is an issue', () => {
    withSyntheticRoot((root) => {
      mkdirSync(join(root, 'fixtures'), { recursive: true });
      const suiteDir = join(root, 'suites', 'fixer-worker', 'deprecated', 'old-suite');
      mkdirSync(suiteDir, { recursive: true });
      writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({ name: 'old-suite', role: 'fixer-worker', provenance: {}, cases: [] }));
      writeFileSync(join(suiteDir, 'DEPRECATED.md'), '# old-suite\n\nRetired; see the replacement suite.\n');
      expect(checkCorpusEvidence(root).issues).toEqual([
        'suite suites/fixer-worker/deprecated/old-suite: DEPRECATED.md has no YYYY-MM-DD retirement date',
      ]);
    });
  });

  it('a quarantined suite.json without a QUARANTINE.md dated note is an issue', () => {
    withSyntheticRoot((root) => {
      mkdirSync(join(root, 'fixtures'), { recursive: true });
      const suiteDir = join(root, 'suites', 'review-classifier', 'quarantine', 'flaky-suite');
      mkdirSync(suiteDir, { recursive: true });
      writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({ name: 'flaky-suite', role: 'review-classifier', provenance: {}, cases: [] }));
      expect(checkCorpusEvidence(root).issues).toEqual([
        'suite suites/review-classifier/quarantine/flaky-suite: contains suite.json but no QUARANTINE.md dated note',
      ]);
    });
  });
});

// F7 slice C: the hygiene policy is a repo artifact, not tribal knowledge.
const HYGIENE_DOC_REL = 'docs/hygiene-gates.md';
const LANDING_ZONES = [
  'suites/fixer-worker/deprecated',
  'suites/fixer-worker/quarantine',
  'suites/review-classifier/deprecated',
  'suites/review-classifier/quarantine',
];

describe('hygiene-gates policy doc (F7 slice C)', () => {
  const doc = readFileSync(join(REPO_ROOT, HYGIENE_DOC_REL), 'utf8');

  it('states every load-bearing policy phrase', () => {
    // Each entry is one policy concept with the spellings a later edit may
    // legitimately choose (ASCII hyphen/apostrophe vs typographic).
    const concepts: Array<[string, string[]]> = [
      ['deprecate-don\'t-renumber', ["deprecate-don't-renumber", "deprecate-don't renumber"]],
      ['the SWT-bench P→P floor', ['10–17%', '10-17%']],
      ['license row', ['license row']],
      ['contamination', ['contamination']],
      ['quarantine', ['quarantine']],
      ['adequacy', ['adequacy']],
      ['both-states', ['both-states']],
    ];
    for (const [concept, spellings] of concepts) {
      expect(spellings.some((s) => doc.includes(s)), concept).toBe(true);
    }
  });

  it('names the enforcing paths and the procedures it prescribes', () => {
    for (const needle of [
      'catalog/pipeline.ts',
      'catalog/gate.ts',
      'catalog/corpus.ts',
      'test/breadth.test.ts',
      'test/hygiene.test.ts',
      '.github/workflows/suite.yml',
      "not -path '*/deprecated/*'",
      'suites/<role>/deprecated/<original-suite>/',
      'suites/<role>/quarantine/<suite>/',
      'DEPRECATED.md',
      'QUARANTINE.md',
      'consecutive green both-states runs',
      'reports/canaries/<model>/<driver>/',
      'node --experimental-strip-types runner/index.ts',
      '--suite suites/fixer-worker/canary',
      '20 percentage points',
      'Vendored: none',
    ]) {
      expect(doc, needle).toContain(needle);
    }
  });

  it('suites/README.md links the policy doc', () => {
    const suitesReadme = readFileSync(join(REPO_ROOT, 'suites', 'README.md'), 'utf8');
    expect(suitesReadme).toContain(`[${HYGIENE_DOC_REL}](../${HYGIENE_DOC_REL})`);
  });

  it('the four landing zones are inert: README only, no suite.json', () => {
    for (const rel of LANDING_ZONES) {
      const dir = join(REPO_ROOT, ...rel.split('/'));
      expect(existsSync(join(dir, 'README.md')), rel).toBe(true);
      expect(readFileSync(join(dir, 'README.md'), 'utf8'), rel).toContain(HYGIENE_DOC_REL);
      expect(readdirSync(dir).includes('suite.json'), rel).toBe(false);
    }
  });
});
