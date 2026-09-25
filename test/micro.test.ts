import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import {
  computeCostUSD,
  priceOf,
  type Driver,
  SessionStore,
  type OpInvocation,
  type WorkerResult,
} from '@camerontaylor/cq-toolkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSuite } from '../runner/index.ts';
import { isFixerCase, loadSuite } from '../runner/suite.ts';
import { FakeDriver } from '../runner/fake-driver.ts';
import type { ComparisonTable, ResultRow } from '../runner/aggregate.ts';

// Micro-suite conformance (phase-3 J3): the two hand-seeded synthetic suites
// exercise the whole pipeline end to end — schema/semantic suite loading,
// fixture payload injection, the vitest-in-workspace check judges, and the
// fake-driver smoke lanes. These tests run REAL judge processes (a spawned
// vitest per probe), so the case-heavy tests carry generous per-test
// timeouts; everything else is in-process.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXER_SUITE_DIR = join(REPO_ROOT, 'suites', 'fixer-worker', 'micro');
const CLASSIFIER_SUITE_DIR = join(REPO_ROOT, 'suites', 'review-classifier', 'micro');

// Generous ceiling for one judge execution in these tests — the judge's own
// internal vitest ceiling is 45s (fixtures/judge-lib.mjs, layered below the
// scorer's 60s default); this test-side ceiling only guards a hung judge.
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Spawn one judge exactly as the runner's scorer does and return its exit
 * status (CodeRabbit minor, round 2): spawnSync reports status NULL on
 * timeout/signal/spawn failure, and a null would satisfy the faulted side's
 * `not.toBe(0)` for the WRONG reason — a non-execution is infrastructure,
 * not a probe verdict. Fail the test immediately instead, naming the case
 * and the spawn problem.
 */
function runJudgeOrThrow(caseId: string, checkPath: string, workspace: string): number {
  const res = spawnSync(process.execPath, [checkPath], { cwd: workspace, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if ((res.error !== undefined && res.error !== null) || res.status === null) {
    throw new Error(
      `${caseId} judge spawn failed (infrastructure, not an eval signal): ` +
        `${(res.error as Error | undefined)?.message ?? `killed by signal ${res.signal ?? 'unknown'}`}`,
    );
  }
  return res.status;
}

// Ajv setup identical to test/schema.test.ts and the runner: every artifact
// these tests inspect is held to the same contract the runner enforces.
const ajv = ajvFormats(new Ajv2020({ allErrors: true }));
const validateRow = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/result-row.schema.json', import.meta.url), 'utf8')) as object,
);
const validateTable = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/comparison-table.schema.json', import.meta.url), 'utf8')) as object,
);

function assertSchemaValid(rows: ResultRow[], tables: ComparisonTable[]): void {
  for (const row of rows) expect(validateRow(row), `row ${row.case}: ${ajv.errorsText(validateRow.errors)}`).toBe(true);
  for (const table of tables) {
    expect(validateTable(table), `table ${table.suite}: ${ajv.errorsText(validateTable.errors)}`).toBe(true);
  }
}

// Scratch root for test-local suite dirs: per-test fresh, per-test removed.
let wsRoot: string;

beforeEach(() => {
  wsRoot = mkdtempSync(join(tmpdir(), 'cq-micro-'));
});

afterEach(() => {
  rmSync(wsRoot, { recursive: true, force: true });
});

/** The recorded-SHAPE thread payload contract (fixtures/threads, D5). */
interface ThreadPayload {
  id: number;
  path: string;
  line: number;
  resolved: boolean;
  comments: Array<{ author: string; body: string; createdAt: string; isReply: boolean }>;
}

function isThreadPayload(value: unknown): value is ThreadPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'number' &&
    typeof p.path === 'string' &&
    typeof p.line === 'number' &&
    typeof p.resolved === 'boolean' &&
    Array.isArray(p.comments) &&
    p.comments.every((c) => {
      const comment = c as Record<string, unknown>;
      return (
        typeof comment.author === 'string' &&
        typeof comment.body === 'string' &&
        typeof comment.createdAt === 'string' &&
        !Number.isNaN(Date.parse(comment.createdAt)) &&
        typeof comment.isReply === 'boolean'
      );
    })
  );
}

