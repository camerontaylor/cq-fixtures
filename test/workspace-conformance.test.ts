import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { SessionStore } from '@camerontaylor/cq-toolkit';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../runner/artifacts/index.ts';
import { experimentId, suiteTaskId, type ExperimentContext } from '../runner/experiment.ts';
import { runSuite, SESSION_STORE_DIR } from '../runner/index.ts';
import { campaignUsage, validatedLaunchEvidenceLaunched, type InvocationIdentity, type NativeObservation, type ObservedDriver } from '../runner/native/observation.ts';
import { inventoryTaskWorkspace, runWorkspaceConformance, WorkspaceConformanceError, type NativeLifecycleEvidence } from '../runner/native/workspace-conformance.ts';

const TASK_ID = 'review-loop-label-limit-02';
const SOURCE_ID = 'cq-settings.settings-module-seed.v2';
const BASELINE_ID = 'cq-settings.label-length-defect.baseline.v2';
const SUBSTRATE = `${SOURCE_ID}:${BASELINE_ID}:campaign-settings-module-v2`;
const ORACLE_PIN = 'e178dd958c9371588b8bbedd18d1c0b022863b23a8e8e4539ba0614aae2d97bb';
const INITIAL_SETTINGS = `export function isValidCampaignLabel(label) {
  return typeof label === 'string' && label.trim().length > 0;
}
`;
const FIXED_SETTINGS = `export function isValidCampaignLabel(label) {
  return typeof label === 'string' && label.trim().length > 0 && [...label.trim()].length <= 40;
}
`;
const DISPLAY_SOURCE = `export function displayCampaignLabel(label) {
  return label;
}
`;
const PUBLIC_TEST = `import assert from 'node:assert/strict';
import { isValidCampaignLabel } from '../settings/module.js';
import { displayCampaignLabel } from '../settings/display.js';
assert.equal(isValidCampaignLabel(''), false);
assert.equal(isValidCampaignLabel('   '), false);
assert.equal(isValidCampaignLabel('Campaign A'), true);
assert.equal(isValidCampaignLabel('x'.repeat(41)), false);
assert.equal(displayCampaignLabel('  Campaign A  '), '  Campaign A  ');
`;

let tempRoot = '';
afterEach(() => { if (tempRoot !== '') rmSync(tempRoot, { recursive: true, force: true }); });

class InjectedObservedNativeDriver implements Driver, ObservedDriver {
  identity?: InvocationIdentity;
  readonly launched: string[] = [];
  extensionReceiverPreserved = false;
  constructor(
    private readonly behavior: 'fix' | 'throw-after-edit' = 'fix',
    private readonly launchStatus?: 'spawn-observed' | 'no-spawn-observed' | 'unknown',
    private readonly lifecycleMode: 'valid' | 'missing' | 'bad-reference' = 'valid',
  ) {}

  nativeExtension(): void { this.extensionReceiverPreserved = true; }

  async beginInvocation(identity: InvocationIdentity): Promise<void> { this.identity = identity; }

  async run(invocation: OpInvocation): Promise<WorkerResult> {
    if (this.identity === undefined || invocation.sessionRef === undefined) throw new Error('missing native identity/session');
    const session = await new SessionStore(SESSION_STORE_DIR).load(invocation.sessionRef);
    if (session === undefined) throw new Error('runSuite session was not found');
    this.launched.push(invocation.sessionRef);
    writeFileSync(join(session.workspace, 'settings/module.js'), FIXED_SETTINGS);
    if (this.behavior === 'throw-after-edit') throw new Error('injected transport ended after edit');
    return {
      model: invocation.modelSpec.model,
      structuredOutput: { fixed: true, notes: 'deterministic v2 workspace binding probe' },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [], stopReason: 'complete',
    };
  }

