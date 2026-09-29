#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VISIBLE_ENTRYPOINTS = [
  'campaigns/cq-settings/corpus/review-loop-task.ts',
  'runner/workflow-corpus/review-loop-suite.ts',
  'runner/native/run-visible-g1.ts',
  'runner/native/workspace-conformance.ts',
  'runner/index.ts',
  'runner/native/visible-g1-codex-driver.ts',
  'schema/result-row.schema.json',
  'schema/comparison-table.schema.json',
];
const IMPLICIT_RUNTIME_ASSET_SHA256 = Object.freeze({
  'runner/boundary/broker-public-assets/broker.mjs': 'f20f5e3e74b8a3c545f417a03f12b144254bf1f27b57293e5419164d80c2fc6d',
  'runner/boundary/broker-public-assets/config.json': 'c6d8d0b3dba5ac98779663e4cc75b92107fddb14430fc42180f4ec675c0f99b0',
  'schema/suite.schema.json': 'cf9101552cec3fa2f062f6d56235627fd6441307b64cf5506ef9166937fde5ab',
});

function insideRoot(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function resolveImport(root, importer, specifier) {
  const base = resolve(dirname(importer), specifier);
  if (!insideRoot(root, base)) throw new Error(`source import escaped trusted checkout: ${specifier}`);
  const candidates = [base];
  // TypeScript source imports intentionally retain .js spellings for emitted
  // code. Resolve those to the corresponding source file when no JS exists.
  if (/\.(?:m|c)?js$/u.test(base)) {
    const stem = base.replace(/\.(?:m|c)?js$/u, '');
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  candidates.push(...['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'].map((ext) => `${base}${ext}`));
  candidates.push(join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js'), join(base, 'index.json'));
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      if (!insideRoot(root, canonical)) throw new Error(`source import escaped trusted checkout: ${specifier}`);
      return canonical;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('source import escaped')) throw error;
    }
  }
  throw new Error(`relative source import could not be resolved: ${specifier} from ${relative(root, importer)}`);
}

/** Independently derive the local source/data closure, including literal dynamic imports. */
export async function discoverSourceClosure(rootPath, entrypoints) {
  const root = await realpath(rootPath);
  const pending = [];
  for (const entrypoint of entrypoints) {
    const canonical = await realpath(resolve(root, entrypoint));
    if (!insideRoot(root, canonical)) throw new Error(`entrypoint escaped trusted checkout: ${entrypoint}`);
    pending.push(canonical);
  }
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    const rel = relative(root, current).split(sep).join('/');
    if (visited.has(rel)) continue;
    visited.add(rel);
    if (!/\.(?:[cm]?[jt]sx?|json)$/u.test(current)) continue;
    const source = await readFile(current, 'utf8');
    if (/\.json$/u.test(current)) continue;
    const kind = /\.tsx$/u.test(current) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const parsed = ts.createSourceFile(current, source, ts.ScriptTarget.Latest, true, kind);
    const imports = new Set();
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.add(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        imports.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      pending.push(await resolveImport(root, current, specifier));
    }
  }
  return [...visited].sort();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Pin runtime assets loaded through filesystem/URL conventions, not imports. */
export async function verifyImplicitRuntimeAssets(rootPath = ROOT, expectedPins = IMPLICIT_RUNTIME_ASSET_SHA256) {
  const root = await realpath(rootPath);
  const verified = {};
  for (const [relativePath, expectedHash] of Object.entries(expectedPins).sort(([left], [right]) => left.localeCompare(right))) {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..') || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new Error(`implicit runtime asset pin is invalid: ${relativePath}`);
    }
    const target = resolve(root, relativePath);
    if (!insideRoot(root, target)) throw new Error(`implicit runtime asset escaped trusted checkout: ${relativePath}`);
    const parts = relativePath.split(/[\\/]/u);
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`implicit runtime asset is symlinked: ${relativePath}`);
    }
    const canonical = await realpath(target);
    if (!insideRoot(root, canonical) || canonical !== target) {
      throw new Error(`implicit runtime asset escaped trusted checkout: ${relativePath}`);
    }
    const stat = await lstat(canonical);
    if (!stat.isFile()) throw new Error(`implicit runtime asset is not a regular file: ${relativePath}`);
    const actualHash = sha256(await readFile(canonical));
    if (actualHash !== expectedHash) throw new Error(`implicit runtime asset content hash differs for ${relativePath}`);
    verified[relativePath] = actualHash;
  }
  return verified;
}

