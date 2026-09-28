import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDiffMonotonicity,
  clusterErrorsOp,
  createCaptureBaseline,
  createCheckRatchet,
  getAdapter,
  makeAgenticRemediation,
  registerAdapter,
  type Driver,
  type ModelSpec,
  type OpResult,
  type WorkerResult,
} from '@camerontaylor/cq-toolkit';
import {
  ANALYSIS_REMEDIATION_CONTRACTS,
  judgeAnalysisRemediationProposal,
  judgeRatchetOutcomes,
  type WorkflowOracleReport,
} from '../../../runner/workflow-corpus/operation-workflow-judges.js';

export const ANALYSIS_TASKS = {
  whitespaceSetting: {
    id: 'analysis-whitespace-setting-01',
    sourceId: 'cq-settings.analysis-setting-failures.v1',
    baselineId: 'cq-settings.analysis-duplicate-errors.baseline.v1',
    oracleId: 'cq-settings.analysis-remediation.oracle.v1',
    substrateFamily: 'eslint-empty-setting-fixture-v1',
    clusterKey: 'no-empty-setting',
    fixture: 'src/settings.ts:12: empty campaign setting is accepted',
  },
  unicodeLabelLimit: {
    id: 'analysis-unicode-label-limit-01',
    sourceId: 'cq-settings.analysis-unicode-label-seed.v1',
    baselineId: 'cq-settings.analysis-unicode-limit.baseline.v1',
    oracleId: 'cq-settings.analysis-unicode-remediation.oracle.v1',
    substrateFamily: 'unicode-label-linter-fixture-v1',
    clusterKey: 'campaign-label-too-long',
    fixture: 'src/settings.ts:24: campaign label exceeds 40 Unicode code points',
  },
} as const;

interface OperationOraclePinManifest {
  readonly manifestVersion: 1;
  readonly dependencies: readonly { readonly path: string; readonly sha256: string }[];
  readonly taskOracleIds: readonly string[];
}

