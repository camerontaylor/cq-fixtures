#!/usr/bin/env node
// eval-root — W6.3 (RS-9 §4.3): build the allowlist eval root a run
// dispatches from, and scan it.
//
// RS-9 found that host-reach lanes (subprocess, acp) can read everything on
// the host, and that the CI job excised only test/ and .git. So a run no
// longer dispatches from the checkout: it dispatches from an eval root built
// from an ALLOWLIST (never by deleting a denylist from a copy):
//
//   runner/**/*.ts, schema/{suite,result-row,comparison-table}.schema.json,
//   policy/denylist/patterns.yml, package.json, toolkit.lock,
//   fixtures/judge-lib.mjs, fixtures/judge.vitest.config.mjs,
//   each suite's fixture (a fixture dir's check.mjs, package.json, src/**,
//   test/** — or one thread payload file), each non-deprecated suite.json
//   STRIPPED to id, fixture, task.prompt, probe.kind and probe.check,
//   node_modules/ (moved or copied in), EVAL-ROOT.json (the marker that makes
//   the runner demand --answer-key), and a planted sentinel file.
//
// Everything else — FAULT.json records, label sidecars, catalog/, docs and
// READMEs, PROVENANCE/REPRODUCTION/LABEL-GUIDE, task.notes, probe.expected,
// reports/, test/, .git — never enters the root. The classifier's expected
// verdicts and label-sidecar flags go to a runner-only answer key OUTSIDE the
// root, together with the sentinel token (runner/answerKey.ts).
//
// The scan is the static half of the CI check. It re-derives the allowlist
// from the repo and fails on: any file outside it or differing from its
// source, a forbidden path class, a symlink leaving the root, an
// answer marker in any data file or prompt, a prompt sharing a >= 6-token
// span with its case's fix diff, a stripped suite carrying anything beyond
// the dispatch fields, and (with --key) a key inside the root, a key built for
// another root, a missing sentinel, or a key that does not cover exactly the
// root's classifier cases. The dynamic half is the runner's per-case sentinel
// check (runner/index.ts).
//
// Usage:
//   node scripts/eval-root.mjs build --out <dir> --key <file> [--repo <dir>]
//        [--node-modules copy|move|symlink|skip] [--plant-dir <dir>]...
//   node scripts/eval-root.mjs scan --root <dir> [--key <file>] [--repo <dir>]
// `symlink` is for local tests only (the scan rejects it: the link leads back
// into the checkout). Exit 0 ok; 1 scan problems; 2 usage or build failure.
// Pure node, zero deps: in CI the build MOVES node_modules into the root.

import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** Mirrors runner/answerKey.ts EVAL_ROOT_MARKER (parity-tested). */
export const EVAL_ROOT_MARKER = 'EVAL-ROOT.json';
const MARKER_DOC = { kind: 'cq-eval-root', version: 1 };

/** Runner and judge support files, copied byte-for-byte (none carries an answer). */
export const CODE_FILES = [
  'package.json',
  'toolkit.lock',
  'policy/denylist/patterns.yml',
  'schema/suite.schema.json',
  'schema/result-row.schema.json',
  'schema/comparison-table.schema.json',
  'fixtures/judge-lib.mjs',
  'fixtures/judge.vitest.config.mjs',
];
const SUITE_ROLES = ['fixer-worker', 'review-classifier'];
const NON_SUITE_DIRS = new Set(['deprecated', 'quarantine']);
/** What a fixture directory may hold (RS-9 §2: check shim, package.json, src/**, test/**). */
const FIXTURE_ENTRY = /^(check\.mjs|package\.json|src\/.+|test\/.+)$/;
const NODE_MODULES_MODES = new Set(['copy', 'move', 'symlink', 'skip']);

