import { readdirSync, readFileSync, statSync } from 'node:fs';
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
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

// dist/ is gitignored build output, produced by `npm run build` before
// `npm test` (CI builds first). The scan FAILS when dist/ is absent,
// holds no emitted modules, or holds an unexpected emit shape: a missing
// or misshapen build must never read as a clean boundary.
function distEntries(): Array<{ label: string; path: string }> {
  let names: string[];
  try {
    names = readdirSync(DIST_DIR, { recursive: true }).map(String).sort();
  } catch {
    throw new Error('boundary scan: dist/ is missing — run `npm run build` before `npm test` (CI builds before testing)');
  }
  const files = names.filter((f) => /\.(js|cjs|mjs)$/.test(f));
  // Fail closed on unexpected emit shapes: subdirectories are fine, but
  // any other FILE the emit leaves behind (e.g. an inlined bundle) must
  // not slip past the scan.
  const unexpected = names.filter((f) => {
    if (/\.(js|cjs|mjs|map)$/.test(f)) return false;
    try {
      return statSync(join(DIST_DIR, f)).isFile();
    } catch {
      return true;
    }
  });
  if (unexpected.length > 0) {
    throw new Error(`boundary scan: unexpected non-module files in dist/: ${unexpected.join(', ')}`);
  }
  return files.map((f) => ({ label: `dist/${f.replaceAll('\\', '/')}`, path: join(DIST_DIR, f) }));
}

// test/*.test.ts import the toolkit bare today; a test-side deep import
// would false-pass if tests were unscanned. boundary.test.ts itself is
// EXCLUDED: it intentionally contains violation specimens as synthetic
// strings (see the matcher self-test below), which the text scan cannot
// tell apart from real imports.
function testEntries(): Array<{ label: string; path: string }> {
  return readdirSync(TEST_DIR)
    .map(String)
    .filter((f) => f.endsWith('.test.ts') && f !== 'boundary.test.ts')
    .sort()
    .map((f) => ({ label: `test/${f}`, path: join(TEST_DIR, f) }));
}

const SCANNED_FILES: Array<{ label: string; path: string }> = [
  ...readdirSync(RUNNER_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => ({ label: `runner/${f.replaceAll('\\', '/')}`, path: join(RUNNER_DIR, f) })),
  ...testEntries(),
  { label: 'scripts/pack-toolkit.sh', path: fileURLToPath(new URL('../scripts/pack-toolkit.sh', import.meta.url)) },
  { label: 'scripts/flip-to-published.sh', path: fileURLToPath(new URL('../scripts/flip-to-published.sh', import.meta.url)) },
];

