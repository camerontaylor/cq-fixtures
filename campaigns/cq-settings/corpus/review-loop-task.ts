import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeFixReviewItem,
  type Driver,
  type FixReviewItemInput,
  type FixReviewItemResult,
  type ModelSpec,
  type OpResult,
} from '@camerontaylor/cq-toolkit';
import { REVIEW_TASK_CONTRACTS, type ReviewTaskVariant } from './review-task-oracles.ts';
import { OPERATION_ORACLE_IDS, OPERATION_ORACLE_PATHS, validateOraclePinManifest } from './oracle-pin-contract.ts';

export const REVIEW_LOOP_TASK_ID = 'review-loop-label-limit-02' as const;
export const REVIEW_LOOP_SOURCE_ID = 'cq-settings.settings-module-seed.v2' as const;
export const REVIEW_LOOP_BASELINE_ID = 'cq-settings.label-length-defect.baseline.v2' as const;
export const REVIEW_LOOP_ORACLE_ID = 'cq-settings.label-length-unicode.oracle.v2' as const;

/** A worker-visible repair task; it intentionally contains no judge data. */
export interface ReviewLoopRepairTask {
  readonly id: typeof REVIEW_LOOP_TASK_ID;
  readonly sourceId: typeof REVIEW_LOOP_SOURCE_ID;
  readonly baselineId: typeof REVIEW_LOOP_BASELINE_ID;
  readonly oracleId: typeof REVIEW_LOOP_ORACLE_ID;
  readonly substrateFamily: 'campaign-settings-module-v2';
  readonly worktreePath: string;
  readonly baselineCommit: string;
  readonly modelSpec: ModelSpec;
  readonly operationInput: FixReviewItemInput;
  cleanup(): Promise<void>;
}

export interface ExpandedReviewLoopRepairTask extends Omit<ReviewLoopRepairTask, 'id' | 'sourceId' | 'baselineId' | 'oracleId' | 'substrateFamily'> {
  readonly variant: ReviewTaskVariant;
  readonly id: typeof REVIEW_TASK_CONTRACTS.roleScope.id | typeof REVIEW_TASK_CONTRACTS.labelNfc.id;
  readonly sourceId: typeof REVIEW_TASK_CONTRACTS.roleScope.sourceId | typeof REVIEW_TASK_CONTRACTS.labelNfc.sourceId;
  readonly baselineId: typeof REVIEW_TASK_CONTRACTS.roleScope.baselineId | typeof REVIEW_TASK_CONTRACTS.labelNfc.baselineId;
  readonly oracleId: typeof REVIEW_TASK_CONTRACTS.roleScope.oracleId | typeof REVIEW_TASK_CONTRACTS.labelNfc.oracleId;
  readonly substrateFamily: typeof REVIEW_TASK_CONTRACTS.roleScope.substrateFamily | typeof REVIEW_TASK_CONTRACTS.labelNfc.substrateFamily;
  readonly oraclePin: string;
  readonly sourcePath: string;
}