  getObservation(invocationId: string): NativeObservation | undefined {
    if (this.identity === undefined || this.identity.invocationId !== invocationId) return undefined;
    const unknown = (semantics: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning') => ({
      value: null, availability: 'unavailable' as const, source: null, semantics,
    });
    const counters = {
      input: unknown('input'), output: unknown('output'), cacheRead: unknown('cacheRead'),
      cacheWrite: unknown('cacheWrite'), reasoning: unknown('reasoning'),
    };
    return {
      schemaVersion: 1,
      identity: this.identity,
      transport: 'injected-development-driver',
      executable: { path: 'development-injection', version: null, profile: 'test' },
      artifacts: [
        { kind: 'process-stop', path: 'injected/lifecycle/process-stop.json', sha256: digest('injected-process-stop') },
        { kind: 'worker-settlement', path: 'injected/lifecycle/worker-settlement.json', sha256: digest('injected-worker-settlement') },
      ], withheldArtifacts: [],
      model: {
        configuredTarget: 'test/native-v2',
        requested: { value: 'test/native-v2', source: 'test', status: 'verified' },
        observed: { value: null, source: null, status: 'unavailable' }, settings: {},
      },
      usage: {
        counters,
        tokenTotal: { value: null, availability: 'unavailable', source: null, semantics: 'unknown' },
        inclusion: { input: null, output: null, cache: null, reasoning: null },
      },
      terminal: {
        cause: this.behavior === 'throw-after-edit' ? 'transport-error' : null,
        cancelled: false,
        transportException: this.behavior === 'throw-after-edit' ? { name: 'Error', message: 'injected transport ended after edit' } : null,
        observedAt: new Date().toISOString(),
      },
      capture: { status: 'pending-runner-capture', baselineCommit: null, baselineTree: null, patchSha256: null, workspaceSha256: null },
      timing: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), stages: {} },
      workerResult: null,
    };
  }

  getLaunchEvidence(invocationId: string) {
    if (this.identity === undefined || this.identity.invocationId !== invocationId || this.launchStatus === undefined) return undefined;
    return {
      identity: this.identity,
      status: this.launchStatus,
      source: 'injected-development-driver',
      observedAt: new Date().toISOString(),
    };
  }

  getLifecycleEvidence(invocationId: string): NativeLifecycleEvidence | undefined {
    if (this.identity === undefined || this.identity.invocationId !== invocationId || this.lifecycleMode === 'missing') return undefined;
    return {
      identity: this.identity,
      process: {
        status: this.launchStatus === 'no-spawn-observed' ? 'not-started' : 'stopped',
        evidence: {
          kind: 'process-stop', path: 'injected/lifecycle/process-stop.json',
          sha256: digest(this.lifecycleMode === 'bad-reference' ? 'wrong-stop-proof' : 'injected-process-stop'),
        },
      },
      settlement: {
        status: 'settled',
        evidence: {
          kind: 'worker-settlement', path: 'injected/lifecycle/worker-settlement.json', sha256: digest('injected-worker-settlement'),
        },
      },
    };
  }
}

