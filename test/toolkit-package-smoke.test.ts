import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    packageContent: {
      treeAlgorithm: string;
      distTreeSha256: string;
      distIndexSha256: string;
    };
    packageLock: { resolved: string; integrity: string };
  };
}

interface Lockfile {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../campaign-source-manifest.json', import.meta.url), 'utf8'),
) as SourceManifest;

function packageTreeIdentity(root: string): { treeSha256: string; files: Map<string, string> } {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) {
        const path = relative(root, absolutePath).split('\\').join('/');
        files.set(path, createHash('sha256').update(readFileSync(absolutePath)).digest('hex'));
      }
    }
  };
  visit(root);
  const canonicalTree = [...files]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([path, sha256]) => `${path}\0${sha256}\n`)
    .join('');
  return { treeSha256: createHash('sha256').update(canonicalTree).digest('hex'), files };
}

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

  it('matches the extracted tarball dist tree byte-for-byte with installed package files', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cq-toolkit-package-'));
    try {
      execFileSync('tar', [
        '-xzf',
        resolve(fileURLToPath(new URL(`../${TARBALL_PATH}`, import.meta.url))),
        '-C',
        temporaryDirectory,
      ]);
      const extractedDist = join(temporaryDirectory, 'package', 'dist');
      const installedEntry = require.resolve(PACKAGE_NAME);
      const installedDist = dirname(installedEntry);
      const extracted = packageTreeIdentity(extractedDist);
      const installed = packageTreeIdentity(installedDist);
      const indexPath = 'index.js';

      expect(extracted.files.size).toBeGreaterThan(0);
      expect(extracted.files).toEqual(installed.files);
      expect(extracted.treeSha256).toBe(manifest.toolkitPackage.packageContent.distTreeSha256);
      expect(installed.treeSha256).toBe(extracted.treeSha256);
      expect(extracted.files.get(indexPath)).toBe(manifest.toolkitPackage.packageContent.distIndexSha256);
      expect(installed.files.get(indexPath)).toBe(extracted.files.get(indexPath));
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
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
