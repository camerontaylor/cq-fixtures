import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { validateOraclePinManifest } from '../campaigns/cq-settings/corpus/oracle-pin-contract.ts';

const pathA = 'runner/boundary/judge-child.ts';
const pathB = 'runner/boundary/g2-daemon-contract.ts';
const sha = 'a'.repeat(64);
const expected = { kind: 'operation' as const, ids: ['cq-settings.analysis-remediation.oracle.v1'], paths: [pathA, pathB] };
const valid = () => ({ manifestVersion: 1, taskOracleIds: [...expected.ids], dependencies: [
  { path: pathA, sha256: sha }, { path: pathB, sha256: sha },
] });

describe('committed oracle pin inventory', () => {
  it('expanded review factories reject unsupported versions and missing dependencies', () => {
    const probe = `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const fs = createRequire(import.meta.url)('node:fs');
      const original = fs.readFileSync;
      let mutation = 'version';
      let intercepted = 0;
      fs.readFileSync = function(path, ...args) {
        const bytes = original.call(this, path, ...args);
        const name = path instanceof URL ? path.pathname : String(path);
        if (!name.endsWith('/campaigns/cq-settings/corpus/operation-oracle-pins.json')) return bytes;
        intercepted++;
        const manifest = JSON.parse(bytes.toString('utf8'));
        if (mutation === 'version') manifest.manifestVersion = 2;
        else manifest.dependencies = manifest.dependencies.slice(1);
        return Buffer.from(JSON.stringify(manifest));
      };
      syncBuiltinESMExports();
      const { createReviewRoleScopeTask, createReviewLabelNfcTask } = await import('./campaigns/cq-settings/corpus/review-loop-task.ts');
      const results = [];
      for (const [kind, factory] of [['version', createReviewRoleScopeTask], ['dependency', createReviewLabelNfcTask]]) {
        mutation = kind;
        let task;
        try { task = await factory({ model: 'offline', provider: 'fake' }); results.push({ kind, rejected: false }); }
        catch (error) { results.push({ kind, rejected: /manifest contract changed/.test(String(error)) }); }
        finally { if (task) await task.cleanup(); }
      }
      fs.readFileSync = original;
      syncBuiltinESMExports();
      console.log(JSON.stringify({ intercepted, results }));
    `;
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', probe], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({
      intercepted: 2,
      results: [{ kind: 'version', rejected: true }, { kind: 'dependency', rejected: true }],
    });
  }, 40_000);

  it('accepts exactly the declared version, IDs, path order and hash form', () => {
    expect(validateOraclePinManifest(valid(), expected).dependencies).toHaveLength(2);
  });

  it('rejects unsupported versions and ID substitutions before a factory can read bytes', () => {
    expect(() => validateOraclePinManifest({ ...valid(), manifestVersion: 2 }, expected)).toThrow('contract changed');
    expect(() => validateOraclePinManifest({ ...valid(), taskOracleIds: ['different'] }, expected)).toThrow('contract changed');
  });

  it('rejects removed, duplicated, reordered and added dependencies', () => {
    const base = valid();
    for (const dependencies of [
      base.dependencies.slice(0, 1),
      [base.dependencies[0], base.dependencies[0]],
      [...base.dependencies].reverse(),
      [...base.dependencies, base.dependencies[0]],
    ]) {
      expect(() => validateOraclePinManifest({ ...base, dependencies }, expected)).toThrow();
    }
  });

  it('rejects malformed hashes, unlisted paths and ambiguous extra fields', () => {
    const base = valid();
    expect(() => validateOraclePinManifest({ ...base, dependencies: [{ path: pathA, sha256: 'bad' }, base.dependencies[1]] }, expected)).toThrow();
    expect(() => validateOraclePinManifest({ ...base, dependencies: [{ path: '../outside', sha256: sha }, base.dependencies[1]] }, expected)).toThrow();
    expect(() => validateOraclePinManifest({ ...base, extra: true }, expected)).toThrow();
  });

  it('enforces the integration schema separately', () => {
    const integration = { kind: 'integration' as const, ids: ['oracle'], paths: [pathA] };
    expect(() => validateOraclePinManifest({ manifestVersion: 1, oracleIds: ['oracle'], dependencies: [{ path: pathA, sha256: sha }] }, integration)).not.toThrow();
    expect(() => validateOraclePinManifest({ manifestVersion: 1, taskOracleIds: ['oracle'], dependencies: [{ path: pathA, sha256: sha }] }, integration)).toThrow();
  });
});
