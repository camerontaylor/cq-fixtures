import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertIncludesPins, assertSameClosure, assertSamePins, discoverSourceClosure, runPreflight, verifyImplicitRuntimeAssets } from '../scripts/cq-remediation-preflight.mjs';

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
  it('fails closed when the active final-profile loader omits implicit runtime assets', async () => {
    await expect(runPreflight()).rejects.toThrow(
      'final-profile runtime pin loader pins differ (missing: runner/boundary/broker-public-assets/broker.mjs, runner/boundary/broker-public-assets/config.json, schema/suite.schema.json; hash mismatch: none)',
    );
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

  it('requires exact asset paths and hashes as a subset of the active runtime pin map', () => {
    const expected = { 'assets/config.json': 'a'.repeat(64) };
    expect(() => assertIncludesPins(expected, {})).toThrow('pins differ (missing: assets/config.json; hash mismatch: none)');
    expect(() => assertIncludesPins(expected, { 'assets/config.json': '0'.repeat(64) }))
      .toThrow('pins differ (missing: none; hash mismatch: assets/config.json)');
    expect(() => assertIncludesPins(expected, { ...expected, 'src/entry.ts': 'b'.repeat(64) })).not.toThrow();
  });

  it('does not count duplicate paths as distinct loader assets', () => {
    expect(() => assertSameClosure(['a.ts', 'a.ts'], ['a.ts'])).not.toThrow();
  });

  it('rejects an implicit runtime asset that is missing', async () => {
    const root = await syntheticRoot();
    await mkdir(join(root, 'assets'));
    const bytes = 'pinned runtime bytes';
    const pin = createHash('sha256').update(bytes).digest('hex');
    await expect(verifyImplicitRuntimeAssets(root, { 'assets/missing.json': pin })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed implicit runtime asset bytes', async () => {
    const root = await syntheticRoot();
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'config.json'), 'changed bytes');
    await expect(verifyImplicitRuntimeAssets(root, { 'assets/config.json': 'a'.repeat(64) }))
      .rejects.toThrow('implicit runtime asset content hash differs for assets/config.json');
  });

  it('rejects implicit runtime assets that are symlinked outside the checkout', async () => {
    const root = await syntheticRoot();
    const outside = await syntheticRoot();
    await mkdir(join(root, 'assets'));
    await writeFile(join(outside, 'config.json'), 'outside bytes');
    await symlink(join(outside, 'config.json'), join(root, 'assets', 'config.json'));
    const pin = createHash('sha256').update('outside bytes').digest('hex');
    await expect(verifyImplicitRuntimeAssets(root, { 'assets/config.json': pin }))
      .rejects.toThrow('implicit runtime asset is symlinked: assets/config.json');
  });
});
