import { stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Plan §3.2 layout skeleton: every contract directory exists with its
// two-line README. Population of each directory is owned by later goals
// (J1 schema, J2 runner, J3 suites/fixtures, J4 CI, J5 report snapshots).
const SKELETON = [
  'suites/fixer-worker',
  'suites/review-classifier',
  'fixtures',
  'runner',
  'schema',
  'reports',
] as const;

describe('repo layout skeleton (plan §3.2)', () => {
  it.each(SKELETON)('%s exists with its README contract', async (dir) => {
    const s = await stat(new URL(`../${dir}/README.md`, import.meta.url));
    expect(s.isFile()).toBe(true);
  });
});
