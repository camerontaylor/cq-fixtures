#!/usr/bin/env node
// Write the dated header consumed by snapshot-index after raw pilot cells land.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function writePilotSnapshotHeader(evalRoot, snapshotDir, runId) {
  const cells = ['glm-5.3-flash', 'deepseek-flash'];
  const runs = cells.flatMap((model) => {
    const file = join(evalRoot, model, 'ai-sdk', 'fixer-worker', 'micro', 'run.json');
    if (!existsSync(file)) return [];
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(manifest.runs) || manifest.runs.length === 0) {
      throw new Error(`${file}: missing run entries`);
    }
    return manifest.runs;
  });
  if (runs.length === 0) return false;
  const [first] = runs;
  const { toolkitLock, toolkitPackage, suiteSha } = first;
  if (toolkitLock !== null || toolkitPackage?.version !== '0.2.0' ||
      !toolkitPackage.integrity?.startsWith('sha512-') || !suiteSha ||
      runs.some((run) => run.toolkitLock !== null || run.suiteSha !== suiteSha ||
        run.toolkitPackage?.version !== toolkitPackage.version ||
        run.toolkitPackage?.integrity !== toolkitPackage.integrity)) {
    throw new Error('pilot snapshot header requires one published 0.2 toolkit identity and suite SHA');
  }
  // toolkit.lock is the historical index key; npm: marks a published registry
  // identity rather than claiming a local lockfile exists.
  writeFileSync(join(snapshotDir, 'README.md'), [
    '<!-- cq-fixtures snapshot header (F6) — machine-read by scripts/snapshot-index.mjs -->',
    `toolkit.lock: npm:${toolkitPackage.version}@${toolkitPackage.integrity}`,
    `toolkit-package-version: ${toolkitPackage.version}`,
    `registry-integrity: ${toolkitPackage.integrity}`,
    `toolkit-release-tag: v${toolkitPackage.version}`,
    `suite-sha: ${suiteSha}`,
    `fixtures-flip-commit: ${suiteSha}`,
    `snapshot-date: ${basename(snapshotDir)}`,
    `run-id: ${runId}`,
    '<!-- /cq-fixtures snapshot header -->',
    '',
  ].join('\n'));
  return true;
}

if (process.argv[1]?.endsWith('write-pilot-snapshot-header.mjs')) {
  const [, , evalRoot, snapshotDir, runId] = process.argv;
  if (!evalRoot || !snapshotDir || !runId) {
    console.error('usage: write-pilot-snapshot-header.mjs <eval-root> <snapshot-dir> <run-id>');
    process.exitCode = 2;
  } else {
    writePilotSnapshotHeader(evalRoot, snapshotDir, runId);
  }
}