/** Stub driver that only records dispatches — for prompt-shape assertions. */
class CapturingDriver implements Driver {
  readonly invocations: OpInvocation[] = [];
  /** Whether a fixer-style workspace line pointed at an existing dir when
   * the dispatch happened — the runner deletes the workspace at case end
   * (W1), so existence is only observable DURING the dispatch. */
  workspaceExistedAtDispatch = false;
  async run(invocation: OpInvocation): Promise<WorkerResult> {
    this.invocations.push(invocation);
    const workspace = /\nworkspace: (\S+)$/.exec(invocation.prompt)?.[1];
    this.workspaceExistedAtDispatch = workspace !== undefined && existsSync(workspace);
    return {
      model: invocation.modelSpec.model,
      structuredOutput: { verdict: 'resolved' },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete',
    };
  }
}

// D2: the fake smoke lane claims the subprocess lane (a fake local CLI
// transport), never ai-sdk. glm-5.3-flash @ zai is the axis-legal served id
// for any non-ai-sdk lane (ADR-0001).
const SMOKE_MODEL = { model: 'glm-5.3-flash', provider: 'zai', driverName: 'subprocess' } as const;

describe('micro suite loading (schema + semantic layers)', () => {
  it('loadSuite accepts both micro suite.json files', () => {
    const fixer = loadSuite(FIXER_SUITE_DIR);
    expect(fixer.name).toBe('micro');
    expect(fixer.role).toBe('fixer-worker');
    expect(fixer.cases.map((c) => c.id)).toEqual(['micro-1', 'micro-2', 'micro-3', 'micro-4', 'micro-5']);
    // Axis-1 matrix cells run other models: a micro suite must NOT pin
    // servedModel (the B3 seam check would refuse those cells).
    expect(fixer.servedModel).toBeUndefined();

    const classifier = loadSuite(CLASSIFIER_SUITE_DIR);
    expect(classifier.name).toBe('micro');
    expect(classifier.role).toBe('review-classifier');
    expect(classifier.cases.map((c) => c.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `thread-${String(i + 1).padStart(2, '0')}`),
    );
    expect(classifier.servedModel).toBeUndefined();
  });

  it('rejects a check-rerun probe whose check is not a Node script (D1 extension pattern)', () => {
    // The D1 pattern on probe.check (schema/suite.schema.json) is enforced by
    // the schema layer INSIDE loadSuite, so a suite.json naming a non-Node
    // check is refused at load with the pattern named in the error — never
    // silently loaded and only failing later as an unexecutable probe.
    const dir = join(wsRoot, 'bad-check-ext');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'suite.json'),
      JSON.stringify({
        name: 'bad-check-ext',
        role: 'fixer-worker',
        provenance: { origin: 'hand-seeded synthetic (phase-3 J3, 2026-09-16); no public-benchmark content' },
        cases: [
          {
            id: 'micro-1',
            fixture: 'fixtures/micro-1',
            task: { prompt: 'Fix the fault.' },
            probe: { kind: 'check-rerun', check: 'fixtures/micro-1/check.sh' },
          },
        ],
      }, null, 2) + '\n',
    );
    expect(() => loadSuite(dir)).toThrow(/must match pattern/);
  });
});

describe('micro fixture/payload integrity (everything a case references exists)', () => {
  it('every fixer fixture dir and check probe exists on disk', () => {
    const suite = loadSuite(FIXER_SUITE_DIR);
    for (const c of suite.cases) {
      if (c.probe.kind !== 'check-rerun') continue; // role pairing makes this unreachable; narrows the type
      expect(existsSync(join(REPO_ROOT, c.fixture)), `fixture ${c.fixture}`).toBe(true);
      expect(existsSync(join(REPO_ROOT, c.probe.check)), `check ${c.probe.check}`).toBe(true);
    }
  });

  it('every classifier payload exists, parses, and carries the recorded-SHAPE fields', () => {
    const suite = loadSuite(CLASSIFIER_SUITE_DIR);
    const verdictCounts = new Map<string, number>();
    for (const c of suite.cases) {
      if (c.probe.kind !== 'expected-verdict') continue;
      verdictCounts.set(c.probe.expected, (verdictCounts.get(c.probe.expected) ?? 0) + 1);
      const raw = readFileSync(join(REPO_ROOT, c.fixture), 'utf8');
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(raw);
      }, `${c.fixture} must parse as JSON`).not.toThrow();
      expect(isThreadPayload(parsed), `${c.fixture} must match the D5 payload shape`).toBe(true);
    }
    // Two payloads per expected verdict (D5): actionable, responded,
    // resolved, blocked, skip × 2. Sorted by the verdict string itself —
    // JS's default array sort orders "resolved" before "responded"
    // ('o' < 'p' at index 3), which is the honest alphabetical order here.
    expect([...verdictCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ['actionable', 2],
      ['blocked', 2],
      ['resolved', 2],
      ['responded', 2],
      ['skip', 2],
    ]);
  });
});

