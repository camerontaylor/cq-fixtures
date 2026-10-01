import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { readToolkitProvenance } from '../runner/provenance.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('records the exact published package after the interim pin is removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-toolkit-provenance-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@camerontaylor/cq-toolkit': '1.1.0' } }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {
    '': { dependencies: { '@camerontaylor/cq-toolkit': '1.1.0' } },
    'node_modules/@camerontaylor/cq-toolkit': {
      version: '1.1.0', integrity: 'sha512-example', resolved: 'https://registry.npmjs.org/pkg',
    },
  } }));
  expect(readToolkitProvenance(dir)).toEqual({ toolkitLock: null,
    toolkitPackage: { version: '1.1.0', integrity: 'sha512-example' } });
  writeFileSync(join(dir, 'toolkit.lock'), 'interim-sha\n');
  expect(readToolkitProvenance(dir)).toEqual({ toolkitLock: 'interim-sha' });
});

it('accepts a prerelease version with build metadata from the flip script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-toolkit-provenance-'));
  dirs.push(dir);
  const version = '0.2.0-rc.1+build.7';
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@camerontaylor/cq-toolkit': version } }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {
    '': { dependencies: { '@camerontaylor/cq-toolkit': version } },
    'node_modules/@camerontaylor/cq-toolkit': {
      version, integrity: 'sha512-example', resolved: 'https://registry.npmjs.org/pkg',
    },
  } }));
  expect(readToolkitProvenance(dir)).toEqual({ toolkitLock: null,
    toolkitPackage: { version, integrity: 'sha512-example' } });
});