function pinnedOperationOracle(oracleId: string): string {
  const manifestUrl = new URL('./operation-oracle-pins.json', import.meta.url);
  const bytes = readFileSync(manifestUrl);
  const manifest = JSON.parse(bytes.toString('utf8')) as OperationOraclePinManifest;
  if (!manifest.taskOracleIds.includes(oracleId)) throw new Error(`oracle ${oracleId} is absent from the committed pin manifest`);
  const root = new URL('../../../', import.meta.url);
  for (const dependency of manifest.dependencies) {
    const digest = createHash('sha256').update(readFileSync(new URL(dependency.path, root))).digest('hex');
    if (digest !== dependency.sha256) throw new Error(`pinned operation oracle dependency changed: ${dependency.path}`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

type AnalysisVariant = keyof typeof ANALYSIS_TASKS;

export interface AnalysisRemediationTask {
  readonly variant: AnalysisVariant;
  readonly id: (typeof ANALYSIS_TASKS)[AnalysisVariant]['id'];
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly oraclePin: string;
  readonly substrateFamily: string;
  readonly modelSpec: ModelSpec;
  readonly workspacePath: string;
  readonly baselineCommit: string;
  readonly fixtureSha256: string;
  readonly failureSet: {
    tool: string;
    failures: {
      file: string;
      line: number;
      column: number;
      ruleId: string;
      message: string;
      severity: 'error';
    }[];
    exitCode: number;
  };
  cleanup(): Promise<void>;
}

export interface AnalysisRemediationExecution {
  readonly task: AnalysisRemediationTask;
  readonly clusterCount: number;
  readonly clusterSize: number;
  readonly proposal: OpResult<WorkerResult>;
  readonly oracle: WorkflowOracleReport;
}

const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

export async function createAnalysisRemediationTask(
  variant: AnalysisVariant,
  modelSpec: ModelSpec,
  parentDirectory = tmpdir(),
): Promise<AnalysisRemediationTask> {
  const definition = ANALYSIS_TASKS[variant];
  const oraclePin = pinnedOperationOracle(definition.oracleId);
  const root = await mkdtemp(join(parentDirectory, 'cq-analysis-task-'));
  const workspacePath = join(root, 'repo');
  await mkdir(join(workspacePath, 'src'), { recursive: true });
  const fixturePath = join(workspacePath, 'analysis-input.txt');
  await writeFile(fixturePath, `${definition.fixture}\n`);
  await writeFile(join(workspacePath, 'src/settings.ts'),
    `export function isValidSetting(value) { return typeof value === 'string' && value.length > 0; }\n`);
  git(workspacePath, ['init', '-q']);
  git(workspacePath, ['config', 'user.name', 'CQ Local Corpus']);
  git(workspacePath, ['config', 'user.email', 'cq-local-corpus@example.invalid']);
  git(workspacePath, ['add', 'analysis-input.txt', 'src/settings.ts']);
  git(workspacePath, ['commit', '-q', '-m', `Seed ${definition.id}`]);
  const baselineCommit = git(workspacePath, ['rev-parse', 'HEAD']);
  const failure = {
    file: 'src/settings.ts', line: variant === 'whitespaceSetting' ? 12 : 24,
    column: 4, ruleId: definition.clusterKey,
    message: definition.fixture.split(': ').slice(1).join(': '), severity: 'error' as const,
  };
  return {
    ...definition,
    oraclePin,
    modelSpec: { ...modelSpec },
    workspacePath,
    baselineCommit,
    variant,
    fixtureSha256: createHash('sha256').update(await readFile(fixturePath)).digest('hex'),
    failureSet: { tool: 'eslint', failures: [failure, { ...failure, line: failure.line + 6 }], exitCode: 1 },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

export async function executeAnalysisRemediationTask(
  task: AnalysisRemediationTask,
  driver: Driver,
): Promise<AnalysisRemediationExecution> {
  const clustered = await clusterErrorsOp({ set: task.failureSet });
  if (clustered.status !== 'ok') throw new Error('analysis corpus seed did not produce clusters');
  const cluster = clustered.value.clusters[0];
  if (cluster === undefined) throw new Error('analysis corpus seed produced no cluster');
  const proposal = await makeAgenticRemediation(driver)({
    clusterId: cluster.id,
    cluster,
    modelSpec: task.modelSpec,
  });
  return {
    task,
    clusterCount: clustered.value.clusters.length,
    clusterSize: cluster.size,
    proposal,
    oracle: proposal.status === 'ok'
      ? judgeAnalysisRemediationProposal(proposal.value.structuredOutput, ANALYSIS_REMEDIATION_CONTRACTS[task.variant === 'whitespaceSetting' ? 'emptySetting' : 'unicodeLabelLength'])
      : { passed: false, sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId, failures: [`operation returned ${proposal.status}`] },
  };
}

export type RatchetVariant = 'lowerErrorCount' | 'higherCoverage';

export interface RatchetTask {
  readonly id: string;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly oraclePin: string;
  readonly substrateFamily: string;
  readonly workspacePath: string;
  readonly baselineCommit: string;
  readonly metric: string;
  readonly direction: 'lower-is-better' | 'higher-is-better';
  readonly initialValue: number;
  readonly improvedValue: number;
  readonly regressedValue: number;
  readonly unit: string;
  cleanup(): Promise<void>;
}

export interface RatchetTaskReport {
  readonly tightened: string;
  readonly regressed: string;
  readonly tighteningAccepted: boolean;
  readonly looseningAccepted: boolean;
  readonly baselineValues: { readonly from: number; readonly tightening: number; readonly loosening: number };
  readonly oracle: WorkflowOracleReport;
}

const RATCHET_DEFINITIONS = {
  lowerErrorCount: {
    id: 'ratchet-lower-error-count-01', sourceId: 'cq-settings.ratchet-metric-seed.v1',
    baselineId: 'cq-settings.ratchet-captured-metric.baseline.v1', oracleId: 'cq-settings.ratchet-monotonicity.oracle.v1',
    substrateFamily: 'lint-error-counter-v1', metric: 'cq-corpus-error-count', direction: 'lower-is-better' as const,
    initialValue: 2, improvedValue: 1, regressedValue: 3, unit: 'errors',
  },
  higherCoverage: {
    id: 'ratchet-higher-coverage-01', sourceId: 'cq-settings.ratchet-coverage-seed.v1',
    baselineId: 'cq-settings.ratchet-coverage.baseline.v1', oracleId: 'cq-settings.ratchet-coverage-monotonicity.oracle.v1',
    substrateFamily: 'line-coverage-summary-v1', metric: 'cq-corpus-line-coverage', direction: 'higher-is-better' as const,
    initialValue: 82, improvedValue: 84, regressedValue: 80, unit: 'percent',
  },
} as const;

export async function createRatchetTask(variant: RatchetVariant, parentDirectory = tmpdir()): Promise<RatchetTask> {
  const definition = RATCHET_DEFINITIONS[variant];
  const oraclePin = pinnedOperationOracle(definition.oracleId);
  const root = await mkdtemp(join(parentDirectory, 'cq-ratchet-task-'));
  const workspacePath = join(root, 'repo');
  await mkdir(join(workspacePath, 'metrics'), { recursive: true });
  await writeFile(join(workspacePath, 'metrics/source.json'), JSON.stringify({ source: definition.metric, value: definition.initialValue, unit: definition.unit }) + '\n');
  git(workspacePath, ['init', '-q']);
  git(workspacePath, ['config', 'user.name', 'CQ Local Corpus']);
  git(workspacePath, ['config', 'user.email', 'cq-local-corpus@example.invalid']);
  git(workspacePath, ['add', 'metrics/source.json']);
  git(workspacePath, ['commit', '-q', '-m', `Seed ${definition.id}`]);
  const baselineCommit = git(workspacePath, ['rev-parse', 'HEAD']);
  return { ...definition, oraclePin, workspacePath, baselineCommit, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

/** Run actual capture/check/monotonicity exports over a fresh task workspace. */
export async function executeRatchetTask(task: RatchetTask): Promise<RatchetTaskReport> {
  const current = { value: task.initialValue };
  const metricSourceId = `local-${task.metric}`;
  if (getAdapter(task.metric) === undefined) {
    registerAdapter({
      id: task.metric,
      direction: task.direction,
      extract(raw) { return typeof raw === 'number' ? { value: raw, unit: task.unit } : null; },
    });
  }
  const sources = new Map([[metricSourceId, async () => current.value]]);
  const capture = createCaptureBaseline(sources);
  const captured = await capture({ ws: task.workspacePath, target: 'settings', metric: task.metric, sourceId: metricSourceId, capturedAt: '2026-09-29T00:00:00.000Z' });
  if (captured.status !== 'ok') throw new Error('ratchet corpus baseline capture failed');
  const check = createCheckRatchet(sources);
  const input = { ws: task.workspacePath, target: 'settings', metric: task.metric, sourceId: metricSourceId };
  current.value = task.improvedValue;
  const tightenedResult = await check(input);
  current.value = task.regressedValue;
  const regressedResult = await check(input);
  if (tightenedResult.status !== 'ok' || regressedResult.status !== 'ok') throw new Error('ratchet corpus check operation failed');
  const diff = (to: number) => [
    `diff --git a/baselines/${task.metric}.json b/baselines/${task.metric}.json`,
    `--- a/baselines/${task.metric}.json`, `+++ b/baselines/${task.metric}.json`, '@@ -1,5 +1,5 @@',
    ' {', '   "target": "settings",', `-  "value": ${task.initialValue},`, `+  "value": ${to},`,
    `   "metric": "${task.metric}",`, `   "direction": "${task.direction}"`, ' }',
  ].join('\n');
  const tightening = checkDiffMonotonicity(diff(task.improvedValue));
  const loosening = checkDiffMonotonicity(diff(task.regressedValue));
  const oracle = judgeRatchetOutcomes({
    tightened: tightenedResult.value.verdict,
    regressed: regressedResult.value.verdict,
    tighteningAccepted: tightening.ok,
    looseningAccepted: loosening.ok,
    direction: task.direction,
    sourceId: task.sourceId,
    baselineId: task.baselineId,
    oracleId: task.oracleId,
    initialValue: task.initialValue,
    improvedValue: task.improvedValue,
    regressedValue: task.regressedValue,
  });
  return {
    tightened: tightenedResult.value.verdict,
    regressed: regressedResult.value.verdict,
    tighteningAccepted: tightening.ok,
    looseningAccepted: loosening.ok,
    baselineValues: { from: task.initialValue, tightening: task.improvedValue, loosening: task.regressedValue },
    oracle,
  };
}

export function judgeAnalysisTask(
  task: AnalysisRemediationTask,
  proposal: OpResult<WorkerResult>,
): WorkflowOracleReport {
  if (proposal.status !== 'ok') return { sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId, passed: false, failures: [`operation returned ${proposal.status}`] };
  const semantic = judgeAnalysisRemediationProposal(
    proposal.value.structuredOutput,
    ANALYSIS_REMEDIATION_CONTRACTS[task.variant === 'whitespaceSetting' ? 'emptySetting' : 'unicodeLabelLength'],
  );
  return { ...semantic, sourceId: task.sourceId, baselineId: task.baselineId, oracleId: task.oracleId };
}