function fixture() {
  tempRoot = mkdtempSync(join(tmpdir(), 'cq-workspace-conformance-test-'));
  const repoRoot = join(tempRoot, 'repo');
  const suiteDir = join(repoRoot, 'suite');
  const fixtureDir = join(repoRoot, 'fixtures/v2-label-limit');
  mkdirSync(suiteDir, { recursive: true });
  mkdirSync(join(fixtureDir, 'settings'), { recursive: true });
  mkdirSync(join(fixtureDir, 'test'), { recursive: true });
  mkdirSync(join(repoRoot, 'trusted'), { recursive: true });
  mkdirSync(join(repoRoot, 'policy/denylist'), { recursive: true });
  writeFileSync(join(repoRoot, 'policy/denylist/patterns.yml'), readFileSync(new URL('../policy/denylist/patterns.yml', import.meta.url)));
  writeFileSync(join(fixtureDir, 'package.json'), `${JSON.stringify({
    name: 'local-campaign-settings-task', private: true, type: 'module',
    scripts: { test: 'node test/public-settings.test.mjs' },
  }, null, 2)}\n`);
  writeFileSync(join(fixtureDir, 'settings/module.js'), INITIAL_SETTINGS);
  writeFileSync(join(fixtureDir, 'settings/display.js'), DISPLAY_SOURCE);
  writeFileSync(join(fixtureDir, 'test/public-settings.test.mjs'), PUBLIC_TEST);
  const checkPath = join(repoRoot, 'trusted/v2-label-limit-check.mjs');
  writeFileSync(checkPath, `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
assert.equal(process.env.CQ_REVIEW_LOOP_ORACLE_PIN, '${ORACLE_PIN}');
assert.ok(process.env.CQ_REVIEW_LOOP_BASELINE_SHA);
const candidate = await import(pathToFileURL(join(process.cwd(), 'settings/module.js')));
assert.equal(candidate.isValidCampaignLabel(''), false);
assert.equal(candidate.isValidCampaignLabel('   '), false);
assert.equal(candidate.isValidCampaignLabel('Campaign A'), true);
assert.equal(candidate.isValidCampaignLabel('x'.repeat(41)), false);
assert.equal(candidate.isValidCampaignLabel('😀'.repeat(40)), true);
assert.equal(candidate.isValidCampaignLabel('😀'.repeat(41)), false);
`);
  writeFileSync(join(suiteDir, 'suite.json'), `${JSON.stringify({
    name: 'review-loop-visible-g1-v2', role: 'fixer-worker',
    provenance: { origin: 'deterministic workspace conformance development probe' },
    cases: [{
      id: TASK_ID, fixture: 'fixtures/v2-label-limit',
      task: { prompt: 'Limit trimmed campaign labels to 40 Unicode code points. Preserve display behavior.' },
      probe: { kind: 'check-rerun', check: 'trusted/v2-label-limit-check.mjs' },
    }],
  }, null, 2)}\n`);
  const git = (args: string[]) => execFileSync('git', args, { cwd: fixtureDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'CQ v2 test corpus']);
  git(['config', 'user.email', 'cq-v2-test@example.invalid']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Seed v2 campaign label task']);
  const taskCommit = git(['rev-parse', 'HEAD']);
  const taskTree = git(['rev-parse', 'HEAD^{tree}']);
  const frozenBaseline = inventoryTaskWorkspace(fixtureDir);
  const experiment: ExperimentContext = {
    campaignId: 'campaign-workspace-conformance', cohortId: 'visible-g1',
    experimentId: experimentId({ track: 'native-primary', sourcePins: { source: SOURCE_ID }, corpusPin: BASELINE_ID,
      promptPin: 'prompt-v2-test', judgePin: ORACLE_PIN, strategy: 'test-native', settings: 'test-settings', profile: 'test-profile', budget: 'test-budget' }),
    taskId: suiteTaskId('review-loop-visible-g1-v2', SUBSTRATE), repeatId: 'repeat-1',
    assignmentId: 'assignment-workspace-v2', stageId: 'stage-1', attemptId: 'attempt-1',
    track: 'native-primary', strategyId: 'test-native', settingsId: 'test-settings', budgetId: 'test-budget',
    profileId: 'unverified-test-profile', frozenWeight: 1, substrateId: SUBSTRATE,
    judgeManifest: {
      sourcePin: ORACLE_PIN,
      dependencies: [{ path: 'trusted/v2-label-limit-check.mjs', sha256: digest(readFileSync(checkPath)) }],
    },
  };
  const artifactRoot = join(tempRoot, 'artifacts');
  const invoke = (driver: Driver, receiptRoot = artifactRoot) => runWorkspaceConformance({
    driver: driver as Driver & ObservedDriver & { getLifecycleEvidence: (invocationId: string) => NativeLifecycleEvidence | undefined }, experiment, suiteName: 'review-loop-visible-g1-v2', caseId: TASK_ID,
    frozenJudgePin: ORACLE_PIN,
    frozenBaseline: { contentSha256: frozenBaseline.contentSha256, taskCommit, taskTree },
    artifactRoot: receiptRoot,
    runSuite: (boundDriver) => {
      (boundDriver as Driver & { nativeExtension: () => void }).nativeExtension();
      return runSuite({
        suiteDir, repoRoot, artifactRoot, driver: boundDriver,
        model: 'test/native-v2', provider: 'test', driverName: 'pi-json', experiment,
        hostCheckScoringEnvironment: (_workspace, pinnedBaselineCommit) => ({
          CQ_REVIEW_LOOP_BASELINE_SHA: pinnedBaselineCommit,
          CQ_REVIEW_LOOP_ORACLE_PIN: ORACLE_PIN,
        }),
      });
    },
  });
  return { repoRoot, fixtureDir, suiteDir, checkPath, taskCommit, taskTree, frozenBaseline, experiment, artifactRoot, invoke };
}

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('task-owned native workspace conformance seam', () => {
  it('uses the real runSuite SessionStore, judges the v2 edit, and finalizes a joined receipt', async () => {
    const env = fixture();
    const driver = new InjectedObservedNativeDriver();
    const conformance = await env.invoke(driver);
    expect(driver.launched).toHaveLength(1);
    expect(conformance.receipt.status).toBe('passed');
    expect(conformance.receipt.workspaceSeparationStatus).toBe('passed');
    expect(conformance.receipt.lifecycle.qualification).toBe('qualified');
    expect(conformance.receipt.baseline.taskCommitRelation).toBe('different-commit-same-tree');
    expect(driver.extensionReceiverPreserved).toBe(true);
    expect(conformance.receipt.baseline.taskTree).toBe(env.taskTree);
    expect(conformance.receipt.workspaces.assigned.removedByRunSuite).toBe(true);
    expect(conformance.receipt.workspaces.control.unchanged).toBe(true);
    expect(conformance.receipt.workspaces.control.removedByConformance).toBe(true);
    expect(conformance.receipt.selectedJudgement?.judgePin).toBe(ORACLE_PIN);
    expect(conformance.receipt.candidate.sha256).toBe(conformance.receipt.selectedJudgement?.candidateSha256);
    expect(conformance.result.rows[0]?.outcome.passed).toBe(2);
    expect(conformance.receipt.judgedOutcome).toMatchObject({ candidateCorrectness: true, formatConformance: true, assignedStrategySuccess: true });
    expect(conformance.result.tables).toHaveLength(1);
    const counterUsage = conformance.result.rows[0]?.observedUsage;
    expect(counterUsage).toBeDefined();
    expect(conformance.result.taskOutcomes[0]?.outcome.execution?.sourceInvocationIds).toHaveLength(1);
    expect(conformance.result.taskOutcomes[0]?.outcome.execution?.launched).toBe(true);
    expect(campaignUsage(conformance.result.observations[0]!.observation).tokenTotal).toBeNull();
    const store = new ArtifactStore(env.artifactRoot);
    const receiptFile = join(store.root, conformance.artifact.path);
    expect(existsSync(receiptFile)).toBe(true);
    const receiptBytes = readFileSync(receiptFile);
    expect(createHash('sha256').update(receiptBytes).digest('hex')).toBe(conformance.artifact.sha256);
    expect(receiptBytes.toString('utf8')).toContain('"control"');
    expect(() => store.write(env.experiment, 'workspace-conformance.json', receiptBytes)).toThrow(/immutable artifact already exists/);
  }, 30_000);

  it('uses identity-bound no-spawn evidence over a returned WorkerResult and keeps legacy fallback when absent', async () => {
    const env = fixture();
    const explicitNoSpawn = new InjectedObservedNativeDriver('fix', 'no-spawn-observed');
    const run = await env.invoke(explicitNoSpawn);
    expect(run.result.taskOutcomes[0]?.outcome.execution?.launched).toBe(false);
    expect(run.receipt.lifecycle.qualification).toBe('qualified');

    const identity: InvocationIdentity = { invocationId: 'inv-1', assignmentId: 'a-1', stageId: 's-1', attemptId: 'try-1' };
    const evidence = {
      identity, status: 'spawn-observed' as const, source: 'test-source', observedAt: new Date().toISOString(),
    };
    expect(validatedLaunchEvidenceLaunched(evidence, identity)).toBe(true);
    expect(validatedLaunchEvidenceLaunched({ ...evidence, status: 'unknown' }, identity)).toBeNull();
    expect(validatedLaunchEvidenceLaunched({ ...evidence, status: 'no-spawn-observed' }, identity)).toBe(false);
    expect(validatedLaunchEvidenceLaunched({ ...evidence, identity: { ...identity, assignmentId: 'other' } }, identity)).toBeNull();
    expect(validatedLaunchEvidenceLaunched(undefined, identity)).toBeUndefined();

  }, 30_000);

  it('reports workspace separation separately and refuses full qualification without native stop and settlement proof', async () => {
    const env = fixture();
    const driver = new InjectedObservedNativeDriver('fix', undefined, 'missing');
    let thrown: unknown;
    try { await env.invoke(driver); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(WorkspaceConformanceError);
    const receipt = (thrown as WorkspaceConformanceError).receipt;
    expect(receipt.workspaceSeparationStatus).toBe('passed');
    expect(receipt.lifecycle).toMatchObject({ qualification: 'unknown', identityMatched: false, processStatus: null, settlementStatus: null });
    expect(receipt.failureCodes).toContain('native-lifecycle-evidence-unavailable');
    expect(receipt.status).toBe('failed');
  }, 30_000);

  it('rejects stop and settlement references absent from the matching native observation', async () => {
    const env = fixture();
    const driver = new InjectedObservedNativeDriver('fix', undefined, 'bad-reference');
    let thrown: unknown;
    try { await env.invoke(driver); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(WorkspaceConformanceError);
    const receipt = (thrown as WorkspaceConformanceError).receipt;
    expect(receipt.workspaceSeparationStatus).toBe('passed');
    expect(receipt.lifecycle.qualification).toBe('failed');
    expect(receipt.failureCodes).toContain('native-lifecycle-evidence-reference-mismatch');
  }, 30_000);

  it('rejects control mutation after dispatch and still removes the control copy', async () => {
    const env = fixture();
    const driver = new InjectedObservedNativeDriver();
    let controlPath = '';
    await expect(runWorkspaceConformance({
      driver, experiment: env.experiment, suiteName: 'review-loop-visible-g1-v2', caseId: TASK_ID,
      frozenJudgePin: ORACLE_PIN,
      frozenBaseline: { contentSha256: env.frozenBaseline.contentSha256, taskCommit: env.taskCommit, taskTree: env.taskTree },
      artifactRoot: env.artifactRoot,
      testHooks: { afterWorkerForTest(control) { controlPath = control; writeFileSync(join(control, 'control-tamper.txt'), 'mutation'); } },
      runSuite: (boundDriver) => runSuite({
        suiteDir: env.suiteDir, repoRoot: env.repoRoot, artifactRoot: join(tempRoot, 'runner-artifacts'),
        driver: boundDriver, model: 'test/native-v2', provider: 'test', driverName: 'pi-json', experiment: env.experiment,
        hostCheckScoringEnvironment: (_workspace, commit) => ({ CQ_REVIEW_LOOP_BASELINE_SHA: commit, CQ_REVIEW_LOOP_ORACLE_PIN: ORACLE_PIN }),
      }),
    })).rejects.toMatchObject({ receipt: { status: 'failed', failureCodes: expect.arrayContaining(['control-workspace-mutated']) } });
    expect(controlPath).not.toBe('');
    expect(existsSync(controlPath)).toBe(false);
  }, 30_000);

  it('refuses a sessionRef resolved to a different task tree before driver launch', async () => {
    const env = fixture();
    const wrong = join(tempRoot, 'wrong-session-workspace');
    mkdirSync(wrong);
    writeFileSync(join(wrong, 'wrong.txt'), 'not the frozen v2 task');
    const driver = new InjectedObservedNativeDriver();
    const wrongStore = {
      async load(sessionId: string) { return { sessionId, workspace: wrong, createdAt: new Date().toISOString(), messages: [] }; },
    } as unknown as Pick<SessionStore, 'load'>;
    await expect(runWorkspaceConformance({
      driver, experiment: env.experiment, suiteName: 'review-loop-visible-g1-v2', caseId: TASK_ID,
      frozenJudgePin: ORACLE_PIN,
      frozenBaseline: { contentSha256: env.frozenBaseline.contentSha256, taskCommit: env.taskCommit, taskTree: env.taskTree },
      artifactRoot: env.artifactRoot, sessionStore: wrongStore,
      runSuite: (boundDriver) => runSuite({
        suiteDir: env.suiteDir, repoRoot: env.repoRoot, artifactRoot: join(tempRoot, 'runner-artifacts'),
        driver: boundDriver, model: 'test/native-v2', provider: 'test', driverName: 'pi-json', experiment: env.experiment,
        hostCheckScoringEnvironment: (_workspace, commit) => ({ CQ_REVIEW_LOOP_BASELINE_SHA: commit, CQ_REVIEW_LOOP_ORACLE_PIN: ORACLE_PIN }),
      }),
    })).rejects.toMatchObject({ receipt: { failureCodes: expect.arrayContaining(['assigned-workspace-does-not-match-frozen-task']) } });
    expect(driver.launched).toHaveLength(0);
  }, 30_000);

  it('captures a thrown edit, records its independent judgement, and fails closed if receipt finalization fails', async () => {
    const env = fixture();
    const driver = new InjectedObservedNativeDriver('throw-after-edit');
    const blockedReceiptRoot = join(tempRoot, 'blocked-receipt-root');
    const target = join(tempRoot, 'receipt-target');
    mkdirSync(target);
    symlinkSync(target, blockedReceiptRoot);
    let thrown: unknown;
    try { await env.invoke(driver, blockedReceiptRoot); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(WorkspaceConformanceError);
    expect((thrown as WorkspaceConformanceError).receipt.failureCodes).toContain('receipt-finalization-failed');
    expect(driver.launched).toHaveLength(1);
    expect((thrown as WorkspaceConformanceError).receipt.workspaces.assigned.removedByRunSuite).toBe(true);
    expect((thrown as WorkspaceConformanceError).receipt.workspaces.control.removedByConformance).toBe(true);
    expect((thrown as WorkspaceConformanceError).receipt.candidate.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((thrown as WorkspaceConformanceError).receipt.selectedJudgement?.judgePin).toBe(ORACLE_PIN);
    expect((thrown as WorkspaceConformanceError).receipt.outcomeArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(SESSION_STORE_DIR, `${driver.launched[0]}.jsonl`))).toBe(false);
  }, 30_000);
});
