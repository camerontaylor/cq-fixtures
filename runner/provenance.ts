import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ToolkitPackageIdentity {
  version: string;
  integrity: string;
}

/** Resolve the interim pin or the exact registry package installed after W7.1. */
export function readToolkitProvenance(repoRoot: string): {
  toolkitLock: string | null;
  toolkitPackage?: ToolkitPackageIdentity;
} {
  const lockPath = join(repoRoot, 'toolkit.lock');
  if (existsSync(lockPath)) {
    const pin = readFileSync(lockPath, 'utf8').trim();
    if (!pin || pin.includes('\n')) throw new Error(`invalid toolkit.lock at ${lockPath}`);
    return { toolkitLock: pin };
  }

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, unknown>;
  };
  const npmLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: unknown; integrity?: unknown; resolved?: unknown; dependencies?: Record<string, unknown> }>;
  };
  const name = '@camerontaylor/cq-toolkit';
  const version = pkg.dependencies?.[name];
  const rootVersion = npmLock.packages?.['']?.dependencies?.[name];
  const entry = npmLock.packages?.[`node_modules/${name}`];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
      rootVersion !== version || entry?.version !== version ||
      typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-') ||
      typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://')) {
    throw new Error('published toolkit package provenance is missing or inconsistent in package.json/package-lock.json');
  }
  return { toolkitLock: null, toolkitPackage: { version, integrity: entry.integrity } };
}