/**
 * The five fixed reference sources, embedded here (the former on-disk
 * `fixtures/solutions/` was removed, Codex P1). HONEST POSTURE (round 3):
 * these strings are still IN the tree — a worker that can read the repo
 * checkout can find them. The real defense is the dispatched worker
 * surface: today's toolkit lanes confine read/edit to the materialized
 * workspace and run to an empty default allowlist; the phase-4 residual
 * (host-privileged run tools) is recorded in suite.yml's ACCEPTED-RISK
 * block — see fixtures/README.md "Reference fixes". The map is keyed by
 * case id; `path` is the faulted file's workspace-relative location.
 */
const SOLUTIONS: Record<string, { path: string; content: string }> = {
  'micro-1': {
    path: 'src/rangeSum.ts',
    content: String.raw`// Sum utilities for integer ranges.
export function sumRange(a: number, b: number): number {
  let total = 0;
  for (let i = a; i <= b; i++) {
    total += i;
  }
  return total;
}
`,
  },
  'micro-2': {
    path: 'src/slugify.ts',
    content: String.raw`// Slug helpers for URL path segments.
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join('-');
}
`,
  },
  'micro-3': {
    path: 'src/memoize.ts',
    content: String.raw`// Call-count reducers for hot single-argument lookups.
export function memoize<A, B>(fn: (arg: A) => B): (arg: A) => B {
  const cache = new Map<A, B>();
  return (arg: A): B => {
    if (cache.has(arg)) {
      return cache.get(arg)!;
    }
    const value = fn(arg);
    cache.set(arg, value);
    return value;
  };
}
`,
  },
  'micro-4': {
    path: 'src/parseConfig.ts',
    content: String.raw`// Config parsing for the loader pipeline.
export function parseConfig(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid config');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid config');
  }
  return parsed as Record<string, unknown>;
}
`,
  },
  'micro-5': {
    path: 'src/sortTasks.ts',
    content: String.raw`// Ordering rules for the task board render.
export interface Task {
  id: number;
  priority: number;
  label: string;
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => b.priority - a.priority || a.id - b.id);
}
`,
  },
};