export function assertSameClosure(expected, actual, label = 'source loader') {
  const left = [...new Set(expected)].sort();
  const right = [...new Set(actual)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    const missing = left.filter((path) => !right.includes(path));
    const extra = right.filter((path) => !left.includes(path));
    throw new Error(`${label} closure differs (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
}

export function assertSamePins(expected, actual, label = 'source loader') {
  assertSameClosure(Object.keys(expected), Object.keys(actual), label);
  for (const path of Object.keys(expected).sort()) {
    if (expected[path] !== actual[path]) throw new Error(`${label} content hash differs for ${path}`);
  }
}

/** Require exact pins for a subset of runtime assets in a larger source loader closure. */
export function assertIncludesPins(expected, actual, label = 'source loader') {
  const missing = [];
  const mismatched = [];
  for (const path of Object.keys(expected).sort()) {
    if (!Object.hasOwn(actual, path)) missing.push(path);
    else if (expected[path] !== actual[path]) mismatched.push(path);
  }
  if (missing.length || mismatched.length) {
    throw new Error(`${label} pins differ (missing: ${missing.join(', ') || 'none'}; hash mismatch: ${mismatched.join(', ') || 'none'})`);
  }
}

export async function runPreflight(rootPath = ROOT) {
  const root = await realpath(rootPath);
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !/\.[cm]?tsx?$/u.test(new URL(url).pathname)) return nextLoad(url, context);
      const filename = fileURLToPath(url);
      const source = readFileSync(filename, 'utf8');
      const transformed = ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: true,
          importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
          experimentalDecorators: true,
        },
      });
      return { format: 'module', source: transformed.outputText, shortCircuit: true };
    },
  });
  const [independentClosure, sourceEntrypoint, experiment, finalProfile, implicitRuntimeAssets] = await Promise.all([
    discoverSourceClosure(root, VISIBLE_ENTRYPOINTS),
    import(pathToFileURL(join(root, 'runner/native/run-visible-g1.ts')).href),
    import(pathToFileURL(join(root, 'runner/experiment.ts')).href),
    import(pathToFileURL(join(root, 'runner/native/run-final-profile-g1.ts')).href),
    verifyImplicitRuntimeAssets(root),
  ]);

  if (typeof sourceEntrypoint.runVisibleG1 !== 'function' || typeof sourceEntrypoint.visibleG1SourcePins !== 'function') {
    throw new Error('transformed native source entrypoint is missing its runVisibleG1/source-pin exports');
  }
  if (typeof experiment.suiteTaskId !== 'function') {
    throw new Error('runner/experiment.ts does not export suiteTaskId');
  }

  // This is the same closure function consumed by the native entrypoint when
  // it freezes source pins. Comparing it to an independent AST walk catches
  // stale/omitted prepared assets before any runtime setup can begin.
  const loadedPins = await sourceEntrypoint.visibleG1SourcePins('codex', []);
  const hashes = {};
  for (const path of independentClosure) hashes[path] = sha256(await readFile(join(root, path)));
  assertSamePins(hashes, loadedPins, 'native source-pin loader');

  if (typeof finalProfile.finalProfileG1SourcePins !== 'function') {
    throw new Error('final-profile module is missing its source-pin export');
  }
  const finalProfilePins = await finalProfile.finalProfileG1SourcePins();
  assertIncludesPins(implicitRuntimeAssets, finalProfilePins.pins, 'final-profile runtime pin loader');

  return {
    status: 'preflight-green',
    dispatched: false,
    provisioned: false,
    sourceEntryPoint: 'runner/native/run-visible-g1.ts',
    taskIdExport: 'runner/experiment.ts#suiteTaskId',
    closureCount: independentClosure.length,
    closure: hashes,
    implicitRuntimeAssets,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPreflight().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