function pinnedReviewTaskOracle(oracleId: string): string {
  const manifestUrl = new URL('./operation-oracle-pins.json', import.meta.url);
  const bytes = readFileSync(manifestUrl);
  // Fail closed on purpose: a malformed or contract-violating manifest, and any dependency
  // whose bytes moved, must throw before a task workspace exists. The throw is re-raised
  // verbatim (original attached as `cause`) so the rejection stays deliberate and the
  // message PK00's regression asserts is preserved; swallowing it would weaken the guard.
  let manifest: ReturnType<typeof validateOraclePinManifest>;
  try {
    manifest = validateOraclePinManifest(JSON.parse(bytes.toString('utf8')) as unknown, {
      kind: 'operation', ids: OPERATION_ORACLE_IDS, paths: OPERATION_ORACLE_PATHS,
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (!OPERATION_ORACLE_IDS.some((id) => id === oracleId)) throw new Error(`review task oracle ${oracleId} is absent from the pin manifest`);
  const root = new URL('../../../', import.meta.url);
  for (const dependency of manifest.dependencies) {
    const actual = createHash('sha256').update(readFileSync(new URL(dependency.path, root))).digest('hex');
    if (actual !== dependency.sha256) throw new Error(`pinned review task oracle dependency changed: ${dependency.path}`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

const INITIAL_SETTINGS_SOURCE = `export function isValidCampaignLabel(label) {
  return typeof label === 'string' && label.trim().length > 0;
}
`;

const DISPLAY_SOURCE = `export function displayCampaignLabel(label) {
  return label;
}
`;

const PUBLIC_TEST_SOURCE = `import assert from 'node:assert/strict';
import { isValidCampaignLabel } from '../settings/module.js';
import { displayCampaignLabel } from '../settings/display.js';

assert.equal(isValidCampaignLabel(''), false);
assert.equal(isValidCampaignLabel('   '), false);
assert.equal(isValidCampaignLabel('Campaign A'), true);
assert.equal(isValidCampaignLabel('x'.repeat(41)), false);
assert.equal(displayCampaignLabel('  Campaign A  '), '  Campaign A  ');
`;

const REVIEW_TASK_SEEDS = {
  labelLimit: {
    id: REVIEW_LOOP_TASK_ID,
    sourceId: REVIEW_LOOP_SOURCE_ID,
    baselineId: REVIEW_LOOP_BASELINE_ID,
    oracleId: REVIEW_LOOP_ORACLE_ID,
    substrateFamily: 'campaign-settings-module-v2',
    sourcePath: 'settings/module.js',
    source: INITIAL_SETTINGS_SOURCE,
    tests: PUBLIC_TEST_SOURCE,
    taskBody: 'Campaign labels are limited to 40 Unicode code points after trimming. Reject longer labels. Preserve the original label for display; do not change settings/display.js.',
  },
  roleScope: {
    ...REVIEW_TASK_CONTRACTS.roleScope,
    sourcePath: REVIEW_TASK_CONTRACTS.roleScope.module,
    source: `export function canEditCampaign(actorId, ownerId, role, grants = []) {\n  return typeof actorId === 'string' && actorId.length > 0 && actorId === ownerId;\n}\n`,
    tests: `import assert from 'node:assert/strict';\nimport { canEditCampaign } from '../settings/review-permissions.mjs';\nassert.equal(canEditCampaign('owner-1', 'owner-1', 'owner'), true);\nassert.equal(canEditCampaign('admin-1', 'owner-1', 'admin', ['campaign:edit']), true);\nassert.equal(canEditCampaign('outsider-1', 'owner-1', 'user', ['campaign:edit']), false);\nassert.equal(canEditCampaign(null, 'owner-1', 'admin', ['campaign:edit']), false);\n`,
    taskBody: 'Repair campaign edit authorization. Owners may edit; an administrator with the documented campaign edit grant may edit; unrelated identities may not. Change only settings/review-permissions.mjs.',
  },
  labelNfc: {
    ...REVIEW_TASK_CONTRACTS.labelNfc,
    sourcePath: REVIEW_TASK_CONTRACTS.labelNfc.module,
    source: `export function sameCampaignLabel(left, right) {\n  return typeof left === 'string' && typeof right === 'string' && left.trim() === right.trim();\n}\n`,
    displaySource: `export function displayCampaignLabel(label) { return label; }\n`,
    tests: `import assert from 'node:assert/strict';\nimport { sameCampaignLabel } from '../settings/campaign-labels.mjs';\nimport { displayCampaignLabel } from '../settings/display.mjs';\nassert.equal(sameCampaignLabel('Café', 'Cafe\\u0301'), true);\nassert.equal(sameCampaignLabel('café', 'cafe'), false);\nassert.equal(sameCampaignLabel('  Cafe\\u0301 ', 'Café'), true);\nassert.equal(sameCampaignLabel('', ''), false);\nassert.equal(sameCampaignLabel('Campaign A', 'Campaign A'), true);\nassert.equal(displayCampaignLabel('Cafe\\u0301'), 'Cafe\\u0301');\n`,
    taskBody: 'Repair campaign label comparison by canonicalizing Unicode to NFC after trimming. Preserve original display bytes; change only settings/campaign-labels.mjs.',
  },
} as const;

/**
 * Materialize a fresh, real Git repository for the review-fix operation.
 * Only task context and visible regression tests are placed in the worktree.
 */
export async function createReviewLoopRepairTask(
  modelSpec: ModelSpec,
  parentDirectory = tmpdir(),
): Promise<ReviewLoopRepairTask> {
  return createReviewTaskVariant(modelSpec, 'labelLimit', parentDirectory) as Promise<ReviewLoopRepairTask>;
}

export async function createReviewRoleScopeTask(
  modelSpec: ModelSpec,
  parentDirectory = tmpdir(),
): Promise<ExpandedReviewLoopRepairTask> {
  return createReviewTaskVariant(modelSpec, 'roleScope', parentDirectory) as Promise<ExpandedReviewLoopRepairTask>;
}

export async function createReviewLabelNfcTask(
  modelSpec: ModelSpec,
  parentDirectory = tmpdir(),
): Promise<ExpandedReviewLoopRepairTask> {
  return createReviewTaskVariant(modelSpec, 'labelNfc', parentDirectory) as Promise<ExpandedReviewLoopRepairTask>;
}

async function createReviewTaskVariant(
  modelSpec: ModelSpec,
  variant: ReviewTaskRepairVariant,
  parentDirectory: string,
): Promise<ReviewLoopRepairTask | ExpandedReviewLoopRepairTask> {
  const definition = REVIEW_TASK_SEEDS[variant];
  const oraclePin = variant === 'labelLimit' ? undefined : pinnedReviewTaskOracle(definition.oracleId);
  const taskRoot = await mkdtemp(join(parentDirectory, 'cq-review-task-'));
  const worktreePath = join(taskRoot, 'repo');
  await mkdir(join(worktreePath, definition.sourcePath, '..'), { recursive: true });
  await mkdir(join(worktreePath, 'test'), { recursive: true });
  await writeFile(join(worktreePath, 'package.json'), JSON.stringify({
    name: 'local-campaign-settings-task',
    private: true,
    type: 'module',
    scripts: { test: 'node test/public-settings.test.mjs' },
  }, null, 2) + '\n');
  // The v2 labelLimit family keeps its pinned display module at settings/display.js,
  // which review-loop-judge compares byte-for-byte. The labelNfc family is judged by
  // REVIEW_TASK_CONTRACTS.labelNfc.displayModule, which is settings/display.mjs, and
  // its seeded public test imports that same path. Writing display.js here would leave
  // the display module the oracle probes absent, so a correct reference repair could
  // never be green; the seeded displaySource is what that task's display check expects.
  if (variant === 'labelLimit') {
    await writeFile(join(worktreePath, 'settings/display.js'), DISPLAY_SOURCE);
  }
  if (variant === 'labelNfc') {
    await writeFile(
      join(worktreePath, REVIEW_TASK_CONTRACTS.labelNfc.displayModule),
      REVIEW_TASK_SEEDS.labelNfc.displaySource,
    );
  }
  await writeFile(join(worktreePath, definition.sourcePath), definition.source);
  await writeFile(join(worktreePath, 'test/public-settings.test.mjs'), definition.tests);

  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'CQ Local Corpus']);
  git(['config', 'user.email', 'cq-local-corpus@example.invalid']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', `Seed ${definition.id}`]);
  const baselineCommit = git(['rev-parse', 'HEAD']);

  const operationInput: FixReviewItemInput = {
    repo: 'local/cq-settings',
    pr: 1,
    item: {
      id: `review-local-${definition.id}`,
      path: definition.sourcePath,
      line: 2,
      body: definition.taskBody,
      comments: [],
    },
    worktree: { path: worktreePath, branch: `review/${definition.id}` },
    driver: { ...modelSpec },
  };

  return {
    ...(variant === 'labelLimit' ? {} : { variant }),
    id: definition.id,
    sourceId: definition.sourceId,
    baselineId: definition.baselineId,
    oracleId: definition.oracleId,
    substrateFamily: definition.substrateFamily,
    ...(oraclePin === undefined ? {} : { oraclePin }),
    ...(variant === 'labelLimit' ? {} : { sourcePath: definition.sourcePath }),
    worktreePath,
    baselineCommit,
    modelSpec: { ...modelSpec },
    operationInput,
    async cleanup() {
      await rm(taskRoot, { recursive: true, force: true });
    },
  } as ReviewLoopRepairTask | ExpandedReviewLoopRepairTask;
}

export type ReviewTaskRepairVariant = keyof typeof REVIEW_TASK_SEEDS;

/** Dispatch the task through the selected toolkit's exported review op. */
export function executeReviewLoopRepairTask(
  task: ReviewLoopRepairTask | ExpandedReviewLoopRepairTask,
  driver: Driver,
): Promise<OpResult<FixReviewItemResult>> {
  return makeFixReviewItem({ driver })(task.operationInput);
}
