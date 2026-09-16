// Shared immutable-judge implementation for the micro fixtures — ONE judge,
// five thin shims (fresh-reviewer round 1, PR 10; hardened round 2). This
// lib lives at the fixtures/ level and is NEVER materialized into a worker
// workspace; the repo-side check.mjs shims import it by relative path and
// only identify WHICH fixture they judge.
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
// - The workspace tree is graded ONLY where it physically lives: the worker
//   owns the tree and may plant symlinks — e.g. src replaced by a symlink
//   pointing at a fixed copy OUTSIDE the workspace, graded as passing
//   (reviewer-reproduced, round 2). Every non-directory entry is
//   realpath-resolved and verified to stay inside the workspace's own
//   realpath; the first escape fails closed.
//
// - FAIL CLOSED everywhere: misuse (ANY cwd inside the repo — the judge
//   only ever grades materialized tmpdir workspaces), an escaped or
//   unresolvable graded-tree entry, a missing vitest entry, or a spawn
//   failure each yield a one-line stderr reason and exit 1 — a judge that
//   cannot judge never passes.
//
// The judge re-runs the fixture's vitest suite against cwd. Vitest is
// loaded from the REPO's node_modules — the fixture workspace is a
// zero-dependency package with no node_modules of its own — and is handed
// `--root <cwd>` so it discovers tests inside the workspace, not the repo.
// Output is piped and then forwarded: the runner scores the exit status and
// trims diagnostics to its own tail, so a red suite must still carry its
// evidence without flooding the row.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
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

/**
 * Ceiling for the spawned vitest run. LAYERING (round-2 review): the
 * runner's scorer default (runner/score/fixerWorker.ts
 * DEFAULT_CHECK_TIMEOUT_MS = 60_000) kills the whole probe before this
 * judge's own ceiling would fire unless the operator raises
 * --check-timeout-ms — so this ceiling must stay BELOW it; micro probes run
 * in ~1-2s, 45s is generous headroom.
 */
const VITEST_TIMEOUT_MS = 45_000;

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
 *   only on the early infrastructure guards, and sets process.exitCode = 1
 *   with a one-line stderr reason on any fail-closed refusal.
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

  // FAIL CLOSED on misuse (round 2, widened round 3 — one-directional guard
  // fixed): the judge is only ever executed with cwd = a MATERIALIZED
  // WORKSPACE COPY under os.tmpdir (the runner's mkdtempSync), so ANY cwd
  // whose realpath lies inside the repo is misuse by construction. The
  // round-2 guard only refused when the cwd CONTAINED the pristine fixture
  // dir, but a cwd INSIDE the repo without containing it (e.g.
  // fixtures/micro-1/src or <repo>/test) proceeded and MUTATED the pristine
  // tree in place — restoring test/ and scrubbing configs over repo content
  // (reviewer-reproduced). realpath on BOTH sides keeps the comparison
  // honest across tmpdir symlink chains (/tmp vs /private/tmp); an
  // unresolvable cwd is refused too. This subsumes the old direction: any
  // cwd containing the fixture dir is inside the repo.
  let cwdReal;
  try {
    cwdReal = realpathSync(process.cwd());
  } catch {
    console.error(`${judgeLabel}: misuse — cwd does not resolve; refusing to judge (fail closed)`);
    process.exitCode = 1;
    return;
  }
  const repoRootReal = realpathSync(repoRoot);
  const relCwdToRepo = relative(repoRootReal, cwdReal);
  const cwdInsideRepo = relCwdToRepo === '' || (!relCwdToRepo.startsWith('..') && !isAbsolute(relCwdToRepo));
  if (cwdInsideRepo) {
    console.error(
      `${judgeLabel}: misuse — cwd is inside the repo (${cwdReal}); only materialized tmpdir workspaces are graded; refusing to judge (fail closed)`,
    );
    process.exitCode = 1;
    return;
  }

  // Restore the pristine tests (see contract: the tests are part of the judge).
  const pristineTestDir = join(fixtureDir, 'test');
  rmSync(join(process.cwd(), 'test'), { recursive: true, force: true });
  cpSync(pristineTestDir, join(process.cwd(), 'test'), { recursive: true });
  // Scrub worker-planted config files from the workspace root (see
  // contract: config discovery is a bypass). Belt one of two — the
  // explicit --config below is belt two.
  for (const name of PLANTED_CONFIG_FILES) {
    rmSync(join(process.cwd(), name), { recursive: true, force: true });
  }

  // Graded-tree containment (round 2): every non-directory entry in the
  // workspace must realpath-resolve INSIDE the workspace's own realpath.
  // Directories reached by readdir are physical by construction (a symlinked
  // directory is reported as a symlink and checked through its target
  // instead). An unresolvable entry (dangling link) resolves nowhere, so it
  // grades nothing and also fails closed.
  const workspaceReal = cwdReal;
  const escapeReason = (entryPath) => {
    let resolved;
    try {
      resolved = realpathSync(entryPath);
    } catch {
      return 'does not resolve (dangling link?)';
    }
    const relToWorkspace = relative(workspaceReal, resolved);
    return relToWorkspace !== '' && (relToWorkspace.startsWith('..') || isAbsolute(relToWorkspace))
      ? `resolves outside the workspace (${resolved})`
      : undefined;
  };
  const walkGradedTree = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!walkGradedTree(join(dir, entry.name))) return false;
        continue;
      }
      const reason = escapeReason(join(dir, entry.name));
      if (reason !== undefined) {
        console.error(`${judgeLabel}: workspace escape — ${join(dir, entry.name)} ${reason}; refusing to judge (fail closed)`);
        return false;
      }
    }
    return true;
  };
  if (!walkGradedTree(process.cwd())) {
    process.exitCode = 1;
    return;
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
