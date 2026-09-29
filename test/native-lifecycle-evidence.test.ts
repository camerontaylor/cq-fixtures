import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { afterEach, describe, expect, it } from 'vitest';
import { ObservedNativeDriver, createWorkerResult } from '../runner/native/observed-driver.ts';
import { ArtifactStore } from '../runner/artifacts/index.ts';
import { experimentId, suiteTaskId, type ExperimentContext } from '../runner/experiment.ts';
import { runSuite } from '../runner/index.ts';
import { CodexExecDriver } from '../runner/native/codex.ts';
import { PiNativeDriver } from '../runner/native/pi.ts';
import { visibleCalibrationSpawnAdapter } from '../runner/native/process.ts';
import { inventoryTaskWorkspace, runWorkspaceConformance } from '../runner/native/workspace-conformance.ts';
import type { InvocationIdentity } from '../runner/native/observation.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-native-lifecycle-test-'));
  roots.push(root);
  return root;
}

function invocation(): OpInvocation {
  return {
    prompt: 'fixture-only lifecycle test', modelSpec: { model: 'test-model', provider: 'test-provider' },
    toolPolicy: { allow: [], mode: 'none' }, sandboxPolicy: { level: 'workspace-write' }, budget: { wallClockMs: 1_000 },
  };
}

const testIdentity: InvocationIdentity = {
  invocationId: 'lifecycle-test-invocation', assignmentId: 'lifecycle-test-assignment',
  stageId: 'lifecycle-test-stage', attemptId: 'lifecycle-test-attempt',
};

class LifecycleProbeDriver extends ObservedNativeDriver {
  constructor(
    artifactDirectory: string,
    private readonly treeStopped: boolean,
    private readonly failure?: Error,
  ) {
    super({ configuredTarget: 'test/model', transport: 'lifecycle-test', executable: 'fake',
      executableVersion: 'fake-1', profile: 'fixture', artifactDirectory });
  }

