// Immutable judge for the micro-3 fixture — the decided probe contract
// (suites/README.md, phase-3 J3). This script resolves from the REPO ROOT,
// so a worker grading its own workspace copy cannot rewrite it: the copy a
// worker edits is materialized in a temp dir, while THIS file is read from
// the pristine repo. The workspace under judgment is reached exclusively
// through process.cwd(): the runner executes this judge with cwd set to the
// materialized workspace copy. This script must NOT relative-require fixture
// modules — a relative require would resolve against the pristine fixture
// under the repo root, not the copy being graded.
//
// The fixture's test/ directory is PART OF THE JUDGE (cycle-2 CLI review):
// before every scoring run it is restored PRISTINE from this judge's own
// directory — which IS the pristine repo-root fixture — into the workspace,
// because a worker could otherwise weaken assertions or drop an always-pass
// test file into its workspace copy and pass the probe without fixing the
// fault. Only the worker's src/ changes can move the verdict.
//
// The judge re-runs the fixture's vitest suite against that cwd. Vitest is
// loaded from the REPO's node_modules — the fixture workspace is a
// zero-dependency package with no node_modules of its own — and is handed
// `--root <cwd>` so it discovers tests inside the workspace, not the repo.
// Output is piped, not inherited: the runner scores the exit status and
// trims diagnostics to its own tail, so a red suite must not flood the row.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fixtures/micro-3/check.mjs -> this judge's own directory is the pristine
// repo-root fixture; the repo root is two levels above it.
const fixtureDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(fixtureDir, '..', '..');
const vitestMjs = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitestMjs)) {
  console.error(`micro-3 judge: vitest entry not found at ${vitestMjs} (run npm install at the repo root)`);
  process.exit(1);
}

// Restore the pristine test directory into the workspace under judgment
// (see header: the tests are part of the judge). Guard: the judge is only
// ever executed with cwd = a MATERIALIZED WORKSPACE COPY. A cwd that
// CONTAINS this fixture dir (the repo root, fixtures/, the fixture dir
// itself) is misuse — restoring there would delete or overwrite repo
// content (e.g. the repo's own test/) — so the restore is skipped and the
// run proceeds against whatever cwd actually holds.
const pristineTestDir = join(fixtureDir, 'test');
const workspaceTestDir = join(process.cwd(), 'test');
const cwdToFixture = relative(process.cwd(), fixtureDir);
const fixtureInsideCwd = cwdToFixture === '' || (!cwdToFixture.startsWith('..') && !isAbsolute(cwdToFixture));
if (!fixtureInsideCwd) {
  rmSync(workspaceTestDir, { recursive: true, force: true });
  cpSync(pristineTestDir, workspaceTestDir, { recursive: true });
}

const res = spawnSync(process.execPath, [vitestMjs, 'run', '--root', process.cwd()], {
  stdio: 'pipe',
  timeout: 120000,
});
if (res.error !== undefined && res.error !== null) {
  console.error(`micro-3 judge: could not execute the vitest run: ${res.error.message}`);
  process.exit(1);
}
// Forward the captured vitest diagnostics: the runner scores the exit code
// and trims these bytes to its own diagnostics tail, so a red suite must
// still carry its evidence.
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
// Set — never hard-exit: assigning process.exitCode lets the script end
// naturally so the forwarded bytes above flush (a hard process.exit can
// truncate pending pipe writes). A signal kill (status null, e.g. the spawn
// timeout firing) is a failure, never a pass.
process.exitCode = res.status ?? 1;
