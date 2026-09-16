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
// The judge re-runs the fixture's vitest suite against that cwd. Vitest is
// loaded from the REPO's node_modules — the fixture workspace is a
// zero-dependency package with no node_modules of its own — and is handed
// `--root <cwd>` so it discovers tests inside the workspace, not the repo.
// Output is piped, not inherited: the runner scores the exit status and
// trims diagnostics to its own tail, so a red suite must not flood the row.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fixtures/micro-3/check.mjs -> repo root is two levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const vitestMjs = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitestMjs)) {
  console.error(`micro-3 judge: vitest entry not found at ${vitestMjs} (run npm install at the repo root)`);
  process.exit(1);
}

const res = spawnSync(process.execPath, [vitestMjs, 'run', '--root', process.cwd()], {
  stdio: 'pipe',
  timeout: 120000,
});
if (res.error !== undefined && res.error !== null) {
  console.error(`micro-3 judge: could not execute the vitest run: ${res.error.message}`);
  process.exit(1);
}
// A signal kill (status null, e.g. the spawn timeout firing) is a failure,
// never a pass.
process.exit(res.status ?? 1);
