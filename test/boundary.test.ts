import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Package-boundary conformance: cq-fixtures consumes the toolkit strictly
// through its public npm package surface — the bare specifier
// '@camerontaylor/cq-toolkit' (the exports map exposes only "."), never a
// src/ or dist/ deep import, and never a relative escape into a vendored
// source tree. Scanned as TEXT so the rule holds for comments too: a file
// that merely documents a deep import is already a boundary smell.

const RUNNER_DIR = fileURLToPath(new URL('../runner', import.meta.url));
const SCANNED_FILES: Array<{ label: string; path: string }> = [
  ...readdirSync(RUNNER_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => ({ label: `runner/${f.replaceAll('\\', '/')}`, path: join(RUNNER_DIR, f) })),
  { label: 'scripts/pack-toolkit.sh', path: fileURLToPath(new URL('../scripts/pack-toolkit.sh', import.meta.url)) },
];

const FORBIDDEN: Array<[string, RegExp]> = [
  ['toolkit src deep-import', /@camerontaylor\/cq-toolkit\/src/],
  ['toolkit dist deep-import', /@camerontaylor\/cq-toolkit\/dist/],
  // Only the bare package specifier is allowed: in ANY import form — static
  // `from '...'`, dynamic `import('...')`, `require('...')`, and
  // `export ... from '...'` — the package name followed by '/' or '.' is a
  // subpath/deep-import attempt. One regex covers all the call/keyword
  // shapes; a bare `from '@camerontaylor/cq-toolkit'` never matches because
  // nothing follows the package name.
  [
    'toolkit subpath import in any import form (bare specifier only)',
    /(?:from|import|require)\s*\(\s*['"]@camerontaylor\/cq-toolkit[/.]|(?:from|import|require)\s*['"]@camerontaylor\/cq-toolkit[/.]/,
  ],
  ["relative escape into a source tree (from '../../src/…')", /from ['"]\.\.\/\.\.\/src\//],
];

interface Violation {
  file: string;
  rule: string;
  line: number;
  text: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const entry of SCANNED_FILES) {
    const lines = readFileSync(entry.path, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const [rule, pattern] of FORBIDDEN) {
        if (pattern.test(text)) violations.push({ file: entry.label, rule, line: i + 1, text: text.trim() });
      }
    });
  }
  return violations;
}

describe('toolkit package boundary (public surface only)', () => {
  it('no runner file or pack script contains a toolkit deep-import or relative escape', () => {
    const violations = findViolations();
    const report = violations
      .map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`)
      .join('\n');
    expect(violations, `boundary violations:\n${report}`).toEqual([]);
  });

  it('scans the real runner surface (guard against the scan going empty)', () => {
    // If the runner/ tree or the pack script moved, the scan above would
    // silently pass over nothing — keep it honest.
    expect(SCANNED_FILES.length).toBeGreaterThanOrEqual(7);
    expect(SCANNED_FILES.some((f) => f.label === 'runner/index.ts')).toBe(true);
    expect(SCANNED_FILES.some((f) => f.label === 'scripts/pack-toolkit.sh')).toBe(true);
  });
});

// Self-test for the MATCHER itself, against synthetic strings — not repo
// files — so a regex regression cannot hide behind an accidentally-clean tree.
describe('boundary matcher self-test (synthetic strings)', () => {
  const [srcRule, distRule, subpathRule, escapeRule] = FORBIDDEN.map(([, pattern]) => pattern);

  it('flags every toolkit-internal import form: from / import() / require() / export-from', () => {
    const internalImports = [
      "import { x } from '@camerontaylor/cq-toolkit/src/internal';",
      "import('@camerontaylor/cq-toolkit/src/internal');",
      "require('@camerontaylor/cq-toolkit/dist/x.js');",
      "export * from '@camerontaylor/cq-toolkit/dist/x.js';",
      "export { y } from '@camerontaylor/cq-toolkit/sub';",
      "import '@camerontaylor/cq-toolkit/depth';",
      "const m = await import('@camerontaylor/cq-toolkit/src/internal');",
    ];
    for (const s of internalImports) {
      expect(subpathRule.test(s), `subpath rule must match: ${s}`).toBe(true);
      expect(srcRule.test(s) || distRule.test(s) || subpathRule.test(s), `some rule must match: ${s}`).toBe(true);
    }
  });

  it('still accepts the bare package specifier in every import form', () => {
    const bareImports = [
      "import { runPlan } from '@camerontaylor/cq-toolkit';",
      "import '@camerontaylor/cq-toolkit';",
      "import('@camerontaylor/cq-toolkit').then(m => m);",
      "require('@camerontaylor/cq-toolkit');",
      "export { runSuite } from '@camerontaylor/cq-toolkit';",
    ];
    for (const s of bareImports) {
      expect(subpathRule.test(s), `bare specifier must NOT match: ${s}`).toBe(false);
      expect(srcRule.test(s) || distRule.test(s), `bare specifier must NOT match: ${s}`).toBe(false);
    }
  });

  it('keeps the relative-escape rule honest', () => {
    expect(escapeRule.test("import { x } from '../../src/internal';")).toBe(true);
    expect(escapeRule.test("import { x } from '../../lib/internal';")).toBe(false);
  });
});
