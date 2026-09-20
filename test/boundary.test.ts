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
//
// The scan covers BOTH the runner sources AND the built dist/ output
// (`npm run build`, tsconfig.build.json): the bare-specifier discipline
// must survive compilation — a bundler or emit step that rewrote imports
// into deep paths would break the package boundary exactly where CI stops
// looking if only sources were scanned.

const RUNNER_DIR = fileURLToPath(new URL('../runner', import.meta.url));
const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));

// dist/ is gitignored build output, produced by `npm run build` before
// `npm test` (CI builds first). The scan FAILS when dist/ is absent or
// holds no .js: a missing build must never read as a clean boundary.
function distEntries(): Array<{ label: string; path: string }> {
  let files: string[];
  try {
    files = readdirSync(DIST_DIR, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.js'))
      .sort();
  } catch {
    throw new Error('boundary scan: dist/ is missing — run `npm run build` before `npm test` (CI builds before testing)');
  }
  return files.map((f) => ({ label: `dist/${f.replaceAll('\\', '/')}`, path: join(DIST_DIR, f) }));
}

const SCANNED_FILES: Array<{ label: string; path: string }> = [
  ...readdirSync(RUNNER_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => ({ label: `runner/${f.replaceAll('\\', '/')}`, path: join(RUNNER_DIR, f) })),
  ...distEntries(),
  { label: 'scripts/pack-toolkit.sh', path: fileURLToPath(new URL('../scripts/pack-toolkit.sh', import.meta.url)) },
  { label: 'scripts/flip-to-published.sh', path: fileURLToPath(new URL('../scripts/flip-to-published.sh', import.meta.url)) },
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
  it('no runner source, built dist output, or packaging script contains a toolkit deep-import or relative escape', () => {
    const violations = findViolations();
    const report = violations
      .map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`)
      .join('\n');
    expect(violations, `boundary violations:\n${report}`).toEqual([]);
  });

  it('scans the real runner surface, sources and build (guard against the scan going empty)', () => {
    // If the runner/ tree, the dist/ build, or a script moved, the scan
    // above would silently pass over nothing — keep it honest. Source and
    // dist counts are asserted SEPARATELY: a present-but-unbuilt dist/
    // must not hide behind the source count.
    const sources = SCANNED_FILES.filter((f) => f.label.startsWith('runner/'));
    const built = SCANNED_FILES.filter((f) => f.label.startsWith('dist/'));
    expect(sources.length).toBeGreaterThanOrEqual(7);
    expect(sources.some((f) => f.label === 'runner/index.ts')).toBe(true);
    // Eight runner modules emit (index, cli, aggregate, suite,
    // fake-driver, dimensions/schemaCompliance, score/fixerWorker,
    // score/reviewClassifier): fewer means the build dropped a module.
    expect(built.length).toBeGreaterThanOrEqual(8);
    expect(built.some((f) => f.label === 'dist/index.js')).toBe(true);
    expect(built.some((f) => f.label === 'dist/cli.js')).toBe(true);
    expect(SCANNED_FILES.some((f) => f.label === 'scripts/pack-toolkit.sh')).toBe(true);
    expect(SCANNED_FILES.some((f) => f.label === 'scripts/flip-to-published.sh')).toBe(true);
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
