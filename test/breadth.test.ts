import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertRecordOutsideFixture, runCasePipeline, type CaseReport } from '../catalog/pipeline.ts';
import { discoverFixerCases, FULL_CHAIN_SUITES } from '../catalog/corpus.ts';
import { isFixerCase, loadSuite } from '../runner/suite.ts';
import { loadFaultForFixture } from '../catalog/fault.ts';
import { CASE_RECIPES } from '../catalog/recipes.ts';
import { checkCase, checkSuiteEntries } from '../catalog/generate-cases.ts';

// F3 breadth-corpus conformance (plan §5 row F3). `catalog/pipeline.ts` is the
// runnable filter chain: both-states CI for every case (tail) and the full
// chain (determinism ×3, per-title JSON, adequacy, format/tell) for the
// verified tier. The static typecheck gate is the repo's own
// `npm run typecheck` (it includes fixtures/**/*.ts).
//
// These tests spawn real judge/vitest processes; the per-case tests carry
// generous timeouts.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERIFIED_SUITE = join(REPO_ROOT, 'suites', 'fixer-worker', 'breadth-verified');
const TAIL_SUITE = join(REPO_ROOT, 'suites', 'fixer-worker', 'breadth-tail');

const verifiedSuite = loadSuite(VERIFIED_SUITE);
const tailSuite = loadSuite(TAIL_SUITE);
const verifiedCases = verifiedSuite.cases.filter(isFixerCase);
const tailCases = tailSuite.cases.filter(isFixerCase);
const allCases = [...verifiedCases, ...tailCases];

function gateSummary(report: CaseReport): string {
  return report.gates
    .filter((g) => !g.pass)
    .map((g) => `${g.gate}: ${g.detail}`)
    .join('\n');
}

describe('breadth corpus shape (F3 acceptance)', () => {
  it('has 40 cases across breadth-verified 12 + breadth-tail 28', () => {
    expect(verifiedCases).toHaveLength(12);
    expect(tailCases).toHaveLength(28);
    expect(allCases.map((c) => c.id)).toEqual(Array.from({ length: 40 }, (_, i) => `breadth-${String(i + 1).padStart(2, '0')}`));
  });

  it('carries the 16 easy / 16 medium / 8 hard tier mix', () => {
    const tiers = allCases.map((c) => loadFaultForFixture(REPO_ROOT, c.fixture).difficulty);
    expect(tiers.filter((t) => t === 'easy')).toHaveLength(16);
    expect(tiers.filter((t) => t === 'medium')).toHaveLength(16);
    expect(tiers.filter((t) => t === 'hard')).toHaveLength(8);
    expect(verifiedSuite.provenance.origin).toContain('6 easy / 4 medium / 2 hard');
    expect(tailSuite.provenance.origin).toContain('10 easy / 12 medium / 6 hard');
  });

  it('carries the 60/30/10 generation mix (24 catalog / 12 lm / 4 replay)', () => {
    const origins = allCases.map((c) => loadFaultForFixture(REPO_ROOT, c.fixture).provenance.origin);
    expect(origins.filter((o) => o === 'operator-catalog')).toHaveLength(24);
    expect(origins.filter((o) => o === 'lm-injected')).toHaveLength(12);
    expect(origins.filter((o) => o === 'diff-replay')).toHaveLength(4);
  });

  it('keeps every FAULT.json a sibling file outside the materialized fixture dir', () => {
    for (const c of allCases) {
      expect(assertRecordOutsideFixture(REPO_ROOT, c.fixture), `${c.id} record outside fixture`).toBe(true);
      expect(existsSync(join(REPO_ROOT, `${c.fixture}.FAULT.json`)), `${c.id} record exists`).toBe(true);
      expect(existsSync(join(REPO_ROOT, c.fixture, 'FAULT.json')), `${c.id} record not inside fixture`).toBe(false);
    }
  });

  it('the 30 generated cases still match their recipes and suite entries (generator --check)', () => {
    expect(CASE_RECIPES).toHaveLength(30);
    const mismatches = [...CASE_RECIPES.flatMap(checkCase), ...checkSuiteEntries()];
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});

describe('both-states + adequacy CI for every discovered record-backed fixer case (F7)', () => {
  const discovered = discoverFixerCases(REPO_ROOT).filter((c) => c.recordBacked);

  it('discovers every breadth-verified and breadth-tail case (the breadth corpus is a subset)', () => {
    expect(discovered.length).toBeGreaterThanOrEqual(40);
    const known = new Set(discovered.map((c) => `${c.suiteRel}/${c.caseId}`));
    for (const c of verifiedCases) {
      expect(known.has(`suites/fixer-worker/breadth-verified/${c.id}`), `${c.id} discovered`).toBe(true);
    }
    for (const c of tailCases) {
      expect(known.has(`suites/fixer-worker/breadth-tail/${c.id}`), `${c.id} discovered`).toBe(true);
    }
  });

  for (const c of discovered) {
    it(`${c.suiteRel}/${c.caseId}: both-states + adequacy${FULL_CHAIN_SUITES.has(c.suiteRel) ? ' + full chain' : ''}`, () => {
      const report = runCasePipeline(c.fixture, { full: FULL_CHAIN_SUITES.has(c.suiteRel) });
      expect(report.pass, gateSummary(report)).toBe(true);
    }, FULL_CHAIN_SUITES.has(c.suiteRel) ? 300_000 : 180_000);
  }
});
