// Shared immutable-judge implementation for the micro fixtures — ONE judge,
// five thin shims (fresh-reviewer round 1, PR 10: the judge bypass fix and
// the deduplication fix). This lib lives at the fixtures/ level and is NEVER
// materialized into a worker workspace; the repo-side check.mjs shims import
// it by relative path and only identify WHICH fixture they judge.
//
// THE DECIDED PROBE CONTRACT (suites/README.md, phase-3 J3), enforced here:
//
// - Immutable scorer: the calling check.mjs resolves from the REPO ROOT, so
//   a worker grading its own workspace copy cannot rewrite its judge — the
//   copy a worker edits is materialized in a temp dir, while the judge files
//   are read from the pristine repo. The calling shim's import.meta.url is
//   passed in (judgeUrl) and resolves both the pristine fixture dir and the
//   repo root. The judge must NOT relative-require fixture modules — a
//   relative require would resolve against the pristine fixture under the
//   repo root, not the copy being graded; the workspace is reached
//   exclusively through process.cwd().
//
// - The fixture's test/ directory is PART OF THE JUDGE: before every
//   scoring run it is restored PRISTINE from the judge's own fixture dir
//   into the workspace, because a worker could otherwise weaken assertions
//   or drop an always-pass test file into its workspace copy and pass the
//   probe without fixing the fault. Only the worker's src/ changes can move
//   the verdict.
//
// - Config files are part of the judge too: a worker-planted workspace
//   vitest.config.mjs with `{ test: { include: [], passWithNoTests: true } }`
//   made this judge exit 0 on a FAULTED fixture (reviewer-reproduced) —
//   config discovery is a bypass. Two defenses: planted
//   vitest.config.*/vite.config.* files are scrubbed from the workspace
//   root, AND vitest is spawned with an EXPLICIT --config pointing at the
//   repo-side fixtures/judge.vitest.config.mjs — naming a config disables
//   discovery entirely, so even a missed or oddly-named planted config is
//   inert.
//
// - The judge re-runs the fixture's vitest suite against cwd. Vitest is
//   loaded from the REPO's node_modules — the fixture workspace is a
//   zero-dependency package with no node_modules of its own — and is handed
//   `--root <cwd>` so it discovers tests inside the workspace, not the repo.
//   Output is piped and then forwarded: the runner scores the exit status
//   and trims diagnostics to its own tail, so a red suite must still carry
//   its evidence without flooding the row.
//
// A probe that cannot run (missing vitest entry, spawn failure) exits 1
// with a one-line stderr reason — a judge that cannot judge never passes.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Worker-planted config file names that would hijack vitest/vite config
 * discovery in the workspace root. Scrubbed before every scoring run.
 */
const PLANTED_CONFIG_FILES = [
  'vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts',
  'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  'vite.config.ts', 'vite.config.mts', 'vite.config.cts',
  'vite.config.js', 'vite.config.mjs', 'vite.config.cjs',
];

/** Ceiling for the spawned vitest run: a looping suite must never stall the scoring probe. */
const VITEST_TIMEOUT_MS = 120_000;

/**
 * Run the shared vitest judge for one micro fixture. Plain JS (no TS
 * annotations): the judge is spawned by bare `node <check.mjs>` — Node does
 * not strip types from .mjs, so type annotations here would be syntax
 * errors; JSDoc carries the types for human readers instead.
 *
 * @param {{ judgeUrl: string, judgeLabel: string }} options
 * @param {string} options.judgeUrl - the CALLING check.mjs's own
 *   import.meta.url: its directory IS the pristine repo-root fixture, and
 *   the repo root sits two levels above it.
 * @param {string} options.judgeLabel - label used in one-line stderr reasons.
 * @returns {void} never normally: sets process.exitCode to the vitest
 *   child's status (a signal kill counts as failure); calls process.exit(1)
 *   only on the early infrastructure guards.
 */
export function runVitestJudge(options) {
  const { judgeUrl, judgeLabel } = options;
  const fixtureDir = dirname(fileURLToPath(judgeUrl));
  const repoRoot = join(fixtureDir, '..', '..');
  const vitestMjs = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestMjs)) {
    console.error(`${judgeLabel}: vitest entry not found at ${vitestMjs} (run npm install at the repo root)`);
    process.exit(1);
  }

  // Guard: the judge is only ever executed with cwd = a MATERIALIZED
  // WORKSPACE COPY. A cwd that CONTAINS this fixture dir (the repo root,
  // fixtures/, the fixture dir itself) is misuse — restoring or scrubbing
  // there would delete or overwrite repo content (the repo's own test/,
  // the repo's vitest.config.ts) — so both workspace repairs are skipped
  // and the run proceeds against whatever cwd actually holds.
  const pristineTestDir = join(fixtureDir, 'test');
  const cwdToFixture = relative(process.cwd(), fixtureDir);
  const fixtureInsideCwd = cwdToFixture === '' || (!cwdToFixture.startsWith('..') && !isAbsolute(cwdToFixture));
  if (!fixtureInsideCwd) {
    // Restore the pristine tests (see contract: the tests are part of the judge).
    rmSync(join(process.cwd(), 'test'), { recursive: true, force: true });
    cpSync(pristineTestDir, join(process.cwd(), 'test'), { recursive: true });
    // Scrub worker-planted config files from the workspace root (see
    // contract: config discovery is a bypass). Belt one of two — the
    // explicit --config below is belt two.
    for (const name of PLANTED_CONFIG_FILES) {
      rmSync(join(process.cwd(), name), { recursive: true, force: true });
    }
  }

  const res = spawnSync(
    process.execPath,
    [vitestMjs, 'run', '--root', process.cwd(), '--config', join(repoRoot, 'fixtures', 'judge.vitest.config.mjs')],
    { stdio: 'pipe', timeout: VITEST_TIMEOUT_MS },
  );
  if (res.error !== undefined && res.error !== null) {
    console.error(`${judgeLabel}: could not execute the vitest run: ${res.error.message}`);
    process.exit(1);
  }
  // Forward the captured vitest diagnostics: the runner scores the exit code
  // and trims these bytes to its own diagnostics tail, so a red suite must
  // still carry its evidence.
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  // Set — never hard-exit: assigning process.exitCode lets the lib end
  // naturally so the forwarded bytes above flush (a hard process.exit can
  // truncate pending pipe writes). A signal kill (status null, e.g. the
  // spawn timeout firing) is a failure, never a pass.
  process.exitCode = res.status ?? 1;
}
