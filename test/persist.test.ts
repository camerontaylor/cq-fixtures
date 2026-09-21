import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDenylistMatch, loadDenylistRules } from '../runner/denylist.ts';
import {
  MAX_OUTPUT_BYTES,
  MAX_PATCH_BYTES,
  TRUNCATION_MARKER_PREFIX,
  isTruncated,
  publishArtifacts,
} from '../runner/persist.ts';

// F6 (WB-5.2a): the persisted-prediction boundary — bounded, denylist-scanned
// before publication. The denylisted sample tokens are assembled at runtime
// (never written literally here) so the tree denylist scan stays green on this
// file while the matcher is still exercised on the real classes.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// The assembled token is a class:client-names entry in policy/denylist/patterns.yml.
const CLIENT_TOKEN = ['bee', 'dee'].join('');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-fixture-persist-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('denylist artifact scanner (F6)', () => {
  it('parses the repo policy into class rules (non-vacuous)', () => {
    const rules = loadDenylistRules(repoRoot);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.map((r) => r.id)).toContain('class:client-names');
  });

  it('matches a denylisted class token under an ordinary artifact path', () => {
    const rules = loadDenylistRules(repoRoot);
    const match = findDenylistMatch(`a patch mentioning ${CLIENT_TOKEN}`, 'patches/case-1.patch', rules);
    expect(match?.id).toBe('class:client-names');
  });

  it('honors a rule path filter: the .env class does not blanket-match a patch path', () => {
    const rules = loadDenylistRules(repoRoot);
    // class:key-material-env is regex '.+' scoped to *.env paths — any content
    // matches under an .env path, but never under a patch path.
    expect(findDenylistMatch('anything at all', 'patches/case-1.patch', rules)).toBeUndefined();
    expect(findDenylistMatch('anything at all', 'config.env', rules)?.id).toBe('class:key-material-env');
  });

  it('fails closed when a rule id has no parsed regex (a broken policy must not shrink the denylist silently)', () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), 'cq-denylist-bad-'));
    try {
      const policyDir = join(fakeRoot, 'policy', 'denylist');
      mkdirSync(policyDir, { recursive: true });
      writeFileSync(
        join(policyDir, 'patterns.yml'),
        ['rules:', '  - id: class:broken', "    description: 'missing regex'", "    sample: 'x'", 'clean_probes:', "  - 'clean'"].join('\n') + '\n',
      );
      expect(() => loadDenylistRules(fakeRoot)).toThrow(/no parsed regex/);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});

describe('publishArtifacts (F6/WB-5.2a)', () => {
  it('writes patches/<case>.patch and outputs/<case>.json byte-for-byte', () => {
    const patch = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const output = '{\n  "verdict": "resolved"\n}\n';
    const { published, diagnostics } = publishArtifacts(
      root,
      [
        { case: 'case-1', kind: 'patch', content: patch },
        { case: 'case-1', kind: 'output', content: output },
      ],
      repoRoot,
    );
    expect(diagnostics).toEqual([]);
    expect(published).toHaveLength(2);
    expect(readFileSync(join(root, 'patches', 'case-1.patch'), 'utf8')).toBe(patch);
    expect(readFileSync(join(root, 'outputs', 'case-1.json'), 'utf8')).toBe(output);
  });

  it('withholds a denylisted artifact, writes nothing, and diagnoses the rule', () => {
    const dirty = `the worker echoed ${CLIENT_TOKEN} into its notes\n`;
    const { published, diagnostics } = publishArtifacts(
      root,
      [
        { case: 'case-2', kind: 'output', content: dirty },
        { case: 'case-2', kind: 'patch', content: 'clean patch\n' },
      ],
      repoRoot,
    );
    expect(existsSync(join(root, 'outputs', 'case-2.json'))).toBe(false);
    expect(existsSync(join(root, 'patches', 'case-2.patch'))).toBe(true);
    expect(published.find((p) => p.kind === 'output')?.withheld).toBe('class:client-names');
    expect(diagnostics.some((d) => d.includes('withheld') && d.includes('class:client-names'))).toBe(true);
  });

  it('truncates an over-cap patch with the marker (never publishes unbounded bytes)', () => {
    const big = 'x'.repeat(MAX_PATCH_BYTES + 32);
    const { published, diagnostics } = publishArtifacts(root, [{ case: 'case-3', kind: 'patch', content: big }], repoRoot);
    expect(published[0]!.truncated).toBe(true);
    expect(diagnostics.some((d) => d.includes('truncated'))).toBe(true);
    const written = readFileSync(join(root, 'patches', 'case-3.patch'), 'utf8');
    // Exactly the cap's bytes are kept, then the marker (never the full input).
    expect(written.startsWith('x'.repeat(MAX_PATCH_BYTES))).toBe(true);
    expect(written).toContain(TRUNCATION_MARKER_PREFIX);
    expect(isTruncated(written)).toBe(true);
    expect(written).not.toBe(big);
  });

  it('caps multibyte content on a code-point boundary (never splits a UTF-8 sequence)', () => {
    // Each 'é' is 2 UTF-8 bytes, so a code-unit slice at the cap would split one.
    const big = 'é'.repeat(MAX_OUTPUT_BYTES);
    const { published } = publishArtifacts(root, [{ case: 'case-4', kind: 'output', content: big }], repoRoot);
    expect(published[0]!.truncated).toBe(true);
    const written = readFileSync(join(root, 'outputs', 'case-4.json'), 'utf8');
    const [prefixWithNewline] = written.split(TRUNCATION_MARKER_PREFIX);
    const retained = prefixWithNewline.replace(/\n$/, '');
    expect(Buffer.byteLength(retained, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(retained.endsWith('\uFFFD')).toBe(false);
  });
});
