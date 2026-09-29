import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSameClosure, assertSamePins, discoverSourceClosure, runPreflight, type SourcePreflightResult } from '../scripts/cq-remediation-preflight.mjs';

const roots: string[] = [];
async function syntheticRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cq-remediation-preflight-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('no-dispatch remediation preflight', () => {
  it('loads transformed native entrypoints and checks their real source closure', async () => {
    const result: SourcePreflightResult = await runPreflight();
    expect(result).toMatchObject({
      status: 'preflight-green', dispatched: false, provisioned: false,
      sourceEntryPoint: 'runner/native/run-visible-g1.ts',
      taskIdExport: 'runner/experiment.ts#suiteTaskId',
    });
    expect(result.closureCount).toBeGreaterThan(0);
    expect(result.closure['runner/experiment.ts']).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('includes generated-candidate JavaScript imports through their source convention', async () => {
    const root = await syntheticRoot();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'entry.ts'), "import { candidate } from './generated.js'; export { candidate };\n");
    await writeFile(join(root, 'src', 'generated.ts'), 'export const candidate = true;\n');
    await expect(discoverSourceClosure(root, ['src/entry.ts'])).resolves.toEqual(['src/entry.ts', 'src/generated.ts']);
  });

  it('fails closed when any transitive relative source dependency is missing', async () => {
    const root = await syntheticRoot();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'entry.ts'), "import './missing.js';\n");
    await expect(discoverSourceClosure(root, ['src/entry.ts'])).rejects.toThrow('could not be resolved');
  });

  it('rejects source imports that escape the checkout', async () => {
    const root = await syntheticRoot();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'entry.ts'), "import '../../outside.ts';\n");
    await writeFile(join(root, 'outside.ts'), 'export {};\n');
    await expect(discoverSourceClosure(root, ['src/entry.ts'])).rejects.toThrow('escaped trusted checkout');
  });

  it('rejects a prepared asset list that omits or adds a transitive loader dependency', () => {
    expect(() => assertSameClosure(['a.ts', 'new-dependency.ts'], ['a.ts'], 'runtime loader'))
      .toThrow('runtime loader closure differs (missing: new-dependency.ts; extra: none)');
    expect(() => assertSameClosure(['a.ts'], ['a.ts', 'stale.ts'], 'runtime loader'))
      .toThrow('runtime loader closure differs (missing: none; extra: stale.ts)');
  });

  it('rejects a loader that reports the right paths with incorrect byte hashes', () => {
    expect(() => assertSamePins({ 'src/entry.ts': 'a'.repeat(64) }, { 'src/entry.ts': '0'.repeat(64) }, 'runtime loader'))
      .toThrow('runtime loader content hash differs for src/entry.ts');
  });

  it('does not count duplicate paths as distinct loader assets', () => {
    expect(() => assertSameClosure(['a.ts', 'a.ts'], ['a.ts'])).not.toThrow();
  });
});