const FORBIDDEN: Array<[string, RegExp]> = [
  ['toolkit src deep-import', /@camerontaylor\/cq-toolkit\/src/],
  ['toolkit dist deep-import', /@camerontaylor\/cq-toolkit\/dist/],
  // Only the bare package specifier is allowed: in ANY import form AND
  // any quote style (including backticks) — static `from '...'`, dynamic
  // `import('...')`, `require('...')`, and `export ... from '...'` — the
  // package name followed by '/' or '.' is a subpath/deep-import attempt.
  // One regex covers all the call/keyword shapes; a bare
  // `from '@camerontaylor/cq-toolkit'` never matches because nothing
  // follows the package name.
  [
    'toolkit subpath import in any import form (bare specifier only)',
    /(?:from|import|require)\s*\(\s*['"`]@camerontaylor\/cq-toolkit[/.]|(?:from|import|require)\s*['"`]@camerontaylor\/cq-toolkit[/.]/,
  ],
  // Relative escape into a VENDORED tree: one-or-more `../` chains into
  // `src/`, `vendor/`, or `lib/` — any import form, any spacing, any quote
  // style, with OR without the trailing slash (directory imports like
  // `from '../../src'` must not evade). Deliberately NOT a bare `../`
  // match — intra-runner relatives like `../score/fixerWorker.ts` are
  // legitimate and must not trip the rule; and NOT "any path outside
  // runner/", which no text regex can resolve. `../../../src/` and
  // `../vendor/` are caught; `../score/` is not.
  ['relative escape into a vendored tree (any import form)', /(?:from|import|require)\s*\(?\s*['"`](?:\.\.\/)+(?:src|vendor|lib)(?:\/|["'`]|$)/],
];

interface Violation {
  file: string;
  rule: string;
  line: number;
  text: string;
}

// dist/ entries resolve LAZILY (inside the tests, not at module scope):
// a direct `npx vitest run` without a prior build then fails as a test
// failure with the actionable message, not as a module collection error.
// The source/test/script entries above stay eager — a missing runner/ or
// test/ tree means a broken checkout, and failing loud at import is right.
function allScannedFiles(): Array<{ label: string; path: string }> {
  return [...SCANNED_FILES, ...distEntries()];
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const entry of allScannedFiles()) {
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
    const sources = allScannedFiles().filter((f) => f.label.startsWith('runner/'));
    const built = allScannedFiles().filter((f) => f.label.startsWith('dist/'));
    const tests = allScannedFiles().filter((f) => f.label.startsWith('test/'));
    expect(sources.length).toBeGreaterThanOrEqual(7);
    expect(sources.some((f) => f.label === 'runner/index.ts')).toBe(true);
    // Eight runner modules emit (index, cli, aggregate, suite,
    // fake-driver, dimensions/schemaCompliance, score/fixerWorker,
    // score/reviewClassifier): fewer means the build dropped a module.
    expect(built.length).toBeGreaterThanOrEqual(8);
    expect(built.some((f) => f.label === 'dist/index.js')).toBe(true);
    expect(built.some((f) => f.label === 'dist/cli.js')).toBe(true);
    // Test files import the toolkit bare today; boundary.test.ts itself is
    // excluded (it holds synthetic violation specimens — see testEntries).
    expect(tests.length).toBeGreaterThanOrEqual(8);
    expect(tests.some((f) => f.label === 'test/flip.test.ts')).toBe(true);
    expect(tests.some((f) => f.label === 'test/boundary.test.ts')).toBe(false);
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
      'import(`@camerontaylor/cq-toolkit/sub`);',
      'const m = await import(`@camerontaylor/cq-toolkit/src/internal`);',
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
      'import `@camerontaylor/cq-toolkit`;',
      "export { runSuite } from '@camerontaylor/cq-toolkit';",
    ];
    for (const s of bareImports) {
      expect(subpathRule.test(s), `bare specifier must NOT match: ${s}`).toBe(false);
      expect(srcRule.test(s) || distRule.test(s), `bare specifier must NOT match: ${s}`).toBe(false);
    }
  });

  it('keeps the relative-escape rule honest (any import form, but not bare ../)', () => {
    // A bare `../` match would false-positive on legitimate intra-runner
    // relatives (`../score/fixerWorker.ts`); only the `../../src/`
    // vendored-tree escape counts, in every import spelling.
    const escapes = [
      "import { x } from '../../src/internal';",
      "import { x } from  '../../src/internal';",
      "import { x } from '../../../src/internal';",
      "import { x } from '../vendor/internal';",
      "import { x } from '../../src';",
      "import { x } from '../vendor';",
      "const m = await import('../../src/internal');",
      "const m = require('../../src/internal');",
      "export * from '../../src/internal';",
      'import { x } from `../../src/internal`;',
    ];
    for (const s of escapes) {
      expect(escapeRule.test(s), `escape rule must match: ${s}`).toBe(true);
    }
    const legitimate = [
      "import { x } from '../scoresheet/helper';",
      "import type { ScoreOutcome } from './fixerWorker.ts';",
      "import type { ScoreOutcome } from '../score/fixerWorker.ts';",
      "import { openRunLog } from '@camerontaylor/cq-toolkit';",
    ];
    for (const s of legitimate) {
      expect(escapeRule.test(s), `escape rule must NOT match: ${s}`).toBe(false);
    }
  });
});
