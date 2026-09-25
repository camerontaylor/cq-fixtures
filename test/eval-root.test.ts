import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, describe, expect, it } from 'vitest';
import { EVAL_ROOT_MARKER as RUNNER_MARKER, loadAnswerKey, sentinelNeedles, type AnswerKey } from '../runner/answerKey.ts';
import { FakeDriver } from '../runner/fake-driver.ts';
import { runSuite, SESSION_STORE_DIR, suspiciousBenignFlag } from '../runner/index.ts';
import { loadSuite } from '../runner/suite.ts';
import {
  buildEvalRoot,
  discoverSuites,
  EVAL_ROOT_MARKER,
  fixDiffText,
  promptProblems,
  scanEvalRoot,
  sidecarStatus,
  stripSuite,
} from '../scripts/eval-root.mjs';

// W6.3 (RS-9 §4.3): leakage excision + the eval-root CI check. Everything
// here is synthetic or offline: FakeDriver and in-test stand-in workers only,
// no model, no network, no spend.

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'scripts', 'eval-root.mjs');
const SMOKE = { model: 'glm-5.3-flash', provider: 'zai', driverName: 'subprocess' } as const;
const PROMPT_PREFIX_END = 'Do not modify the tests. ';

const temps: string[] = [];
function temp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cq-eval-root-test-${label}-`));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

interface SuiteDoc {
  name: string;
  role: string;
  cases: Array<{ id: string; fixture: string; task: { prompt: string; notes?: string }; probe: { kind: string; check?: string; expected?: string } }>;
}

function repoSuites(role?: string): Array<{ rel: string; doc: SuiteDoc }> {
  return discoverSuites(REPO_ROOT)
    .map((rel) => ({ rel, doc: readJson<SuiteDoc>(join(REPO_ROOT, rel, 'suite.json')) }))
    .filter(({ doc }) => role === undefined || doc.role === role);
}

/** Every file under `dir` (relative, `/`-joined), not following symlinks. */
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else out.push(abs.slice(base.length + 1));
  }
  return out;
}

function build(label: string, nodeModules: 'skip' | 'symlink' = 'skip') {
  const dir = temp(label);
  return buildEvalRoot({ out: join(dir, 'root'), key: join(dir, 'key', 'answer-key.json'), nodeModules, plantDirs: [join(dir, 'host')] });
}

describe('RS-9 excision at the source (W6.3)', () => {
  // RS-9 §4 "States-the-fix (S)": the 16 phrases, verbatim.
  const FIX_STATING = [
    'it must include b',
    'must be entirely lowercase',
    'must reuse the first result',
    "must throw an Error whose message mentions 'invalid config'",
    'must order by priority descending',
    'must return width times height',
    'the last page index must be treated as final',
    'members must get ten percent off and non-members nothing',
    'each attempt must double the previous delay',
    'must be true only when every item is in stock',
    'a repeated argument must reuse the cached result',
    'it must default to three',
    "it must report 'unknown' instead",
    'snapshots must be independent',
    'parsing must be base ten and labels must read from-to',
    'as base sixteen instead of base ten',
  ];

  it('the 16 fix-stating fixer prompts are symptom-only, and no fixer prompt prescribes a fix', () => {
    const fixer = repoSuites('fixer-worker');
    expect(fixer.map((s) => s.rel)).toEqual(expect.arrayContaining([
      'suites/fixer-worker/micro', 'suites/fixer-worker/breadth-verified', 'suites/fixer-worker/canary',
    ]));
    for (const { rel, doc } of fixer) {
      for (const c of doc.cases) {
        for (const phrase of FIX_STATING) expect(c.task.prompt, `${rel} ${c.id}`).not.toContain(phrase);
        const tail = c.task.prompt.slice(c.task.prompt.indexOf(PROMPT_PREFIX_END) + PROMPT_PREFIX_END.length);
        expect(tail, `${rel} ${c.id}: a symptom-only tail never says what the code must do`).not.toMatch(/\bmust\b/i);
      }
    }
  });

  it('fault symptoms no longer name the mechanism (breadth-03, 09, 10; canary-03)', () => {
    const named: Record<string, string> = {
      'breadth-03': 'membership branch is inverted',
      'breadth-09': 'live internal stock array',
      'breadth-10': 'without a radix',
      'canary-03': 'base sixteen instead of base ten',
    };
    for (const [id, phrase] of Object.entries(named)) {
      const record = readJson<{ failure_symptoms: string }>(join(REPO_ROOT, 'fixtures', `${id}.FAULT.json`));
      expect(record.failure_symptoms, id).not.toContain(phrase);
    }
  });

  it('the three in-source hint comments are gone from the fixtures, their fixes, and the merge substrate', () => {
    const hints = [
      'The clean version refuses to walk',
      'CVE-2019-10744',
      'members get ten percent off',
      'zero-based index of the final page',
    ];
    const sources = ['fixtures/canary-04/src/merge.ts', 'fixtures/breadth-03/src/discount.ts', 'fixtures/breadth-02/src/paging.ts', 'catalog/substrates/merge/src/merge.ts'];
    for (const rel of sources) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const hint of hints) expect(text, rel).not.toContain(hint);
    }
    for (const id of ['canary-04', 'breadth-03', 'breadth-02']) {
      const fix = JSON.stringify(readJson<{ validation: { fix: unknown } }>(join(REPO_ROOT, 'fixtures', `${id}.FAULT.json`)).validation.fix);
      for (const hint of hints) expect(fix, `${id} validation.fix`).not.toContain(hint);
    }
  });
});

describe('allowlist eval root: build + static scan (W6.3 CI check)', () => {
  it('builds a root holding only the allowlist, with answers and sentinel outside it, and scans clean', () => {
    const built = build('clean');
    const files = listFiles(built.root);
    // Nothing RS-9 lists survives into the root.
    for (const rel of files) {
      expect(rel, 'fault record').not.toMatch(/\.FAULT\.json$/);
      expect(rel, 'label sidecar').not.toMatch(/\.label\.json$/);
      expect(rel, 'docs/READMEs/PROVENANCE/REPRODUCTION/LABEL-GUIDE/DECISIONS').not.toMatch(/\.md$/);
      expect(rel, 'catalog, docs, reports, test, .git, scripts').not.toMatch(/^(catalog|docs|reports|test|scripts|\.git|\.github)\//);
    }
    expect(existsSync(join(built.root, 'test')), 'test/ never enters the root').toBe(false);
    expect(existsSync(join(built.root, '.git')), '.git never enters the root').toBe(false);
    expect(existsSync(join(built.root, EVAL_ROOT_MARKER))).toBe(true);
    // Stripped suites: dispatch fields only — no notes, no expected, no provenance detail.
    const suiteFiles = files.filter((f) => f.endsWith('suite.json'));
    expect(suiteFiles).toHaveLength(repoSuites().length);
    for (const rel of suiteFiles) {
      const text = readFileSync(join(built.root, rel), 'utf8');
      expect(text, rel).not.toContain('"notes"');
      expect(text, rel).not.toContain('"expected"');
      expect(text, rel).not.toContain('canonical fix');
    }
    // The key lives outside the root, private, and carries every classifier answer.
    expect(built.key.startsWith(built.root)).toBe(false);
    if (process.platform !== 'win32') expect(statSync(built.key).mode & 0o777).toBe(0o600);
    const key = loadAnswerKey(built.key);
    const classifierCases = repoSuites('review-classifier').flatMap(({ doc }) => doc.cases.map((c) => `${doc.role}/${doc.name}:${c.id}:${c.probe.expected}`));
    const keyed = Object.entries(key.suites).flatMap(([suite, { cases }]) => Object.entries(cases).map(([id, v]) => `${suite}:${id}:${v.expected}`));
    expect(keyed.sort()).toEqual(classifierCases.sort());
    expect(classifierCases).toHaveLength(70);
    // One sentinel inside the root (the token is its file name) and one planted outside.
    expect(built.plantedPaths).toHaveLength(2);
    expect(built.plantedPaths[0]).toBe(join(built.root, 'fixtures', `${built.token}.txt`));
    for (const p of built.plantedPaths) expect(readFileSync(p, 'utf8')).toBe(`${built.token}\n`);
    expect(scanEvalRoot({ root: built.root, key: built.key }).problems).toEqual([]);
  });

  it('the CI invocation (build then scan through the CLI) exits 0', () => {
    const dir = temp('cli');
    const key = join(dir, 'key', 'answer-key.json');
    const b = spawnSync(process.execPath, [SCRIPT, 'build', '--out', join(dir, 'root'), '--key', key, '--node-modules', 'skip'], { encoding: 'utf8' });
    expect(b.status, b.stderr).toBe(0);
    const s = spawnSync(process.execPath, [SCRIPT, 'scan', '--root', join(dir, 'root'), '--key', key], { encoding: 'utf8' });
    expect(s.status, s.stderr).toBe(0);
    expect(s.stdout).toContain('scan clean');
  });

  // Each mutation plants one RS-9 leak class into an otherwise clean root.
  const LEAKS: Array<{ name: string; plant: (root: string, built: ReturnType<typeof build>) => void; expect: RegExp }> = [
    {
      name: 'a FAULT.json record',
      plant: (root) => cpSync(join(REPO_ROOT, 'fixtures', 'breadth-01.FAULT.json'), join(root, 'fixtures', 'breadth-01.FAULT.json')),
      expect: /fixtures\/breadth-01\.FAULT\.json: forbidden path class/,
    },
    {
      name: 'a label sidecar',
      plant: (root) => cpSync(join(REPO_ROOT, 'fixtures', 'threads', 'bv-01.label.json'), join(root, 'fixtures', 'threads', 'bv-01.label.json')),
      expect: /bv-01\.label\.json: forbidden path class/,
    },
    {
      name: 'catalog/',
      plant: (root) => {
        mkdirSync(join(root, 'catalog'));
        cpSync(join(REPO_ROOT, 'catalog', 'recipes.ts'), join(root, 'catalog', 'recipes.ts'));
      },
      expect: /catalog\/recipes\.ts: forbidden path class/,
    },
    {
      name: 'a PROVENANCE doc',
      plant: (root) => cpSync(join(REPO_ROOT, 'suites', 'fixer-worker', 'canary', 'PROVENANCE.md'), join(root, 'suites', 'fixer-worker', 'canary', 'PROVENANCE.md')),
      expect: /PROVENANCE\.md: forbidden path class/,
    },
    {
      name: 'task.notes put back into a suite',
      plant: (root) => {
        const p = join(root, 'suites', 'fixer-worker', 'breadth-verified', 'suite.json');
        const doc = readJson<SuiteDoc>(p);
        doc.cases[0]!.task.notes = 'easy · arithmetic-swap · canonical fix in fixtures/breadth-01.FAULT.json';
        writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
      },
      expect: /breadth-verified\/suite\.json: case breadth-01: task carries more than the prompt/,
    },
    {
      name: 'a probe.expected put back into a classifier suite',
      plant: (root) => {
        const p = join(root, 'suites', 'review-classifier', 'micro', 'suite.json');
        const doc = readJson<SuiteDoc>(p);
        doc.cases[0]!.probe.expected = 'actionable';
        writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
      },
      expect: /micro\/suite\.json: carries "expected" key/,
    },
    {
      name: 'a prompt quoting its fix diff',
      plant: (root) => {
        const p = join(root, 'suites', 'fixer-worker', 'canary', 'suite.json');
        const doc = readJson<SuiteDoc>(p);
        const c = doc.cases.find((x) => x.id === 'canary-04')!;
        c.task.prompt += " Hint: if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;";
        writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
      },
      expect: /canary case canary-04: prompt shares a 6-token span with the fix diff/,
    },
    {
      name: 'a canonical fix swapped into a fixture',
      plant: (root) => {
        const record = readJson<{ validation: { fix: Record<string, string> } }>(join(REPO_ROOT, 'fixtures', 'breadth-01.FAULT.json'));
        writeFileSync(join(root, 'fixtures', 'breadth-01', 'src', 'area.ts'), record.validation.fix['src/area.ts']!);
      },
      expect: /fixtures\/breadth-01\/src\/area\.ts: differs from its allowlisted source/,
    },
    {
      name: 'an extra file beside a fixture',
      plant: (root) => writeFileSync(join(root, 'fixtures', 'micro-1', 'HINTS.txt'), 'look at the loop bound\n'),
      expect: /fixtures\/micro-1\/HINTS\.txt: not on the eval-root allowlist/,
    },
    {
      name: 'a symlink leaving the root',
      plant: (root) => symlinkSync(join(REPO_ROOT, 'fixtures', 'micro-1.FAULT.json'), join(root, 'fixtures', 'micro-1', 'src', 'leak.ts')),
      expect: /fixtures\/micro-1\/src\/leak\.ts: symlink outside node_modules/,
    },
    {
      name: 'a symlinked node_modules (it leads back into the checkout)',
      plant: (root) => symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir'),
      expect: /node_modules is a symlink/,
    },
    {
      name: 'a removed sentinel',
      plant: (root, built) => rmSync(join(root, 'fixtures', `${built.token}.txt`)),
      expect: /expected exactly one planted sentinel under fixtures\/, found 0/,
    },
    {
      name: 'a key built for another root',
      plant: (_root, built) => {
        const key = readJson<AnswerKey>(built.key);
        writeFileSync(built.key, JSON.stringify({ ...key, evalRoot: '/elsewhere' }, null, 2) + '\n');
      },
      expect: /built for '\/elsewhere', not this root/,
    },
  ];

  for (const leak of LEAKS) {
    it(`the scan fails on ${leak.name}`, () => {
      const built = build('leak');
      leak.plant(built.root, built);
      const { problems } = scanEvalRoot({ root: built.root, key: built.key });
      expect(problems.join('\n')).toMatch(leak.expect);
    });
  }

  it('the scan CLI exits 1 and names the problem', () => {
    const built = build('leak-cli');
    cpSync(join(REPO_ROOT, 'fixtures', 'canary-04.FAULT.json'), join(built.root, 'fixtures', 'canary-04.FAULT.json'));
    const s = spawnSync(process.execPath, [SCRIPT, 'scan', '--root', built.root, '--key', built.key], { encoding: 'utf8' });
    expect(s.status).toBe(1);
    expect(s.stderr).toContain('canary-04.FAULT.json: forbidden path class');
  });

  it('the build refuses a key inside the root, a root overlapping the checkout, and a non-empty out dir', () => {
    const dir = temp('refuse');
    expect(() => buildEvalRoot({ out: join(dir, 'root'), key: join(dir, 'root', 'key.json'), nodeModules: 'skip' })).toThrow(/lies inside the eval root/);
    expect(() => buildEvalRoot({ out: join(REPO_ROOT, 'tmp-eval-root-test'), key: join(dir, 'k.json'), nodeModules: 'skip' })).toThrow(/must not overlap the repo checkout/);
    rmSync(join(REPO_ROOT, 'tmp-eval-root-test'), { recursive: true, force: true });
    mkdirSync(join(dir, 'busy'));
    writeFileSync(join(dir, 'busy', 'x'), 'x');
    expect(() => buildEvalRoot({ out: join(dir, 'busy'), key: join(dir, 'k.json'), nodeModules: 'skip' })).toThrow(/must be absent or empty/);
    const cli = spawnSync(process.execPath, [SCRIPT, 'build', '--out', join(dir, 'busy'), '--key', join(dir, 'k.json')], { encoding: 'utf8' });
    expect(cli.status).toBe(2);
  });

  it('promptProblems: answer markers and a 6-token fix-diff span fail; every real prompt passes', () => {
    const fix = fixDiffText(REPO_ROOT, 'fixtures/canary-04');
    expect(fix).toContain("if (key === '__proto__'");
    expect(promptProblems('merge skips the __proto__ key', fix)).toEqual([]);
    // Five shared tokens pass; the sixth trips the span rule.
    expect(promptProblems("see if key === '__proto__' || key === 'constructor' first", fix)).toEqual([]);
    expect(promptProblems("see if key === '__proto__' || key === 'constructor' || key first", fix).join()).toMatch(/6-token span/);
    expect(promptProblems('the canonical fix lives in fixtures/canary-04.FAULT.json', undefined).join()).toMatch(/FAULT.*canonical fix.*fixture path/);
    for (const { doc } of repoSuites()) {
      for (const c of doc.cases) {
        const fixText = c.probe.kind === 'check-rerun' ? fixDiffText(REPO_ROOT, c.fixture) : undefined;
        expect(promptProblems(c.task.prompt, fixText), `${doc.name} ${c.id}`).toEqual([]);
      }
    }
  });

  it('stripSuite keeps only the dispatch fields', () => {
    const doc = readJson<SuiteDoc>(join(REPO_ROOT, 'suites', 'review-classifier', 'breadth-verified', 'suite.json'));
    const stripped = stripSuite(doc);
    expect(stripped.provenance).toEqual({ origin: 'eval-root' });
    expect(stripped.cases[0]).toEqual({ id: doc.cases[0]!.id, fixture: doc.cases[0]!.fixture, task: { prompt: doc.cases[0]!.task.prompt }, probe: { kind: 'expected-verdict' } });
  });

  it('the builder resolves label-sidecar status exactly as the runner does (parity)', () => {
    expect(EVAL_ROOT_MARKER).toBe(RUNNER_MARKER);
    for (const { doc } of repoSuites('review-classifier')) {
      for (const c of doc.cases) expect(sidecarStatus(REPO_ROOT, c.fixture), c.id).toBe(suspiciousBenignFlag(REPO_ROOT, c.fixture));
    }
    const dir = temp('sidecar');
    const states: Record<string, string | undefined> = {
      absent: undefined, unparseable: '{', invalid: '{}', flagged: '{"fp_flag":"suspicious-benign"}', unflagged: '{"fp_flag":"none"}',
    };
    for (const [state, content] of Object.entries(states)) {
      writeFileSync(join(dir, `${state}.json`), '{}');
      if (content !== undefined) writeFileSync(join(dir, `${state}.label.json`), content);
      expect(sidecarStatus(dir, `${state}.json`)).toBe(state);
      expect(suspiciousBenignFlag(dir, `${state}.json`)).toBe(state);
    }
  });
});

describe('answer key: stripped suites load only with their key', () => {
  it('fills expected verdicts from the key and refuses every key/suite drift', () => {
    const built = build('key');
    const key = loadAnswerKey(built.key);
    const dir = join(built.root, 'suites', 'review-classifier', 'micro');
    const repoSuite = loadSuite(join(REPO_ROOT, 'suites', 'review-classifier', 'micro'));
    expect(loadSuite(dir, key).cases).toEqual(repoSuite.cases.map((c) => ({ ...c, task: { prompt: c.task.prompt } })));
    expect(() => loadSuite(dir), 'a stripped classifier suite cannot validate without its key').toThrow(/expected/);
    expect(() => loadSuite(join(REPO_ROOT, 'suites', 'review-classifier', 'micro'), key)).toThrow(/carries probe\.expected, but an answer key was supplied/);
    const missing = structuredClone(key);
    delete missing.suites['review-classifier/micro']!.cases['thread-01'];
    expect(() => loadSuite(dir, missing)).toThrow(/no entry for case 'thread-01'/);
    const orphan = structuredClone(key);
    orphan.suites['review-classifier/micro']!.cases['thread-99'] = { expected: 'skip', sidecar: 'absent' };
    expect(() => loadSuite(dir, orphan)).toThrow(/cases the suite does not have: thread-99/);
  });

  it('a key-backed run from the root scores and flags exactly like the repo-local run, with no fixture path in any prompt', async () => {
    const built = build('parity');
    const key = loadAnswerKey(built.key);
    const prompts: string[] = [];
    const capturing: Driver = {
      run: async (inv: OpInvocation) => {
        prompts.push(inv.prompt);
        return new FakeDriver().run(inv);
      },
    };
    const rel = join('suites', 'review-classifier', 'breadth-verified');
    const local = await runSuite({ suiteDir: join(REPO_ROOT, rel), driver: new FakeDriver(), ...SMOKE });
    const rooted = await runSuite({
      suiteDir: join(built.root, rel), driver: capturing, ...SMOKE, repoRoot: built.root,
      answerKey: key, sentinelNeedles: sentinelNeedles(key, built.key),
    });
    const facts = (rows: typeof local.rows) => rows.map((r) => ({ case: r.case, outcome: r.outcome, probes: r.probes, suspiciousBenign: r.suspiciousBenign }));
    expect(facts(rooted.rows)).toEqual(facts(local.rows));
    expect(rooted.rows.some((r) => r.suspiciousBenign === true), 'flags ride the key').toBe(true);
    expect(rooted.diagnostics).toEqual(local.diagnostics);
    expect(rooted.contaminations).toEqual([]);
    expect(prompts).toHaveLength(30);
    for (const p of prompts) {
      expect(p).toContain('\n\nThread payload:\n');
      expect(p).not.toContain('fixtures/');
    }
  }, 60_000);
});

describe('dynamic sentinel canary (RS-9 §4.3 D)', () => {
  const TOKEN = `cq-sentinel-${'ab'.repeat(16)}`;

  /** A synthetic repo + key: one fixer case (check passes) and one classifier case. */
  function sentinelRepo() {
    const root = temp('sentinel');
    mkdirSync(join(root, 'fixture', 'src'), { recursive: true });
    writeFileSync(join(root, 'fixture', 'src', 'state.txt'), 'pristine\n');
    writeFileSync(join(root, 'fixture', 'check.js'), 'process.exit(0);\n');
    writeFileSync(join(root, 'thread.json'), JSON.stringify({ id: 1, path: 'a.ts', line: 1, resolved: false, comments: [] }));
    const keyPath = join(temp('sentinel-key'), 'answer-key.json');
    const planted = join(root, `${TOKEN}.txt`);
    writeFileSync(planted, `${TOKEN}\n`);
    const key: AnswerKey = {
      version: 1, evalRoot: root,
      sentinel: { token: TOKEN, plantedPaths: [planted] },
      suites: { 'review-classifier/leak-cls': { cases: { 'cls-1': { expected: 'actionable', sidecar: 'unflagged' } } } },
    };
    writeFileSync(keyPath, JSON.stringify(key));
    const fixerDir = join(root, 'suites', 'fixer-worker', 'leak-fix');
    mkdirSync(fixerDir, { recursive: true });
    writeFileSync(join(fixerDir, 'suite.json'), JSON.stringify({
      name: 'leak-fix', role: 'fixer-worker', provenance: { origin: 'eval-root' },
      cases: [{ id: 'fix-1', fixture: 'fixture', task: { prompt: 'Fix it.' }, probe: { kind: 'check-rerun', check: 'fixture/check.js' } }],
    }));
    const clsDir = join(root, 'suites', 'review-classifier', 'leak-cls');
    mkdirSync(clsDir, { recursive: true });
    writeFileSync(join(clsDir, 'suite.json'), JSON.stringify({
      name: 'leak-cls', role: 'review-classifier', provenance: { origin: 'eval-root' },
      cases: [{ id: 'cls-1', fixture: 'thread.json', task: { prompt: 'Classify.' }, probe: { kind: 'expected-verdict' } }],
    }));
    return { root, key, keyPath, planted, fixerDir, clsDir, needles: sentinelNeedles(key, keyPath) };
  }

  type Leak = 'none' | 'output' | 'patch' | 'workspace' | 'symlink' | 'denial' | 'throw' | 'transcript' | 'error';

  /** A stand-in worker that reaches outside its workspace in one chosen way. */
  function leakyDriver(mode: Leak, repo: ReturnType<typeof sentinelRepo>): Driver {
    return {
      run: async (inv: OpInvocation): Promise<WorkerResult> => {
        const workspace = /\nworkspace: (\S+)$/.exec(inv.prompt)?.[1];
        if (workspace !== undefined) {
          writeFileSync(join(workspace, 'src', 'state.txt'), 'fixed\n');
          mkdirSync(join(workspace, 'node_modules', '.vite'), { recursive: true });
          writeFileSync(join(workspace, 'node_modules', '.vite', 'results.json'), '{}');
        }
        if (mode === 'patch') writeFileSync(join(workspace!, 'src', 'copied.txt'), readFileSync(repo.planted, 'utf8'));
        // node_modules/ is outside the patch (RS-9 B.10), so these two are
        // caught only by the workspace walk.
        if (mode === 'workspace') writeFileSync(join(workspace!, 'node_modules', 'stash.txt'), readFileSync(repo.planted, 'utf8'));
        if (mode === 'symlink') symlinkSync(repo.planted, join(workspace!, 'node_modules', 'peek'));
        if (mode === 'transcript') appendFileSync(join(SESSION_STORE_DIR, `${inv.sessionRef}.jsonl`), `{"tool":"read","path":"${repo.keyPath}"}\n`);
        if (mode === 'throw') throw new Error(`ENOENT reading ${repo.planted}`);
        const notes = mode === 'output' ? `found ${TOKEN}` : 'ok';
        return {
          model: inv.modelSpec.model,
          // The fixer's DD-4 shape is strict {fixed, notes}; the classifier answers a verdict.
          structuredOutput: workspace !== undefined ? { fixed: true, notes } : { verdict: 'actionable', ...(mode === 'output' ? { notes } : {}) },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          denials: mode === 'denial' ? [{ tool: 'read', reason: `path escape: ${repo.root}/fixtures` }] : [],
          stopReason: mode === 'error' ? 'error' : 'complete',
          ...(mode === 'error' ? { error: `ai-sdk driver: [provider-error] echoed ${repo.keyPath}` } : {}),
        };
      },
    };
  }

  it('a clean worker scores normally with the sentinel armed, and judge caches stay out of the patch', async () => {
    const repo = sentinelRepo();
    const result = await runSuite({ suiteDir: repo.fixerDir, driver: leakyDriver('none', repo), ...SMOKE, repoRoot: repo.root, sentinelNeedles: repo.needles });
    expect(result.contaminations).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.outcome.passed).toBe(2);
    const patch = result.artifacts.find((a) => a.kind === 'patch')!.content;
    expect(patch).toContain('+fixed');
    expect(patch, 'RS-9 B.10: node_modules caches are not the fix').not.toContain('node_modules');
  }, 60_000);

  for (const [mode, where] of [
    ['output', 'structured output'],
    ['patch', 'patch'],
    ['workspace', 'workspace file node_modules/stash.txt'],
    ['symlink', 'workspace symlink node_modules/peek'],
    ['denial', 'tool denials'],
    ['throw', 'driver throw'],
    ['transcript', 'session transcript'],
    ['error', 'driver error'],
  ] as const) {
    it(`a worker whose ${where} carries the sentinel publishes no row and is recorded as contamination`, async () => {
      const repo = sentinelRepo();
      const result = await runSuite({ suiteDir: repo.fixerDir, driver: leakyDriver(mode, repo), ...SMOKE, repoRoot: repo.root, sentinelNeedles: repo.needles });
      expect(result.rows).toEqual([]);
      expect(result.artifacts, 'no contaminated prediction is persisted').toEqual([]);
      expect(result.contaminations).toEqual([{ case: 'fix-1', where }]);
      expect(result.absences).toHaveLength(1);
      expect(result.absences[0]!.cause).toMatch(/^sentinel-contamination: the .* carries an eval-root sentinel/);
      expect(result.absences[0]!.cause, 'the cause never repeats the token').not.toContain(TOKEN);
    }, 60_000);
  }

  it('a classifier whose output carries the sentinel is withheld; a clean one scores from the key', async () => {
    const repo = sentinelRepo();
    const common = { suiteDir: repo.clsDir, ...SMOKE, repoRoot: repo.root, answerKey: repo.key, sentinelNeedles: repo.needles };
    const leaked = await runSuite({ ...common, driver: leakyDriver('output', repo) });
    expect(leaked.rows).toEqual([]);
    expect(leaked.contaminations).toEqual([{ case: 'cls-1', where: 'structured output' }]);
    const clean = await runSuite({ ...common, driver: leakyDriver('none', repo) });
    expect(clean.contaminations).toEqual([]);
    expect(clean.rows[0]!.probes).toEqual([{ kind: 'expected-verdict', expected: 'actionable', observed: 'actionable', passed: true }]);
  }, 30_000);
});

describe('CLI inside a built eval root', () => {
  function runCli(root: string, args: string[]) {
    return spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'runner', 'index.ts'), ...args], { encoding: 'utf8' });
  }
  const BASE = ['--driver', 'fake', '--driver-name', 'subprocess', '--model', 'glm-5.3-flash', '--provider', 'zai'];

  it('demands --answer-key, rejects a key inside the root or for another root, and scores from the key', () => {
    const built = build('cli-run', 'symlink');
    const suite = join(built.root, 'suites', 'review-classifier', 'micro');
    const out = join(temp('cli-out'), 'out');

    const noKey = runCli(built.root, ['--suite', suite, ...BASE]);
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toContain('--answer-key <path> is required so the sentinel is armed');

    const inside = join(built.root, 'fixtures', 'key.json');
    cpSync(built.key, inside);
    const insideRun = runCli(built.root, ['--suite', suite, ...BASE, '--answer-key', inside]);
    expect(insideRun.status).toBe(2);
    expect(insideRun.stderr).toContain('lies inside the eval root');
    rmSync(inside);

    const other = build('cli-other', 'skip');
    const otherRun = runCli(built.root, ['--suite', suite, ...BASE, '--answer-key', other.key]);
    expect(otherRun.status).toBe(2);
    expect(otherRun.stderr).toMatch(/was built for eval root/);

    const ok = runCli(built.root, ['--suite', suite, ...BASE, '--answer-key', built.key, '--out', out]);
    expect(ok.status, ok.stderr).toBe(1); // the fake scores zero on 8 of 10 cases: the honest benign exit
    const rows = readFileSync(join(out, 'rows.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { probes: Array<{ expected: string }> });
    const repoSuite = loadSuite(join(REPO_ROOT, 'suites', 'review-classifier', 'micro'));
    expect(rows.map((r) => r.probes[0]!.expected)).toEqual(repoSuite.cases.map((c) => (c.probe as { expected: string }).expected));
    const manifest = readJson<{ runs: Array<{ suiteDir: string }> }>(join(out, 'run.json'));
    expect(manifest.runs[0]!.suiteDir, 'regrade resolves the manifest against a repo').toBe('suites/review-classifier/micro');
  }, 60_000);

  it('a repo-local runner refuses --answer-key (only a built root pairs with a key)', () => {
    const built = build('cli-local');
    const res = spawnSync(process.execPath, ['--experimental-strip-types', join(REPO_ROOT, 'runner', 'index.ts'), '--suite', join(REPO_ROOT, 'suites', 'review-classifier', 'micro'), ...BASE, '--answer-key', built.key], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('only valid for a runner inside a built eval root');
  }, 30_000);

  it('a sentinel hit writes the evidence, records the absence, and exits 2', () => {
    const built = build('cli-hit', 'symlink');
    // Plant the token where the fixer workspace copy will carry it: the
    // runner's workspace scan must fire before any judge runs.
    writeFileSync(join(built.root, 'fixtures', 'micro-1', 'src', 'note.ts'), `// ${built.token}\n`);
    const suiteDir = join(built.root, 'suites', 'fixer-worker', 'one-case');
    mkdirSync(suiteDir, { recursive: true });
    const micro = readJson<SuiteDoc>(join(built.root, 'suites', 'fixer-worker', 'micro', 'suite.json'));
    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({ ...micro, name: 'one-case', cases: micro.cases.slice(0, 1) }));
    const out = join(temp('cli-hit-out'), 'out');
    const res = runCli(built.root, ['--suite', suiteDir, ...BASE, '--answer-key', built.key, '--out', out]);
    expect(res.status, res.stderr).toBe(2);
    expect(res.stderr).toContain('carried an eval-root sentinel');
    const manifest = readJson<{ runs: Array<{ absences?: Array<{ case: string; cause: string }> }> }>(join(out, 'run.json'));
    expect(manifest.runs[0]!.absences).toEqual([{ case: 'micro-1', cause: expect.stringMatching(/^sentinel-contamination: the workspace file src\/note\.ts/) }]);
    expect(readFileSync(join(out, 'rows.jsonl'), 'utf8')).toBe('');
  }, 60_000);
});