  protected async runObserved(input: OpInvocation, identity: InvocationIdentity): Promise<WorkerResult> {
    const observation = this.newObservation(identity, input, new Date().toISOString());
    this.observations.set(identity.invocationId, observation);
    this.reportProcessTree(identity, this.treeStopped);
    if (this.failure) {
      this.failObservation(observation, this.failure);
      throw this.failure;
    }
    const result = createWorkerResult({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 'complete');
    this.finishObservation(observation, result);
    return result;
  }
}

async function run(driver: LifecycleProbeDriver): Promise<void> {
  await driver.beginInvocation(testIdentity);
  await driver.run(invocation());
}

const oraclePin = 'e178dd958c9371588b8bbedd18d1c0b022863b23a8e8e4539ba0614aae2d97bb';
const sourceId = 'cq-settings.lifecycle-test-source';
const baselineId = 'cq-settings.lifecycle-test-baseline';
const substrateId = `${sourceId}:${baselineId}:native-lifecycle-test`;
const initialModule = `export function isValidCampaignLabel(label) { return typeof label === 'string' && label.trim().length > 0; }\n`;
const fixedModule = `export function isValidCampaignLabel(label) { return typeof label === 'string' && label.trim().length > 0 && [...label.trim()].length <= 40; }\n`;
const displayModule = `export function displayCampaignLabel(label) { return label; }\n`;
const publicTest = `import assert from 'node:assert/strict';
import { isValidCampaignLabel } from '../settings/module.js';
import { displayCampaignLabel } from '../settings/display.js';
assert.equal(isValidCampaignLabel(''), false);
assert.equal(isValidCampaignLabel('Campaign A'), true);
assert.equal(isValidCampaignLabel('x'.repeat(41)), false);
assert.equal(isValidCampaignLabel('😀'.repeat(41)), false);
assert.equal(displayCampaignLabel('  Campaign A  '), '  Campaign A  ');
`;

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function nativeWorkspaceFixture(root: string, route: 'codex' | 'pi') {
  const repoRoot = join(root, 'repo');
  const suiteDir = join(repoRoot, 'suite');
  const taskDir = join(repoRoot, 'fixtures/native-lifecycle');
  mkdirSync(join(taskDir, 'settings'), { recursive: true });
  mkdirSync(join(taskDir, 'test'), { recursive: true });
  mkdirSync(join(repoRoot, 'trusted'), { recursive: true });
  mkdirSync(join(repoRoot, 'policy/denylist'), { recursive: true });
  mkdirSync(suiteDir, { recursive: true });
  writeFileSync(join(repoRoot, 'policy/denylist/patterns.yml'), readFileSync(new URL('../policy/denylist/patterns.yml', import.meta.url)));
  writeFileSync(join(taskDir, 'package.json'), `${JSON.stringify({
    name: 'native-lifecycle-fixture', private: true, type: 'module',
    scripts: { test: 'node test/public.test.mjs' },
  }, null, 2)}\n`);
  writeFileSync(join(taskDir, 'settings/module.js'), initialModule);
  writeFileSync(join(taskDir, 'settings/display.js'), displayModule);
  writeFileSync(join(taskDir, 'test/public.test.mjs'), publicTest);
  const trustedCheck = `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
assert.equal(process.env.CQ_REVIEW_LOOP_ORACLE_PIN, '${oraclePin}');
assert.ok(process.env.CQ_REVIEW_LOOP_BASELINE_SHA);
const candidate = await import(pathToFileURL(join(process.cwd(), 'settings/module.js')));
assert.equal(candidate.isValidCampaignLabel(''), false);
assert.equal(candidate.isValidCampaignLabel('x'.repeat(41)), false);
assert.equal(candidate.isValidCampaignLabel('😀'.repeat(41)), false);
`;
  writeFileSync(join(repoRoot, 'trusted/check.mjs'), trustedCheck);
  const taskId = 'native-lifecycle-01';
  const suiteName = 'native-lifecycle-visible-g1';
  writeFileSync(join(suiteDir, 'suite.json'), `${JSON.stringify({
    name: suiteName, role: 'fixer-worker',
    provenance: { origin: 'synthetic native lifecycle integration' },
    cases: [{
      id: taskId, fixture: 'fixtures/native-lifecycle',
      task: { prompt: 'Limit trimmed campaign labels to 40 Unicode code points and preserve display behavior.' },
      probe: { kind: 'check-rerun', check: 'trusted/check.mjs' },
    }],
  }, null, 2)}\n`);
  const git = (args: string[]) => execFileSync('git', args, { cwd: taskDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Native Lifecycle Fixture']);
  git(['config', 'user.email', 'native-lifecycle@example.invalid']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Seed synthetic lifecycle task']);
  const taskCommit = git(['rev-parse', 'HEAD']);
  const taskTree = git(['rev-parse', 'HEAD^{tree}']);
  const frozen = inventoryTaskWorkspace(taskDir);
  // runSuite creates its own materialized baseline. Do not copy the source
  // fixture's .git directory into that workspace or its pristine commit is
  // already present, leaving no diff base for the synthetic worker edit.
  rmSync(join(taskDir, '.git'), { recursive: true, force: true });
  const stageId = `${route}-stage-1`;
  const attemptId = `${route}-attempt-1`;
  const assignmentId = `native-lifecycle-${route}`;
  const experiment: ExperimentContext = {
    campaignId: 'campaign-native-lifecycle-test', cohortId: 'visible-g1',
    experimentId: experimentId({ track: 'native-primary', sourcePins: { source: sourceId }, corpusPin: baselineId,
      promptPin: 'native-lifecycle-prompt', judgePin: oraclePin, strategy: route, settings: 'test-settings', profile: 'test-profile', budget: 'test-budget' }),
    taskId: suiteTaskId(suiteName, substrateId), repeatId: 'repeat-1', assignmentId, stageId, attemptId,
    track: 'native-primary', strategyId: route, settingsId: 'test-settings', budgetId: 'test-budget',
    profileId: 'synthetic-fake-cli', frozenWeight: 1, substrateId,
    judgeManifest: { sourcePin: oraclePin, dependencies: [{ path: 'trusted/check.mjs', sha256: sha256(trustedCheck) }] },
  };
  const artifactRoot = join(root, `${route}-artifacts`);
  return { repoRoot, suiteDir, taskDir, taskId, suiteName, frozen, taskCommit, taskTree, experiment, artifactRoot, stageId, attemptId, assignmentId };
}

function fakeNativeExecutable(root: string, route: 'codex' | 'pi'): string {
  const executable = join(root, `${route}-fake-cli`);
  const event = route === 'codex'
    ? [
      { type: 'item.completed', item: { type: 'agent_message', text: '{"fixed":true,"notes":"synthetic edit"}' } },
      { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
    ].map((frame) => JSON.stringify(frame)).join('\n')
    : JSON.stringify({ type: 'message_end', message: {
      id: 'synthetic-pi-final', role: 'assistant', stopReason: 'stop', usage: { input: 2, output: 1 },
      content: [{ type: 'text', text: '{"fixed":true,"notes":"synthetic edit"}' }],
    } });
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync('settings/module.js', ${JSON.stringify(fixedModule)});
process.stdout.write(${JSON.stringify(`${event}\n`)});
`;
  writeFileSync(executable, source, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return executable;
}

function createRunSuiteInvocation(env: ReturnType<typeof nativeWorkspaceFixture>, driver: Driver, route: 'codex' | 'pi') {
  const model = 'test/native-lifecycle';
  return () => runSuite({
    suiteDir: env.suiteDir, repoRoot: env.repoRoot, artifactRoot: env.artifactRoot, driver,
    model, provider: 'test-provider', driverName: route === 'codex' ? 'codex-exec' : 'pi-json', experiment: env.experiment,
    hostCheckScoringEnvironment: (_workspace, baselineCommit) => ({
      CQ_REVIEW_LOOP_BASELINE_SHA: baselineCommit, CQ_REVIEW_LOOP_ORACLE_PIN: oraclePin,
    }),
  });
}

describe('native lifecycle evidence', () => {
  it('persists identity-bound process-stop and final-settlement evidence in the matching observation', async () => {
    const root = tempRoot();
    const driver = new LifecycleProbeDriver(join(root, 'artifacts'), true);
    await run(driver);

    const observation = driver.getObservation(testIdentity.invocationId)!;
    const evidence = driver.getLifecycleEvidence(testIdentity.invocationId)!;
    const artifact = observation.artifacts.find(({ kind }) => kind === 'native-lifecycle')!;
    expect(evidence.identity).toEqual(testIdentity);
    expect(evidence.process).toEqual({ status: 'stopped', evidence: artifact });
    expect(evidence.settlement).toEqual({ status: 'settled', evidence: artifact });
    const bytes = readFileSync(artifact.path);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    expect(statSync(artifact.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({
      identity: testIdentity,
      process: { status: 'stopped', proofSource: 'runSupervised.treeStopped' },
      settlement: { status: 'settled', proofSource: 'ObservedNativeDriver.run finally' },
    });
  });

  it('retains the original transport failure while persisting successful stop and settlement proof', async () => {
    const root = tempRoot();
    const primary = new Error('primary synthetic transport failure');
    const driver = new LifecycleProbeDriver(join(root, 'artifacts'), true, primary);
    await expect(run(driver)).rejects.toBe(primary);

    expect(driver.getLifecycleEvidence(testIdentity.invocationId)).toMatchObject({
      identity: testIdentity, process: { status: 'stopped' }, settlement: { status: 'settled' },
    });
    expect(driver.getObservation(testIdentity.invocationId)?.terminal.transportException).toMatchObject({
      name: 'Error', message: 'primary synthetic transport failure',
    });
  });

  it('keeps an unproven process-tree stop unknown after the driver settles', async () => {
    const root = tempRoot();
    const driver = new LifecycleProbeDriver(join(root, 'artifacts'), false);
    await run(driver);
    const evidence = driver.getLifecycleEvidence(testIdentity.invocationId)!;
    expect(evidence.process.status).toBe('unknown');
    expect(evidence.settlement.status).toBe('settled');
    const artifact = driver.getObservation(testIdentity.invocationId)?.artifacts.find(({ kind }) => kind === 'native-lifecycle');
    expect(artifact).toBeDefined();
    expect(JSON.parse(readFileSync(artifact!.path, 'utf8')).process)
      .toEqual({ status: 'unknown', proofSource: 'runSupervised.treeStopped' });
  });

  it('keeps evidence unknown on artifact write failure without replacing the primary error', async () => {
    const root = tempRoot();
    const artifactRootFile = join(root, 'not-a-directory');
    writeFileSync(artifactRootFile, 'block lifecycle artifact directory');
    chmodSync(artifactRootFile, 0o600);
    const primary = new Error('primary failure survives lifecycle write failure');
    const driver = new LifecycleProbeDriver(artifactRootFile, true, primary);
    await expect(run(driver)).rejects.toBe(primary);

    const observation = driver.getObservation(testIdentity.invocationId)!;
    expect(observation.terminal.transportException?.message).toBe(primary.message);
    expect(observation.artifacts.some(({ kind }) => kind === 'native-lifecycle')).toBe(false);
    expect(driver.getLifecycleEvidence(testIdentity.invocationId)).toMatchObject({
      identity: testIdentity,
      process: { status: 'unknown', evidence: null },
      settlement: { status: 'unknown', evidence: null },
    });
  });

  it.each(['codex', 'pi'] as const)('joins real %s native stop and settlement evidence through runSuite and workspace-conformance', async (route) => {
    const root = tempRoot();
    const env = nativeWorkspaceFixture(root, route);
    const executable = fakeNativeExecutable(root, route);
    const spawnAdapter = visibleCalibrationSpawnAdapter({
      admissionId: `synthetic-${route}-lifecycle-test`, scope: 'visible-calibration',
      isolation: 'disabled', heldOut: false, environmentNames: ['PATH'],
    });
    const nativeOptions = {
      executable, version: 'synthetic-fixture-1', model: 'test/native-lifecycle',
      artifactDirectory: join(root, `${route}-native-artifacts`), spawnAdapter,
    };
    const driver = route === 'codex'
      ? new CodexExecDriver({ ...nativeOptions, effort: 'low' })
      : new PiNativeDriver({ ...nativeOptions, mode: 'json', provider: 'test-provider', thinking: 'high' });
    const conformance = await runWorkspaceConformance({
      driver, experiment: env.experiment, suiteName: env.suiteName, caseId: env.taskId,
      frozenJudgePin: oraclePin,
      frozenBaseline: { contentSha256: env.frozen.contentSha256, taskCommit: env.taskCommit, taskTree: env.taskTree },
      artifactRoot: env.artifactRoot,
      runSuite: (boundDriver) => createRunSuiteInvocation(env, boundDriver, route)(),
    });

    expect(conformance.receipt.status).toBe('passed');
    expect(conformance.receipt.workspaceSeparationStatus).toBe('passed');
    expect(conformance.receipt.lifecycle).toMatchObject({
      qualification: 'qualified', identityMatched: true, processStatus: 'stopped', settlementStatus: 'settled',
    });
    expect(conformance.result.taskOutcomes[0]?.outcome.execution?.launched).toBe(true);
    const nativeObservation = conformance.result.observations.find(({ observation }) =>
      observation.identity.invocationId === conformance.receipt.identity.invocationId)?.observation;
    expect(nativeObservation).toBeDefined();
    const lifecycleArtifact = nativeObservation!.artifacts.find(({ kind }) => kind === 'native-lifecycle');
    expect(lifecycleArtifact).toBeDefined();
    expect(conformance.receipt.lifecycle.processEvidence).toEqual(lifecycleArtifact);
    expect(conformance.receipt.lifecycle.settlementEvidence).toEqual(lifecycleArtifact);
    const receiptFile = join(new ArtifactStore(env.artifactRoot).root, conformance.artifact.path);
    expect(readFileSync(receiptFile, 'utf8')).toContain('"qualification": "qualified"');
  }, 30_000);
});
