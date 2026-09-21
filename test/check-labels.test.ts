import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Hermetic tests for scripts/check-classifier-labels.mjs (r1-F5): the gate
// that protects the corpus gets its own tests. Each test builds a tmp repo
// root holding a COPY of the guide + breadth suites + sidecars, so the real
// tree is never touched. Green path runs the real 60-case corpus (floors
// are absolute — a toy suite could never satisfy them); negative paths
// mutate one copied file and assert a nonzero exit naming the case.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-classifier-labels.mjs');
const SUITES = 'suites/review-classifier/breadth-verified,suites/review-classifier/breadth-tail';

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-labels-test-'));
  sandboxes.push(dir);
  cpSync(join(REPO_ROOT, 'suites', 'review-classifier'), join(dir, 'suites', 'review-classifier'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', 'threads'), join(dir, 'fixtures', 'threads'), { recursive: true });
  return dir;
}

function runCheck(dir: string): { status: number; output: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, '--repo', dir, '--suites', SUITES], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: String(stdout) };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string; stdout?: Buffer | string };
    return { status: e.status ?? 1, output: String(e.stderr ?? e.stdout ?? '') };
  }
}

describe('check-classifier-labels gate (r1-F5)', () => {
  it('green path: the copied real corpus exits 0 with the counts', () => {
    const { status, output } = runCheck(sandbox());
    expect(status).toBe(0);
    expect(output).toMatch(/suspicious-benign=20 \(floor 20\)/);
    expect(output).toMatch(/adversarial-reply=9 \(floor 6\)/);
  }, 30_000);

  it('a sidecar whose expected drifts from probe.expected exits nonzero naming the case', () => {
    const dir = sandbox();
    const labelFile = join(dir, 'fixtures', 'threads', 'bv-01.label.json');
    const label = JSON.parse(readFileSync(labelFile, 'utf8')) as { expected: string };
    label.expected = 'skip';
    writeFileSync(labelFile, JSON.stringify(label, null, 2) + '\n');
    const { status, output } = runCheck(dir);
    expect(status).toBe(1);
    expect(output).toMatch(/FAIL breadth-verified\/bv-01: sidecar\.expected/);
  }, 30_000);

  it('a concern_group outside the guide §2 taxonomy exits nonzero (r1-F1)', () => {
    const dir = sandbox();
    const labelFile = join(dir, 'fixtures', 'threads', 'bv-02.label.json');
    const label = JSON.parse(readFileSync(labelFile, 'utf8')) as { concern_group: string };
    label.concern_group = 'Logic&functionality';
    writeFileSync(labelFile, JSON.stringify(label, null, 2) + '\n');
    const { status, output } = runCheck(dir);
    expect(status).toBe(1);
    expect(output).toMatch(/FAIL breadth-verified\/bv-02: sidecar\.concern_group .* outside the guide/);
  }, 30_000);

  it('status agreed with a dissenting annotator verdict exits nonzero (r1-F2)', () => {
    const dir = sandbox();
    const labelFile = join(dir, 'fixtures', 'threads', 'bv-03.label.json');
    const label = JSON.parse(readFileSync(labelFile, 'utf8')) as {
      annotators: Array<{ id: string; verdict: string }>;
    };
    label.annotators[1]!.verdict = 'skip';
    writeFileSync(labelFile, JSON.stringify(label, null, 2) + '\n');
    const { status, output } = runCheck(dir);
    expect(status).toBe(1);
    expect(output).toMatch(/FAIL breadth-verified\/bv-03: status agreed but annotator verdicts/);
  }, 30_000);

  it('a missing sidecar exits nonzero naming the case', () => {
    const dir = sandbox();
    rmSync(join(dir, 'fixtures', 'threads', 'bt-05.label.json'));
    const { status, output } = runCheck(dir);
    expect(status).toBe(1);
    expect(output).toMatch(/FAIL breadth-tail\/bt-05: missing or unparseable sidecar/);
  }, 30_000);

  it('suspicious-benign on an actionable expected verdict exits nonzero (bot T4)', () => {
    const dir = sandbox();
    // bv-04 is actionable: flag it benign in BOTH sidecar and notes so
    // only the T4 rule (not notes agreement) fires.
    const labelFile = join(dir, 'fixtures', 'threads', 'bv-04.label.json');
    const label = JSON.parse(readFileSync(labelFile, 'utf8')) as { fp_flag: string };
    label.fp_flag = 'suspicious-benign';
    writeFileSync(labelFile, JSON.stringify(label, null, 2) + '\n');
    const suiteFile = join(dir, 'suites', 'review-classifier', 'breadth-verified', 'suite.json');
    const suite = JSON.parse(readFileSync(suiteFile, 'utf8')) as {
      cases: Array<{ id: string; task: { notes: string } }>;
    };
    const bv04 = suite.cases.find((c) => c.id === 'bv-04')!;
    bv04.task.notes = bv04.task.notes.replace('fp_flag: none', 'fp_flag: suspicious-benign');
    writeFileSync(suiteFile, JSON.stringify(suite, null, 2) + '\n');
    const { status, output } = runCheck(dir);
    expect(status).toBe(1);
    expect(output).toMatch(/FAIL breadth-verified\/bv-04: suspicious-benign requires a non-actionable/);
  }, 30_000);

  it('a single-annotator tail case with zero annotators exits nonzero (bot T5a)', () => {
    const dir = sandbox();
    const labelFile = join(dir, 'fixtures', 'threads', 'bt-06.label.json');
    const label = JSON.parse(readFileSync(labelFile, 'utf8')) as { annotators: unknown[] };
    label.annotators = [];
    writeFileSync(labelFile, JSON.stringify(label, null, 2) + '\n');
    const { status, output } = runCheck(dir);
    expect(status).toBe(1);
    expect(output).toMatch(/FAIL breadth-tail\/bt-06: single-annotator tail case needs exactly 1 annotator/);
  }, 30_000);

  it('an agreed expected outside its annotator verdicts exits nonzero (bot T5b)', () => {
    const dir = sandbox();
    // bv-05 is agreed-actionable: move BOTH sidecar and probe expected to
    // skip (unanimous annotators say actionable) so only the membership
    // rule fires; the verdict-balance floor noise is irrelevant to the regex.
    const labelFile = join(dir, 'fixtures', 'threads', 'bv-05.label.json');
    const label = JSON.parse(readFileSync(labelFile, 'utf8')) as { expected: string };
    label.expected = 'skip';
    writeFileSync(labelFile, JSON.stringify(label, null, 2) + '\n');
    const suiteFile = join(dir, 'suites', 'review-classifier', 'breadth-verified', 'suite.json');
    const suite = JSON.parse(readFileSync(suiteFile, 'utf8')) as {
      cases: Array<{ id: string; probe: { expected: string } }>;
    };
    suite.cases.find((c) => c.id === 'bv-05')!.probe.expected = 'skip';
    writeFileSync(suiteFile, JSON.stringify(suite, null, 2) + '\n');
    const { status, output } = runCheck(dir);
    expect(status).toBe(1);
    expect(output).toMatch(/FAIL breadth-verified\/bv-05: status agreed but expected 'skip' matches no annotator verdict/);
  }, 30_000);
});
