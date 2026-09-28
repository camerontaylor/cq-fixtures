import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  makeAgenticRemediation,
  type Cluster,
  type Driver,
  type OpInvocation,
  type WorkerResult,
} from '@camerontaylor/cq-toolkit';
import { describe, expect, it } from 'vitest';

const PACKAGE_NAME = '@camerontaylor/cq-toolkit';
const TARBALL_PATH = 'vendor/cq-toolkit-1.0.1.tgz';
const require = createRequire(import.meta.url);

interface SourceManifest {
  toolkitPackage: {
    name: string;
    version: string;
    tarball: string;
    tarballSha256: string;
    packageLock: { resolved: string; integrity: string };
  };
}

interface Lockfile {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../campaign-source-manifest.json', import.meta.url), 'utf8'),
) as SourceManifest;

describe('selected toolkit package identity', () => {
  it('matches the selected tarball SHA256 and package-lock integrity', () => {
    const tarball = readFileSync(new URL(`../${TARBALL_PATH}`, import.meta.url));
    const sha256 = createHash('sha256').update(tarball).digest('hex');
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as Lockfile;
    const lockedToolkit = lock.packages[`node_modules/${PACKAGE_NAME}`];
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;

    expect(manifest.toolkitPackage.tarball).toBe(TARBALL_PATH);
    expect(sha256).toBe(manifest.toolkitPackage.tarballSha256);
    expect(lockedToolkit).toMatchObject({
      version: manifest.toolkitPackage.version,
      resolved: manifest.toolkitPackage.packageLock.resolved,
      integrity,
    });
    expect(integrity).toBe(manifest.toolkitPackage.packageLock.integrity);
  });

  it('resolves and exercises an exported operation through the installed package and injected Driver', async () => {
    const installedEntry = require.resolve(PACKAGE_NAME);
    const installedRoot = dirname(dirname(installedEntry));
    const installedPackage = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const failure = {
      file: 'src/example.ts',
      line: 3,
      column: 1,
      ruleId: 'no-explicit-any',
      message: 'Unexpected any.',
      severity: 'error' as const,
    };
    const cluster: Cluster = {
      id: 'smoke-cluster',
      signature: '["oxlint","no-explicit-any","Unexpected any."]',
      tool: 'oxlint',
      ruleId: 'no-explicit-any',
      confidence: 'low',
      failures: [failure],
      size: 1,
    };
    const response: WorkerResult = {
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete',
    };
    const invocations: OpInvocation[] = [];
    const driver: Driver = {
      async run(invocation) {
        invocations.push(invocation);
        return response;
      },
    };

    const result = await makeAgenticRemediation(driver)({
      clusterId: cluster.id,
      cluster,
      modelSpec: { model: 'offline-smoke', provider: 'fake' },
    });

    expect(installedPackage).toMatchObject({
      name: manifest.toolkitPackage.name,
      version: manifest.toolkitPackage.version,
    });
    expect(installedPackage.name).toBe(PACKAGE_NAME);
    expect(result).toEqual({ status: 'ok', value: response });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.modelSpec).toEqual({ model: 'offline-smoke', provider: 'fake' });
    expect(invocations[0]?.toolPolicy).toEqual({ allow: [], mode: 'none' });
    expect(invocations[0]?.sandboxPolicy).toEqual({ level: 'read-only' });
    expect(invocations[0]?.prompt).toContain('smoke-cluster');
  });
});