describe('fault discrimination (pristine fails, solution passes — the heart of J3)', () => {
  // Per case: copy the fixture to a tmp workspace exactly like the runner
  // materializes workspaces, run the case's OWN check probe there
  // (cwd = workspace copy, judge resolved from the repo root), expect
  // FAILURE on the seeded fault; then overwrite the faulted src with the
  // embedded reference fix and expect the SAME probe to PASS.
  const fixer = loadSuite(FIXER_SUITE_DIR);

  for (const c of fixer.cases) {
    if (!isFixerCase(c)) continue;
    // Destructure BEFORE the it() closure: TS cannot carry a nested
    // discriminant narrowing (c.probe.kind) into a callback — the same
    // limitation runner/suite.ts's isFixerCase predicate exists for.
    const { fixture, probe } = c;
    it(`${c.id}: judge fails on the pristine workspace, passes once the solution lands`, () => {
      const workspace = mkdtempSync(join(tmpdir(), 'cq-micro-ws-'));
      try {
        cpSync(join(REPO_ROOT, fixture), workspace, { recursive: true, verbatimSymlinks: true });
        const runJudge = (): number => runJudgeOrThrow(c.id, join(REPO_ROOT, probe.check), workspace);

        expect(runJudge(), `${c.id} must FAIL on the pristine (faulted) fixture`).not.toBe(0);

        // Adversarial variant (PR 10 review, batched into this loop): a
        // worker can plant an ALWAYS-PASS test into its workspace copy —
        // the test files are part of the judge, so the judge must restore
        // the pristine tests and still fail the faulted src.
        rmSync(join(workspace, 'test'), { recursive: true, force: true });
        mkdirSync(join(workspace, 'test'), { recursive: true });
        writeFileSync(
          join(workspace, 'test', 'gamed.test.ts'),
          "import { describe, expect, it } from 'vitest';\ndescribe('gamed', () => { it('always passes', () => { expect(1).toBe(1); }); });\n",
        );
        expect(runJudge(), `${c.id} must FAIL even with a planted always-pass test (pristine restore wins)`).not.toBe(0);
        // The judge put the real tests back over the plant.
        expect(existsSync(join(workspace, 'test', 'gamed.test.ts'))).toBe(false);

        // The reference fix exists ONLY as the embedded string above (Codex
        // P1 — no on-disk answer key): overwrite the faulted file with it.
        const solution = SOLUTIONS[c.id];
        expect(solution, `embedded reference fix for ${c.id}`).toBeDefined();
        mkdirSync(join(workspace, dirname(solution!.path)), { recursive: true });
        writeFileSync(join(workspace, solution!.path), solution!.content);

        expect(runJudge(), `${c.id} must PASS once the faulted src is fixed`).toBe(0);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }, PROBE_TIMEOUT_MS * 2 + 30_000);
  }
});

describe('judge integrity: planted vitest config cannot turn a faulted fixture green (PR 10 review)', () => {
  // Reviewer-reproduced bypass: a workspace vitest.config.mjs with
  // `{ test: { include: [], passWithNoTests: true } }` made the judge exit 0
  // on a FAULTED fixture — config discovery is a bypass. Two defenses, both
  // exercised here: the judge scrubs planted vitest/vite config files from
  // the workspace root, AND it spawns vitest with an EXPLICIT repo-side
  // judge config (fixtures/judge.vitest.config.mjs) so discovery cannot run
  // at all. Two representative fixtures; each case costs one real vitest
  // spawn.
  const fixer = loadSuite(FIXER_SUITE_DIR);
  for (const c of fixer.cases) {
    if (!isFixerCase(c)) continue;
    if (c.id !== 'micro-1' && c.id !== 'micro-5') continue;
    const { fixture, probe } = c;
    it(`${c.id}: planted passWithNoTests config is scrubbed and inert on a faulted workspace`, () => {
      const workspace = mkdtempSync(join(tmpdir(), 'cq-micro-cfg-'));
      try {
        cpSync(join(REPO_ROOT, fixture), workspace, { recursive: true, verbatimSymlinks: true });
        writeFileSync(
          join(workspace, 'vitest.config.mjs'),
          'export default { test: { include: [], passWithNoTests: true } };\n',
        );
        const status = runJudgeOrThrow(c.id, join(REPO_ROOT, probe.check), workspace);
        expect(status, `${c.id} must FAIL with src still faulted, planted config notwithstanding`).not.toBe(0);
        // The scrub removed the plant from the workspace root.
        expect(existsSync(join(workspace, 'vitest.config.mjs'))).toBe(false);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }, PROBE_TIMEOUT_MS + 30_000);
  }

  // FIX 5 (round 2): the two defenses above lean on vitest-5 INTERNALS.
  // These tests pin them so a vitest major bump cannot silently reopen
  // either bypass. micro-1 only — each costs a real vitest spawn and the
  // internals are per-runner, not per-fixture.

  it('micro-1: a planted workspace node_modules/vitest stub cannot satisfy the judge', () => {
    // Pinned internal #1 — import aliasing: the runner's vitest resolves
    // test files' `import 'vitest'` through its own alias and never
    // consults the workspace's node_modules. A planted stub like this could
    // shadow the test API if a vitest major bump changed that resolution;
    // on a FAULTED workspace the judge must fail regardless — what this
    // test forbids is the plant ever flipping a broken workspace green.
    const workspace = mkdtempSync(join(tmpdir(), 'cq-micro-nm-'));
    try {
      cpSync(join(REPO_ROOT, 'fixtures', 'micro-1'), workspace, { recursive: true, verbatimSymlinks: true });
      mkdirSync(join(workspace, 'node_modules', 'vitest'), { recursive: true });
      writeFileSync(
        join(workspace, 'node_modules', 'vitest', 'package.json'),
        JSON.stringify({ name: 'vitest', version: '0.0.0', type: 'module', main: './index.js', exports: './index.js' }) + '\n',
      );
      writeFileSync(
        join(workspace, 'node_modules', 'vitest', 'index.js'),
        "export const describe = () => { throw new Error('shadowed vitest API'); };\n" +
          'export const it = describe;\nexport const expect = describe;\n',
      );
      const status = runJudgeOrThrow('micro-1', join(REPO_ROOT, 'fixtures', 'micro-1', 'check.mjs'), workspace);
      expect(status, 'judge must FAIL on a faulted workspace regardless of the planted stub').not.toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, PROBE_TIMEOUT_MS + 30_000);

  it('micro-1: a planted vitest.workspace.mjs narrowed to a passing-only project cannot satisfy the judge', () => {
    // Pinned internal #2 — workspace discovery: vitest 5 does not discover
    // vitest.workspace.mjs at all (workspaces became in-config "projects"
    // in vitest 3), and the judge names --config, which disables discovery
    // besides. A workspace file narrowed to a passing-only project is
    // therefore inert; if a future vitest major re-enables workspace-file
    // discovery, this test fails loudly here instead of a faulted fixture
    // silently grading green.
    const workspace = mkdtempSync(join(tmpdir(), 'cq-micro-wsf-'));
    try {
      cpSync(join(REPO_ROOT, 'fixtures', 'micro-1'), workspace, { recursive: true, verbatimSymlinks: true });
      writeFileSync(
        join(workspace, 'vitest.workspace.mjs'),
        'export default { projects: [{ test: { include: [], passWithNoTests: true } }] };\n',
      );
      const status = runJudgeOrThrow('micro-1', join(REPO_ROOT, 'fixtures', 'micro-1', 'check.mjs'), workspace);
      expect(status, 'judge must FAIL on a faulted workspace regardless of the planted workspace file').not.toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, PROBE_TIMEOUT_MS + 30_000);

  it('micro-1: a symlinked escape out of the graded tree fails closed (the walk is load-bearing)', () => {
    // The reviewer-reproduced bypass this containment walk exists for: the
    // worker owns the workspace tree and can replace src with a symlink to
    // a FIXED copy living OUTSIDE the workspace — without the walk that
    // grades green without a real fix. The reference fix now lives only in
    // this file, so the outside target is a throwaway copy built beside the
    // workspace. Asserts BOTH the exit status and the walk's own marker in
    // stderr — the failure must be the containment refusal, not something
    // incidental.
    const outside = mkdtempSync(join(tmpdir(), 'cq-micro-out-'));
    const workspace = mkdtempSync(join(tmpdir(), 'cq-micro-lnk-'));
    try {
      mkdirSync(join(outside, 'src'), { recursive: true });
      writeFileSync(join(outside, 'src', 'rangeSum.ts'), SOLUTIONS['micro-1']!.content);
      cpSync(join(REPO_ROOT, 'fixtures', 'micro-1'), workspace, { recursive: true, verbatimSymlinks: true });
      rmSync(join(workspace, 'src'), { recursive: true, force: true });
      symlinkSync(join(outside, 'src'), join(workspace, 'src'));
      const res = spawnSync(process.execPath, [join(REPO_ROOT, 'fixtures', 'micro-1', 'check.mjs')], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      expect(res.status, 'the escape must fail closed with exit 1, never grade the outside fix').toBe(1);
      expect(res.stderr).toContain('workspace escape');
      expect(res.stderr).toContain('refusing to judge');
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, PROBE_TIMEOUT_MS + 30_000);
});

describe('fake-driver smoke over the micro suites (D2 subprocess lane)', () => {
  it('fixer micro: 5 rows, every row scores 0 — the fake cannot fix fixtures', async () => {
    const result = await runSuite({ suiteDir: FIXER_SUITE_DIR, driver: new FakeDriver(), ...SMOKE_MODEL });
    expect(result.rows).toHaveLength(5);
    // Plumbing-smoke honesty: an untouched faulted fixture must fail the
    // judge. These are zeros about a FAKE, not an eval verdict.
    expect(result.rows.every((r) => r.outcome.passed === 0)).toBe(true);
    // DD-4: a fixer row carries TWO probes (check-rerun + schema
    // compliance) — and the fake fails both: it cannot fix, and its
    // verdict-shaped structuredOutput is not the fixer's {fixed, notes}
    // shape, so the schema-compliance probe honestly reads 0 too.
    expect(result.rows.every((r) => r.outcome.total === 2)).toBe(true);
    expect(result.rows.every((r) => r.driver === 'subprocess')).toBe(true);
    expect(result.tables[0]?.cells).toEqual([
      expect.objectContaining({ model: 'glm-5.3-flash', driver: 'subprocess', runs: 5, passed: 0, total: 10 }),
    ]);
    assertSchemaValid(result.rows, result.tables);
  }, 300_000);

  it('classifier micro: 10 rows, exactly the two resolved-expected rows pass', async () => {
    // FakeDriver's hardcoded verdict is 'resolved', so the honest smoke
    // expectation is derivable from the suite data: the 2 resolved-expected
    // cases pass, the other 8 do not.
    const suite = loadSuite(CLASSIFIER_SUITE_DIR);
    const resolvedCases = suite.cases
      .filter((c) => c.probe.kind === 'expected-verdict' && c.probe.expected === 'resolved')
      .map((c) => c.id);
    expect(resolvedCases).toHaveLength(2);

    const result = await runSuite({ suiteDir: CLASSIFIER_SUITE_DIR, driver: new FakeDriver(), ...SMOKE_MODEL });
    expect(result.rows).toHaveLength(10);
    expect(result.rows.filter((r) => r.outcome.passed === 1).map((r) => r.case).sort()).toEqual(resolvedCases.sort());
    expect(result.rows.every((r) => r.driver === 'subprocess')).toBe(true);
    assertSchemaValid(result.rows, result.tables);
  }, 60_000);

  it('every smoke row carries token-derived costUSD with costBasis modeled (glm-5.3-flash/zai is priced since the F1 price-map pin)', async () => {
    // Re-pinned at the F1b interim lock (cq-toolkit main 5e52707, v1.0.1): the
    // price map now lists glm-5.3-flash on the zai handle, so the honest value
    // is a modeled number — never a null (the pre-price-map expectation this
    // test used to carry). The DD-9 null corollary is still covered in
    // runner.test.ts against a genuinely unpriced handle.
    const spec = { model: 'glm-5.3-flash', provider: 'zai' };
    expect(priceOf(spec)).toBeDefined();
    expect(computeCostUSD(spec, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 })).toBeGreaterThan(0);

    const result = await runSuite({ suiteDir: CLASSIFIER_SUITE_DIR, driver: new FakeDriver(), ...SMOKE_MODEL });
    for (const row of result.rows) {
      expect(typeof row.costUSD).toBe('number');
      expect(row.costUSD).toBeGreaterThan(0);
      expect(row.costBasis).toBe('modeled');
    }
    assertSchemaValid(result.rows, result.tables);
  }, 60_000);
});

class BindingDriver implements Driver {
  readonly sessions: string[] = [];
  readonly workspaces: string[] = [];
  async run(invocation: OpInvocation): Promise<WorkerResult> {
    expect(invocation.sessionRef).toBeDefined();
    const store = new SessionStore(join(/\nworkspace: (\S+)$/.exec(invocation.prompt)![1]!, '.cq-sessions'));
    const record = await store.load(invocation.sessionRef!);
    expect(record?.workspace).toBe(/\nworkspace: (\S+)$/.exec(invocation.prompt)![1]);
    this.sessions.push(invocation.sessionRef!);
    this.workspaces.push(record!.workspace);
    const source = join(record!.workspace, 'src', 'rangeSum.ts');
    if (existsSync(source)) {
      writeFileSync(source,
        'export function sumRange(a: number, b: number): number { let total = 0; for (let i = a; i <= b; i++) total += i; return total; }\\n');
    }
    return {
      model: invocation.modelSpec.model,
      structuredOutput: { fixed: true, notes: 'workspace-bound round trip' },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      denials: [], stopReason: 'complete',
    };
  }
}

describe('payload/workspaces injection into prompts (J3 D3)', () => {
  it('classifier prompts carry the thread payload content', async () => {
    const suite = loadSuite(CLASSIFIER_SUITE_DIR);
    const driver = new CapturingDriver();
    await runSuite({ suiteDir: CLASSIFIER_SUITE_DIR, driver, ...SMOKE_MODEL });

    expect(driver.invocations).toHaveLength(10);
    for (const [i, c] of suite.cases.entries()) {
      const prompt = driver.invocations[i]!.prompt;
      // The injection marker names the fixture the payload came from...
      expect(prompt, `case ${c.id} prompt must carry the injection marker`).toContain(
        `Thread payload (fixture ${c.fixture}):`,
      );
      // ...and the payload CONTENT itself (first comment body, verbatim).
      const payload = JSON.parse(readFileSync(join(REPO_ROOT, c.fixture), 'utf8')) as ThreadPayload;
      expect(prompt, `case ${c.id} prompt must carry the payload body`).toContain(payload.comments[0]!.body);
    }
  }, 60_000);

  it('fixer round trip edits the graded copy and passes its check', async () => {
    const dir = join(wsRoot, 'bound-round-trip');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'suite.json'), JSON.stringify({
      name: 'bound-round-trip', role: 'fixer-worker',
      provenance: { origin: 'W6.1 workspace binding test' },
      cases: [{ id: 'micro-1', fixture: 'fixtures/micro-1', task: { prompt: 'Fix sumRange.' }, probe: { kind: 'check-rerun', check: 'fixtures/micro-1/check.mjs' } }],
    }, null, 2) + '\\n');
    const driver = new BindingDriver();
    const result = await runSuite({ suiteDir: dir, driver, ...SMOKE_MODEL });
    expect(result.rows[0]?.outcome.passed).toBe(2);
    expect(driver.sessions).toHaveLength(1);
  }, 120_000);

  it('fixer sessions isolate successive graded copies', async () => {
    const dir = join(wsRoot, 'bound-isolation');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'suite.json'), JSON.stringify({
      name: 'bound-isolation', role: 'fixer-worker',
      provenance: { origin: 'W6.1 workspace isolation test' },
      cases: [
        { id: 'micro-1', fixture: 'fixtures/micro-1', task: { prompt: 'Fix one.' }, probe: { kind: 'check-rerun', check: 'fixtures/micro-1/check.mjs' } },
        { id: 'micro-2', fixture: 'fixtures/micro-2', task: { prompt: 'Fix two.' }, probe: { kind: 'check-rerun', check: 'fixtures/micro-2/check.mjs' } },
      ],
    }, null, 2) + '\\n');
    const driver = new BindingDriver();
    await runSuite({ suiteDir: dir, driver, ...SMOKE_MODEL });
    expect(driver.sessions[0]).not.toBe(driver.sessions[1]);
    expect(driver.workspaces[0]).not.toBe(driver.workspaces[1]);
  }, 120_000);

  it('fixer prompts carry the materialized workspace path', async () => {
    // One-case suite referencing the REAL micro-1 fixture so exactly one
    // judge run pays the vitest startup cost; the repo root is the runner
    // default, so 'fixtures/micro-1' resolves against the repo like a real
    // dispatch.
    const dir = join(wsRoot, 'single-fixer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'suite.json'),
      JSON.stringify({
        name: 'single-fixer',
        role: 'fixer-worker',
        provenance: { origin: 'test-local single-case slice of suites/fixer-worker/micro' },
        cases: [
          {
            id: 'micro-1',
            fixture: 'fixtures/micro-1',
            task: { prompt: 'The workspace at the path below contains a TypeScript package whose vitest suite fails.' },
            probe: { kind: 'check-rerun', check: 'fixtures/micro-1/check.mjs' },
          },
        ],
      }, null, 2) + '\n',
    );
    const driver = new CapturingDriver();
    await runSuite({ suiteDir: dir, driver, ...SMOKE_MODEL });

    const prompt = driver.invocations[0]!.prompt;
    expect(prompt).toMatch(/\nworkspace: \S+$/);
    // Existence is asserted AT DISPATCH TIME (the driver probes it): the
    // runner removes the materialized workspace in its per-case finally (W1),
    // so the captured path no longer exists by the time runSuite returns.
    expect(driver.workspaceExistedAtDispatch).toBe(true);
  }, 120_000);
});

describe('guarded infrastructure failures are materialization-class (rounds 2-3 honesty taxonomy)', () => {
  it('an unreadable payload emits NO row, counts a materialization failure, and never dispatches', async () => {
    // Cycle-2 CLI review: the payload read is INFRASTRUCTURE — the driver
    // never ran — so it mirrors the fixer materialization guard (T2):
    // journal indeterminate, diagnostic, materializationFailures increment,
    // NO row. The old behavior misclassified the read throw as a driver
    // error and emitted a scored failed row — a fabricated eval outcome.
    const dir = join(wsRoot, 'missing-payload');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'suite.json'),
      JSON.stringify({
        name: 'missing-payload',
        role: 'review-classifier',
        provenance: { origin: 'test-local single-case slice of suites/review-classifier/micro' },
        cases: [
          {
            id: 'thread-missing',
            fixture: 'fixtures/threads/does-not-exist.json',
            task: { prompt: 'Classify the review thread payload printed below.' },
            probe: { kind: 'expected-verdict', expected: 'resolved' },
          },
        ],
      }, null, 2) + '\n',
    );
    const driver = new CapturingDriver();
    const result = await runSuite({ suiteDir: dir, driver, ...SMOKE_MODEL });

    expect(driver.invocations).toHaveLength(0); // the driver never ran
    expect(result.rows).toEqual([]); // no fabricated scored zero
    expect(result.materializationFailures).toBe(1);
    expect(result.tables[0]?.cells).toEqual([]); // empty-but-valid table
    expect(result.diagnostics).toEqual([
      expect.stringMatching(/^case thread-missing: fixture read failed for 'fixtures\/threads\/does-not-exist\.json': /),
    ]);
    // Round 3 (FIX 4): the structured channel carries the same line, so the
    // CLI's X2 block lists the case without re-matching prose.
    expect(result.materializationDiagnostics).toEqual([
      expect.stringMatching(/^case thread-missing: fixture read failed for 'fixtures\/threads\/does-not-exist\.json': /),
    ]);
  }, 60_000);

  it('an uncopyable FIXER fixture surfaces through the same structured channel', async () => {
    // FIX 4 (round 3): both infrastructure shapes are carried in
    // materializationDiagnostics — asserted here for the fixer copy-failure
    // class (the classifier read-failure class is asserted above).
    const dir = join(wsRoot, 'missing-fixer-fixture');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'suite.json'),
      JSON.stringify({
        name: 'missing-fixer-fixture',
        role: 'fixer-worker',
        provenance: { origin: 'test-local single-case slice of suites/fixer-worker/micro' },
        cases: [
          {
            id: 'micro-missing',
            fixture: 'fixtures/micro-missing',
            task: { prompt: 'The workspace at the path below contains a TypeScript package whose vitest suite fails.' },
            probe: { kind: 'check-rerun', check: 'fixtures/micro-missing/check.mjs' },
          },
        ],
      }, null, 2) + '\n',
    );
    const result = await runSuite({ suiteDir: dir, driver: new CapturingDriver(), ...SMOKE_MODEL });
    expect(result.rows).toEqual([]);
    expect(result.materializationFailures).toBe(1);
    expect(result.materializationDiagnostics).toEqual([
      expect.stringMatching(/^case micro-missing: fixture materialization failed for 'fixtures\/micro-missing': /),
    ]);
  }, 60_000);

  it('a payload that reads but is not valid JSON is materialization-class too (FIX 5)', async () => {
    // Round 3: a parse failure is infrastructure, never a dispatched
    // scored-0 row — the classifier can never see a usable task. The target
    // is a REAL repo file that is not JSON (fixtures/README.md), so no
    // dedicated bad fixture file had to be authored.
    const dir = join(wsRoot, 'non-json-payload');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'suite.json'),
      JSON.stringify({
        name: 'non-json-payload',
        role: 'review-classifier',
        provenance: { origin: 'test-local single-case slice of suites/review-classifier/micro' },
        cases: [
          {
            id: 'thread-not-json',
            fixture: 'fixtures/README.md',
            task: { prompt: 'Classify the review thread payload printed below.' },
            probe: { kind: 'expected-verdict', expected: 'resolved' },
          },
        ],
      }, null, 2) + '\n',
    );
    const driver = new CapturingDriver();
    const result = await runSuite({ suiteDir: dir, driver, ...SMOKE_MODEL });

    expect(driver.invocations).toHaveLength(0);
    expect(result.rows).toEqual([]);
    expect(result.materializationFailures).toBe(1);
    expect(result.materializationDiagnostics).toEqual([
      expect.stringMatching(/^case thread-not-json: thread payload is not valid JSON for 'fixtures\/README\.md': /),
    ]);
  }, 60_000);
});
