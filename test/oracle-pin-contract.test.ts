import { describe, expect, it } from 'vitest';
import { validateOraclePinManifest } from '../campaigns/cq-settings/corpus/oracle-pin-contract.ts';

const pathA = 'runner/boundary/judge-child.ts';
const pathB = 'runner/boundary/g2-daemon-contract.ts';
const sha = 'a'.repeat(64);
const expected = { kind: 'operation' as const, ids: ['cq-settings.analysis-remediation.oracle.v1'], paths: [pathA, pathB] };
const valid = () => ({ manifestVersion: 1, taskOracleIds: [...expected.ids], dependencies: [
  { path: pathA, sha256: sha }, { path: pathB, sha256: sha },
] });

describe('committed oracle pin inventory', () => {
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
