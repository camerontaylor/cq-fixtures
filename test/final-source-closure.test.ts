import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { finalProfileG1SourcePins } from '../runner/native/run-final-profile-g1.ts';
import { runPreflight } from '../scripts/cq-remediation-preflight.mjs';

const REPO_ROOT = process.cwd();
const FINAL_PROFILE_SOURCE = 'runner/native/run-final-profile-g1.ts';
let sourceCopy: string;
let siblingRoot: string;
let originalSource: string;

function runCopiedFactory(oracleDependencies: ReadonlyArray<{ path: string; sha256: string }> = []) {
  const script = `
    import { pathToFileURL } from 'node:url';
    try {
      const module = await import(pathToFileURL(process.argv[1]).href);
      const result = await module.finalProfileG1SourcePins(JSON.parse(process.argv[2]));
      console.log(JSON.stringify({ sourcePin: result.sourcePin, pinCount: Object.keys(result.pins).length }));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `;
  return spawnSync(process.execPath, [
    '--experimental-transform-types', '--input-type=module', '-e', script,
    join(sourceCopy, FINAL_PROFILE_SOURCE), JSON.stringify(oracleDependencies),
  ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
}

beforeAll(async () => {
  // Register the same TypeScript transform used by the no-dispatch source
  // preflight before importing a full isolated source checkout below.
  await runPreflight(REPO_ROOT);
  sourceCopy = await mkdtemp(join(tmpdir(), 'cq-final-source-closure-'));
  siblingRoot = `${sourceCopy}.sibling`;
  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const archivePath = join(sourceCopy, 'checkout.tar');
  await writeFile(archivePath, archive);
  execFileSync('tar', ['-xf', archivePath, '-C', sourceCopy]);
  await rm(archivePath, { force: true });
  await copyFile(join(REPO_ROOT, FINAL_PROFILE_SOURCE), join(sourceCopy, FINAL_PROFILE_SOURCE));
  await symlink(join(REPO_ROOT, 'node_modules'), join(sourceCopy, 'node_modules'), 'dir');
  originalSource = await readFile(join(sourceCopy, FINAL_PROFILE_SOURCE), 'utf8');
});

beforeEach(async () => {
  await writeFile(join(sourceCopy, FINAL_PROFILE_SOURCE), originalSource);
});

afterEach(async () => {
  await writeFile(join(sourceCopy, FINAL_PROFILE_SOURCE), originalSource);
});

afterAll(async () => {
  await Promise.all([
    rm(sourceCopy, { recursive: true, force: true }),
    rm(siblingRoot, { recursive: true, force: true }),
  ]);
});

describe('final-profile source preparer closure', () => {
  it('pins the actual final-profile source closure without invoking runtime preparation', async () => {
    const result = await finalProfileG1SourcePins();
    expect(result.pins[FINAL_PROFILE_SOURCE]).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.sourcePin).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed when a selected literal relative import cannot be resolved', async () => {
    await writeFile(join(sourceCopy, FINAL_PROFILE_SOURCE), `${originalSource}\nasync function unresolvedProbe() { return import('./__pk01_missing_source__.ts'); }\n`);
    const result = runCopiedFactory();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source pin import could not be resolved: ./__pk01_missing_source__.ts from runner/native/run-final-profile-g1.ts');
  });

  it('rejects a prefix-sharing sibling symlink before canonical path normalization', async () => {
    await mkdir(join(sourceCopy, 'x'), { recursive: true });
    await mkdir(siblingRoot, { recursive: true });
    await writeFile(join(sourceCopy, 'x', 'escape.ts'), 'export const location = "inside";\n');
    await writeFile(join(siblingRoot, 'escape.ts'), 'export const location = "outside";\n');
    await symlink(join(siblingRoot, 'escape.ts'), join(sourceCopy, 'external.ts'));

    const result = runCopiedFactory([
      { path: 'external.ts', sha256: '0'.repeat(64) },
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source pin dependency escaped repository root');
  });

  it('rejects an oracle hash that does not bind to the declared source path bytes', async () => {
    await mkdir(join(sourceCopy, 'audit-assets'), { recursive: true });
    await writeFile(join(sourceCopy, 'audit-assets', 'candidate.ts'), 'export const value = 1;\n');
    const result = runCopiedFactory([
      { path: 'audit-assets/candidate.ts', sha256: '0'.repeat(64) },
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('oracle manifest source changed: audit-assets/candidate.ts');
  });
});