/** RS-9 §4.3 A: path classes that must never be in a root, checked independently of the allowlist. */
const FORBIDDEN_PATHS = [
  [/\.FAULT\.json$/, 'fault record (validation.fix, adequacy, tell_audit)'],
  [/\.label\.json$/, 'classifier label sidecar'],
  [/^catalog(\/|$)/, 'catalog/ (substrates hold fixed sources; recipes hold find/replace pairs)'],
  [/\.md$/i, 'docs / README / PROVENANCE / REPRODUCTION / LABEL-GUIDE / DECISIONS'],
  [/^docs(\/|$)/, 'docs/'],
  [/^reports(\/|$)/, 'reports/ (snapshot rows carry probes[].expected)'],
  [/^test(\/|$)/, 'test/ (micro reference fixes)'],
  [/(^|\/)\.git(\/|$)/, '.git (history holds every excised file)'],
  [/^(scripts|\.github)(\/|$)/, 'repo tooling'],
];

/** RS-9 §4.3 D: answer markers no data file or prompt may carry. */
const ANSWER_MARKERS = [
  [/\bFAULT\b/, 'FAULT'],
  [/canonical fix/i, 'canonical fix'],
  [/\.label\.json/, '.label.json'],
  [/"expected"\s*:/, '"expected" key'],
  [/\bcatalog\//, 'catalog/ path'],
  [/"validation"\s*:|validation\.fix/, 'validation.fix'],
  [/failure_symptoms|tell_audit|"adequacy"\s*:/, 'fault-record field'],
  [/fp_flag|concern_group|adjudicat/, 'label-sidecar field'],
  [/"notes"\s*:/, 'task.notes'],
];
const PROMPT_MARKERS = [...ANSWER_MARKERS, [/\bfixtures\//, 'fixture path']];
/** RS-9 §4.3 D: a prompt may not share a span this long with its fix diff. */
export const FIX_SPAN_TOKENS = 6;

class UsageError extends Error {}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function jsonText(doc) {
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Every regular file under `dir`, as `/`-joined paths relative to `base`, sorted; symlinks reported. */
function walk(dir, base = dir, out = { files: [], links: [] }) {
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    const rel = abs.slice(base.length + 1).split(sep).join('/');
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out.links.push(rel);
    else if (st.isDirectory()) walk(abs, base, out);
    else if (st.isFile()) out.files.push(rel);
  }
  return out;
}

/** The non-deprecated suite dirs (repo-relative) of a tree. */
export function discoverSuites(root) {
  const found = [];
  for (const role of SUITE_ROLES) {
    const roleDir = join(root, 'suites', role);
    if (!existsSync(roleDir)) continue;
    for (const name of readdirSync(roleDir).sort()) {
      if (NON_SUITE_DIRS.has(name)) continue;
      if (existsSync(join(roleDir, name, 'suite.json'))) found.push(`suites/${role}/${name}`);
    }
  }
  return found;
}

/** RS-9 §4.3 A.5: a suite reduced to what dispatch needs — no notes, no expected, no provenance detail. */
export function stripSuite(doc) {
  return {
    name: doc.name,
    role: doc.role,
    ...(doc.servedModel !== undefined ? { servedModel: doc.servedModel } : {}),
    ...(doc.variant !== undefined ? { variant: doc.variant } : {}),
    provenance: { origin: 'eval-root' },
    cases: doc.cases.map((c) => ({
      id: c.id,
      fixture: c.fixture,
      task: { prompt: c.task.prompt },
      probe: c.probe.kind === 'check-rerun' ? { kind: c.probe.kind, check: c.probe.check } : { kind: c.probe.kind },
    })),
  };
}

/** Same status the runner's suspiciousBenignFlag resolves from the full repo (parity-tested). */
export function sidecarStatus(repo, fixture) {
  if (!fixture.endsWith('.json')) return 'unflagged';
  let raw;
  try {
    raw = readFileSync(join(repo, `${fixture.slice(0, -'.json'.length)}.label.json`), 'utf8');
  } catch {
    return 'absent';
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unparseable';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'invalid';
  if (parsed.fp_flag === 'suspicious-benign') return 'flagged';
  if (parsed.fp_flag === 'none') return 'unflagged';
  return 'invalid';
}

/**
 * The allowlist, derived from the repo: Map<root-relative path, {src} | {content}>
 * plus the answer key's suites. Build and scan share it; a fixture holding
 * anything but the RS-9 entry set is a hard error, never silently dropped.
 */
export function planEvalRoot(repo) {
  const files = new Map();
  for (const rel of CODE_FILES) files.set(rel, { src: join(repo, rel) });
  for (const rel of walk(join(repo, 'runner')).files) {
    if (rel.endsWith('.ts')) files.set(`runner/${rel}`, { src: join(repo, 'runner', rel) });
  }
  const keySuites = {};
  const suites = discoverSuites(repo);
  for (const suiteRel of suites) {
    const doc = readJson(join(repo, suiteRel, 'suite.json'));
    files.set(`${suiteRel}/suite.json`, { content: jsonText(stripSuite(doc)) });
    for (const c of doc.cases) {
      const fixtureAbs = join(repo, c.fixture);
      const st = lstatSync(fixtureAbs);
      if (st.isDirectory()) {
        const { files: inner, links } = walk(fixtureAbs);
        if (links.length > 0) throw new Error(`fixture ${c.fixture} holds symlinks (${links.join(', ')})`);
        for (const rel of inner) {
          if (!FIXTURE_ENTRY.test(rel)) throw new Error(`fixture ${c.fixture} holds '${rel}', outside the fixture allowlist`);
          files.set(`${c.fixture}/${rel}`, { src: join(fixtureAbs, rel) });
        }
      } else if (st.isFile() && c.fixture.endsWith('.json') && !c.fixture.endsWith('.label.json')) {
        files.set(c.fixture, { src: fixtureAbs });
      } else {
        throw new Error(`fixture ${c.fixture} is neither a fixture dir nor a thread payload file`);
      }
      if (c.probe.kind === 'check-rerun' && !files.has(c.probe.check)) {
        throw new Error(`case ${c.id}: check ${c.probe.check} lies outside its fixture`);
      }
      if (c.probe.kind === 'expected-verdict') {
        const key = `${doc.role}/${doc.name}`;
        keySuites[key] ??= { cases: {} };
        keySuites[key].cases[c.id] = { expected: c.probe.expected, sidecar: sidecarStatus(repo, c.fixture) };
      }
    }
  }
  return { files, keySuites, suites };
}

function placeNodeModules(repo, root, mode) {
  const src = join(repo, 'node_modules');
  const dst = join(root, 'node_modules');
  if (mode === 'skip') return;
  if (!existsSync(src)) throw new Error(`--node-modules ${mode}: ${src} does not exist (run npm ci first)`);
  if (mode === 'symlink') {
    symlinkSync(src, dst, 'dir');
    return;
  }
  if (mode === 'move') {
    try {
      renameSync(src, dst);
      return;
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
    }
  }
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
}

/** Build a root at `out` (absent or empty) and its answer key at `key` (outside the root). */
export function buildEvalRoot({ repo = REPO_ROOT, out, key, nodeModules = 'copy', plantDirs = [], token }) {
  if (!NODE_MODULES_MODES.has(nodeModules)) throw new UsageError(`--node-modules must be ${[...NODE_MODULES_MODES].join('|')}`);
  const repoReal = realpathSync(repo);
  if (existsSync(out) && readdirSync(out).length > 0) throw new UsageError(`--out ${out} must be absent or empty`);
  mkdirSync(out, { recursive: true });
  const root = realpathSync(out);
  if (isInside(root, repoReal) || isInside(repoReal, root)) {
    throw new UsageError(`--out ${out} must not overlap the repo checkout ${repoReal}`);
  }
  mkdirSync(dirname(resolve(key)), { recursive: true });
  const keyPath = join(realpathSync(dirname(resolve(key))), basename(key));
  if (isInside(keyPath, root)) throw new UsageError(`--key ${key} lies inside the eval root: the key must live outside everything a worker can reach`);

  const { files, keySuites, suites } = planEvalRoot(repoReal);
  for (const [rel, entry] of files) {
    const dst = join(root, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if ('src' in entry) cpSync(entry.src, dst);
    else writeFileSync(dst, entry.content);
  }
  writeFileSync(join(root, EVAL_ROOT_MARKER), jsonText(MARKER_DOC));

  const sentinel = token ?? `cq-sentinel-${randomBytes(16).toString('hex')}`;
  if (!/^cq-sentinel-[0-9a-f]{32}$/.test(sentinel)) throw new UsageError('sentinel token must be cq-sentinel-<32 hex>');
  // The token IS the file name, so a directory listing that exposes the file
  // carries the token too.
  const plantedPaths = [join(root, 'fixtures', `${sentinel}.txt`)];
  for (const dir of plantDirs) {
    mkdirSync(dir, { recursive: true });
    const dirReal = realpathSync(dir);
    if (isInside(dirReal, root)) throw new UsageError(`--plant-dir ${dir} lies inside the eval root (the root already carries one)`);
    plantedPaths.push(join(dirReal, `${sentinel}.txt`));
  }
  for (const p of plantedPaths) writeFileSync(p, `${sentinel}\n`);

  placeNodeModules(repoReal, root, nodeModules);
  writeFileSync(
    keyPath,
    jsonText({ version: 1, evalRoot: root, sentinel: { token: sentinel, plantedPaths }, suites: keySuites }),
    { mode: 0o600 },
  );
  return { root, key: keyPath, token: sentinel, files: files.size, suites, plantedPaths };
}

function tokens(text) {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

function spans(toks, n = FIX_SPAN_TOKENS) {
  const out = new Set();
  for (let i = 0; i + n <= toks.length; i++) out.add(toks.slice(i, i + n).join(' '));
  return out;
}

/** The fix side of a case's diff: lines the canonical fix adds over the faulted source, in order. */
export function fixDiffText(repo, fixture) {
  const recordPath = join(repo, `${fixture}.FAULT.json`);
  if (!existsSync(recordPath)) return undefined;
  const record = readJson(recordPath);
  const added = [];
  for (const [rel, fixed] of Object.entries(record.validation.fix)) {
    let faulted = '';
    try {
      faulted = readFileSync(join(repo, fixture, rel), 'utf8');
    } catch {
      // A missing fix target is the gate's problem; every fixed line counts as added.
    }
    const pool = new Map();
    for (const line of faulted.split('\n')) pool.set(line, (pool.get(line) ?? 0) + 1);
    for (const line of fixed.split('\n')) {
      const left = pool.get(line) ?? 0;
      if (left > 0) pool.set(line, left - 1);
      else added.push(line);
    }
  }
  return added.join('\n');
}

/** A prompt's problems: answer markers and a >= FIX_SPAN_TOKENS span shared with its fix diff. */
export function promptProblems(prompt, fixText) {
  const problems = [];
  for (const [re, label] of PROMPT_MARKERS) if (re.test(prompt)) problems.push(`carries ${label}`);
  if (fixText !== undefined) {
    const fixSpans = spans(tokens(fixText));
    const shared = [...spans(tokens(prompt))].find((s) => fixSpans.has(s));
    if (shared !== undefined) problems.push(`shares a ${FIX_SPAN_TOKENS}-token span with the fix diff ('${shared}')`);
  }
  return problems;
}

const SUITE_KEYS = new Set(['name', 'role', 'servedModel', 'variant', 'provenance', 'cases']);
const CASE_KEYS = new Set(['id', 'fixture', 'task', 'probe']);

function strippedSuiteProblems(doc) {
  const problems = [];
  for (const k of Object.keys(doc)) if (!SUITE_KEYS.has(k)) problems.push(`suite key '${k}' is not a dispatch field`);
  if (JSON.stringify(doc.provenance) !== JSON.stringify({ origin: 'eval-root' })) problems.push('provenance is not stripped');
  for (const c of doc.cases ?? []) {
    for (const k of Object.keys(c)) if (!CASE_KEYS.has(k)) problems.push(`case ${c.id}: key '${k}' is not a dispatch field`);
    if (Object.keys(c.task ?? {}).join() !== 'prompt') problems.push(`case ${c.id}: task carries more than the prompt`);
    const allowed = c.probe?.kind === 'check-rerun' ? 'kind,check' : 'kind';
    if (Object.keys(c.probe ?? {}).sort().join() !== allowed.split(',').sort().join()) {
      problems.push(`case ${c.id}: probe carries more than ${allowed}`);
    }
  }
  return problems;
}

/** Scan a built root. Returns the problems found (empty = clean) and the file count checked. */
export function scanEvalRoot({ root, repo = REPO_ROOT, key }) {
  const problems = [];
  const rootReal = realpathSync(root);
  const repoReal = realpathSync(repo);
  const markerPath = join(rootReal, EVAL_ROOT_MARKER);
  if (!existsSync(markerPath) || readFileSync(markerPath, 'utf8') !== jsonText(MARKER_DOC)) {
    problems.push(`${EVAL_ROOT_MARKER}: missing or not the eval-root marker`);
  }

  const { files: planned, keySuites } = planEvalRoot(repoReal);
  const { files, links } = walk(rootReal);
  const sentinelFiles = [];
  const nmRoot = join(rootReal, 'node_modules');
  for (const rel of links) {
    if (rel === 'node_modules') {
      problems.push('node_modules is a symlink (it leads back into the checkout)');
    } else if (rel.startsWith('node_modules/')) {
      let target;
      try {
        target = realpathSync(join(rootReal, rel));
      } catch {
        continue; // a dangling link reaches nothing
      }
      if (!isInside(target, nmRoot)) problems.push(`${rel}: symlink resolves outside node_modules (${target})`);
    } else {
      problems.push(`${rel}: symlink outside node_modules`);
    }
  }
  for (const rel of files) {
    if (rel.startsWith('node_modules/')) continue; // third-party code: symlink-checked above, never answer-bearing
    const forbidden = FORBIDDEN_PATHS.find(([re]) => re.test(rel));
    if (forbidden !== undefined) problems.push(`${rel}: forbidden path class — ${forbidden[1]}`);
    if (rel === EVAL_ROOT_MARKER) continue;
    if (/^fixtures\/cq-sentinel-[0-9a-f]{32}\.txt$/.test(rel)) {
      sentinelFiles.push(rel);
      continue;
    }
    const entry = planned.get(rel);
    if (entry === undefined) {
      if (forbidden === undefined) problems.push(`${rel}: not on the eval-root allowlist`);
      continue;
    }
    const actual = readFileSync(join(rootReal, rel));
    const expected = 'src' in entry ? readFileSync(entry.src) : Buffer.from(entry.content);
    if (!actual.equals(expected)) problems.push(`${rel}: differs from its allowlisted source`);
    const isData = (rel.startsWith('suites/') || rel.startsWith('fixtures/')) && !CODE_FILES.includes(rel);
    if (isData) {
      const text = actual.toString('utf8');
      for (const [re, label] of ANSWER_MARKERS) if (re.test(text)) problems.push(`${rel}: carries ${label}`);
    }
  }
  const present = new Set(files);
  for (const rel of planned.keys()) if (!present.has(rel)) problems.push(`${rel}: allowlisted but missing from the root`);
  if (sentinelFiles.length !== 1) problems.push(`expected exactly one planted sentinel under fixtures/, found ${sentinelFiles.length}`);

  for (const suiteRel of discoverSuites(rootReal)) {
    const doc = readJson(join(rootReal, suiteRel, 'suite.json'));
    for (const p of strippedSuiteProblems(doc)) problems.push(`${suiteRel}/suite.json: ${p}`);
    for (const c of doc.cases ?? []) {
      const fixText = c.probe?.kind === 'check-rerun' ? fixDiffText(repoReal, c.fixture) : undefined;
      for (const p of promptProblems(c.task?.prompt ?? '', fixText)) problems.push(`${suiteRel} case ${c.id}: prompt ${p}`);
    }
  }

  if (key !== undefined) {
    let doc;
    try {
      doc = readJson(key);
    } catch (e) {
      problems.push(`key ${key}: unreadable (${e.message})`);
    }
    if (doc !== undefined) {
      const keyReal = realpathSync(key);
      if (isInside(keyReal, rootReal)) problems.push(`key ${key}: lies inside the eval root`);
      if (doc.evalRoot !== rootReal) problems.push(`key ${key}: built for '${doc.evalRoot}', not this root`);
      const token = doc.sentinel?.token;
      for (const p of doc.sentinel?.plantedPaths ?? []) {
        if (!existsSync(p) || readFileSync(p, 'utf8') !== `${token}\n`) problems.push(`planted sentinel ${p}: missing or not carrying the token`);
      }
      if (sentinelFiles.length === 1 && sentinelFiles[0] !== `fixtures/${token}.txt`) {
        problems.push(`root sentinel ${sentinelFiles[0]} does not carry the key's token`);
      }
      if (JSON.stringify(doc.suites) !== JSON.stringify(keySuites)) {
        problems.push(`key ${key}: classifier answers differ from the repo's suites (rebuild the root)`);
      }
    }
  }
  return { problems, checked: files.length };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { plantDirs: [] };
  const flags = {
    '--out': 'out', '--key': 'key', '--repo': 'repo', '--root': 'root', '--node-modules': 'nodeModules', '--plant-dir': 'plantDirs',
  };
  for (let i = 0; i < rest.length; i++) {
    const name = flags[rest[i]];
    const value = rest[i + 1];
    if (name === undefined || value === undefined) throw new UsageError(`unknown flag or missing value: ${rest[i]}`);
    if (name === 'plantDirs') opts.plantDirs.push(value);
    else opts[name] = value;
    i++;
  }
  if (command === 'build' && (opts.out === undefined || opts.key === undefined)) throw new UsageError('build needs --out and --key');
  if (command === 'scan' && opts.root === undefined) throw new UsageError('scan needs --root');
  if (command !== 'build' && command !== 'scan') throw new UsageError('command must be build or scan');
  return { command, opts };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`eval-root: ${e.message}`);
    console.error('usage: node scripts/eval-root.mjs build --out <dir> --key <file> [--repo <dir>] [--node-modules copy|move|symlink|skip] [--plant-dir <dir>]...');
    console.error('       node scripts/eval-root.mjs scan --root <dir> [--key <file>] [--repo <dir>]');
    return 2;
  }
  const { command, opts } = parsed;
  if (command === 'build') {
    try {
      const built = buildEvalRoot(opts);
      console.log(`eval-root: built ${built.root} (${built.files} allowlisted files, ${built.suites.length} suites); key ${built.key}; ${built.plantedPaths.length} sentinel(s) planted`);
      return 0;
    } catch (e) {
      console.error(`eval-root: build failed: ${e.message}`);
      return 2;
    }
  }
  let result;
  try {
    result = scanEvalRoot(opts);
  } catch (e) {
    console.error(`eval-root: scan failed: ${e.message}`);
    return 2;
  }
  if (result.problems.length > 0) {
    console.error(`eval-root: scan FAILED — ${result.problems.length} problem(s):`);
    for (const p of result.problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(`eval-root: scan clean (${result.checked} files outside node_modules and within it checked)`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
