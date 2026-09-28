import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makePlanSweep,
  makeResolveConflictOp,
  type Driver,
  type ConflictResolutionValue,
  type MergeEffects,
  type ModelSpec,
  type OpResult,
  type PlanSweepInput,
} from '@camerontaylor/cq-toolkit';
import {
  judgeFleetSweepPlan,
  judgeMergeConflictWorkspace,
  type MergeConflictContract,
  type WorkflowOracleReport,
} from '../../../runner/workflow-corpus/operation-workflow-judges.js';

const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

interface IntegrationOraclePinManifest {
  readonly dependencies: readonly { readonly path: string; readonly sha256: string }[];
  readonly oracleIds: readonly string[];
}

function pinnedIntegrationOracle(oracleId: string): string {
  const manifestUrl = new URL('./integration-oracle-pins.json', import.meta.url);
  const bytes = readFileSync(manifestUrl);
  const manifest = JSON.parse(bytes.toString('utf8')) as IntegrationOraclePinManifest;
  if (!manifest.oracleIds.includes(oracleId)) throw new Error(`integration oracle ${oracleId} is absent from the pin manifest`);
  const root = new URL('../../../', import.meta.url);
  for (const dependency of manifest.dependencies) {
    const digest = createHash('sha256').update(readFileSync(new URL(dependency.path, root))).digest('hex');
    if (digest !== dependency.sha256) throw new Error(`pinned integration oracle dependency changed: ${dependency.path}`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export const MERGE_CONFLICT_TASKS = {
  unicodeLabelLimit: {
    id: 'merge-unicode-label-limit-01', sourceId: 'cq-settings.merge-worktree-seed.v1',
    baselineId: 'cq-settings.merge-conflict.baseline.v1', oracleId: 'cq-settings.merge-label-limit.oracle.v1',
    substrateFamily: 'local-merge-worktree-v1',
    examples: [
      { input: '', expected: '' }, { input: '😀'.repeat(40), expected: '😀'.repeat(40) },
      { input: '😀'.repeat(41), expected: '' }, { input: ' campaign ', expected: 'campaign' },
    ],
  },
  reservedPrefix: {
    id: 'merge-reserved-prefix-01', sourceId: 'cq-settings.merge-reserved-prefix-seed.v1',
    baselineId: 'cq-settings.merge-reserved-prefix.baseline.v1', oracleId: 'cq-settings.merge-reserved-prefix.oracle.v1',
    substrateFamily: 'local-merge-reserved-prefix-v1',
    examples: [
      { input: 'campaign', expected: 'campaign' }, { input: '  campaign ', expected: 'campaign' },
      { input: 'sys:internal', expected: '' }, { input: null, expected: '' },
    ],
  },
} as const;

type MergeVariant = keyof typeof MERGE_CONFLICT_TASKS;

export interface MergeConflictTask {
  readonly variant: MergeVariant;
  readonly id: string;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly oraclePin: string;
  readonly substrateFamily: string;
  readonly repoRoot: string;
  readonly settingsPath: string;
  readonly baselineCommit: string;
  readonly sourceSha256: string;
  readonly modelSpec: ModelSpec;
  cleanup(): Promise<void>;
}

export async function createMergeConflictTask(
  variant: MergeVariant,
  modelSpec: ModelSpec,
  parentDirectory = tmpdir(),
): Promise<MergeConflictTask> {
  const definition = MERGE_CONFLICT_TASKS[variant];
  const oraclePin = pinnedIntegrationOracle(definition.oracleId);
  const root = await mkdtemp(join(parentDirectory, 'cq-merge-corpus-'));
  const repoRoot = join(root, 'repo');
  const settingsPath = join(repoRoot, 'src/settings.mjs');
  await mkdir(join(repoRoot, 'src'), { recursive: true });
  await mkdir(join(repoRoot, 'branch-intentions'), { recursive: true });
  await writeFile(settingsPath, `export function campaignLabel(value) { return typeof value === 'string' ? value.trim() : ''; }\n`);
  const mainIntent = variant === 'unicodeLabelLimit'
    ? 'Main branch: preserve display trimming for campaign labels.\n'
    : 'Main branch: preserve trimming and ordinary campaign labels.\n';
  const featureIntent = variant === 'unicodeLabelLimit'
    ? 'Feature branch: reject labels longer than 40 Unicode code points.\n'
    : 'Feature branch: reject labels in the reserved sys: namespace.\n';
  await writeFile(join(repoRoot, 'branch-intentions/main.md'), mainIntent);
  await writeFile(join(repoRoot, 'branch-intentions/feature.md'), featureIntent);
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.name', 'CQ Local Corpus']);
  git(repoRoot, ['config', 'user.email', 'cq-local-corpus@example.invalid']);
  git(repoRoot, ['add', 'src/settings.mjs', 'branch-intentions/main.md', 'branch-intentions/feature.md']);
  git(repoRoot, ['commit', '-q', '-m', `Seed ${definition.id}`]);
  const baselineCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  return {
    ...definition, variant, oraclePin, repoRoot, settingsPath, baselineCommit,
    sourceSha256: createHash('sha256').update(await import('node:fs/promises').then((fs) => fs.readFile(settingsPath))).digest('hex'),
    modelSpec: { ...modelSpec },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

export async function executeMergeConflictTask(task: MergeConflictTask, driver: Driver): Promise<OpResult<ConflictResolutionValue>> {
  let validationCount = 0;
  const effects: MergeEffects = {
    async validateRef() {
      validationCount += 1;
      return { ok: true, sha: validationCount === 1 ? task.baselineCommit : git(task.repoRoot, ['rev-parse', 'HEAD']) };
    },
    async fetchRef() { return { code: 0, stdout: '', stderr: '' }; },
    async readBaseRef() { return { ok: true, baseRefName: 'main' }; },
    async worktreePrepare() { return { path: task.repoRoot }; },
    async worktreeRemove() {},
    async mergePr() { return { code: 0, stdout: '', stderr: '' }; },
    async retargetBase() { return { code: 0, stdout: '', stderr: '' }; },
    async pushRef() { return { code: 0, stdout: '', stderr: '' }; },
  };
  const operation = makeResolveConflictOp({
    effects, driver, createSession: async () => `local-${task.id}`,
    loadPrompt: async () => `Resolve {{pr}} conflict in {{conflictFiles}} against {{baseBranch}} at {{worktree}}. Read branch-intentions/main.md and branch-intentions/feature.md; preserve both intentions. ${task.variant === 'unicodeLabelLimit' ? 'Count Unicode code points after trimming.' : 'Reject the reserved sys: prefix.'}`,
  });
  return operation({
    pr: 23, repoRoot: task.repoRoot, headBranch: 'feature/settings', baseBranch: 'main',
    conflictFiles: ['src/settings.mjs'], modelSpec: { ...task.modelSpec }, wallClockMs: 15_000,
  });
}

export function judgeMergeConflictTask(task: MergeConflictTask): WorkflowOracleReport {
  const definition = MERGE_CONFLICT_TASKS[task.variant];
  const contract: MergeConflictContract = {
    sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId,
    examples: definition.examples,
  };
  return judgeMergeConflictWorkspace(task.repoRoot, task.baselineCommit, contract);
}

export const FLEET_SWEEP_TASKS = {
  nestedUnit: {
    id: 'fleet-nested-test-unit-01', sourceId: 'cq-settings.fleet-nested-package-seed.v1',
    baselineId: 'cq-settings.fleet-dirty-test.baseline.v1', oracleId: 'cq-settings.fleet-deepest-owner.oracle.v1',
    substrateFamily: 'nested-test-package-ownership-v1', path: 'packages/core/test/settings.test.ts',
    expectedPackage: 'core-tests', packages: [
      { name: 'core', path: 'packages/core' }, { name: 'core-tests', path: 'packages/core/test' },
      { name: 'cli', path: 'packages/cli' },
    ],
  },
  serviceLeaf: {
    id: 'fleet-service-leaf-test-01', sourceId: 'cq-settings.fleet-service-test-seed.v1',
    baselineId: 'cq-settings.fleet-service-test.baseline.v1', oracleId: 'cq-settings.fleet-service-owner.oracle.v1',
    substrateFamily: 'service-test-package-ownership-v1', path: 'packages/service/test/api.test.ts',
    expectedPackage: 'service-tests', packages: [
      { name: 'service', path: 'packages/service' }, { name: 'service-tests', path: 'packages/service/test' },
      { name: 'web', path: 'packages/web' },
    ],
  },
} as const;

type FleetVariant = keyof typeof FLEET_SWEEP_TASKS;

export interface FleetSweepTask {
  readonly variant: FleetVariant;
  readonly id: string;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly oraclePin: string;
  readonly substrateFamily: string;
  readonly repoRoot: string;
  readonly baselineCommit: string;
  readonly changedPath: string;
  readonly expectedPackage: string;
  readonly packages: readonly { readonly name: string; readonly path: string }[];
  readonly changedPaths: readonly string[];
  cleanup(): Promise<void>;
}

export async function createFleetSweepTask(variant: FleetVariant, parentDirectory = tmpdir()): Promise<FleetSweepTask> {
  const definition = FLEET_SWEEP_TASKS[variant];
  const oraclePin = pinnedIntegrationOracle(definition.oracleId);
  const root = await mkdtemp(join(parentDirectory, 'cq-fleet-corpus-'));
  const repoRoot = join(root, 'repo');
  const changedPath = join(repoRoot, definition.path);
  await mkdir(join(changedPath, '..'), { recursive: true });
  await mkdir(join(repoRoot, 'packages/cli'), { recursive: true });
  await writeFile(changedPath, 'assert.equal(true, true);\n');
  await writeFile(join(repoRoot, 'packages/cli/index.ts'), 'export const cli = true;\n');
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.name', 'CQ Local Corpus']);
  git(repoRoot, ['config', 'user.email', 'cq-local-corpus@example.invalid']);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-q', '-m', `Seed ${definition.id}`]);
  const baselineCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  await writeFile(changedPath, 'assert.equal(1, 1);\n');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', `Change ${definition.id}`]);
  const changedPaths = definition.path ? [definition.path] : [];
  return {
    ...definition, variant, oraclePin, repoRoot, baselineCommit, changedPath, changedPaths,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

export async function executeFleetSweepTask(task: FleetSweepTask): Promise<{ readonly report: unknown; readonly oracle: WorkflowOracleReport }> {
  const planner = makePlanSweep({
    changedFiles: async (base) => git(task.repoRoot, ['diff', '--name-status', `${base}..HEAD`])
      .split('\n').filter(Boolean).map((line) => {
        const [status = '', path = ''] = line.split('\t');
        return { path, status, deleted: status === 'D', fixerTarget: true };
      }),
  });
  const input: PlanSweepInput = {
    repoRoot: task.repoRoot,
    packages: [...task.packages],
    selector: { mode: 'changed-vs-base', base: task.baselineCommit },
    fixers: ['settings-fixer'],
  };
  const result = await planner(input);
  if (result.status !== 'ok') throw new Error('fleet corpus operation returned an error');
  const report = result.value;
  const oracle = judgeFleetSweepPlan(report, task.changedPaths, {
    sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId,
    expectedPackage: task.expectedPackage, expectedPaths: task.changedPaths,
  });
  return { report, oracle };
}
