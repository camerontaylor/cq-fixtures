import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SessionStore, type Driver, type OpInvocation, type WorkerResult } from '@camerontaylor/cq-toolkit';
import { ArtifactStore, sha256, type ImmutableArtifactRef } from '../artifacts/index.ts';
import { canonicalJson, suiteTaskId, type ExperimentContext, type TaskOutcome } from '../experiment.ts';
import { SESSION_STORE_DIR, type RunSuiteResult } from '../index.ts';
import type { InvocationIdentity, LaunchEvidence, NativeObservation, ObservedDriver } from './observation.ts';

export interface WorkspaceInventory {
  /** Task files, symlink targets, and modes. The top-level .git entry is excluded. */
  contentSha256: string;
  contentEntryCount: number;
  /** The complete .git tree (or .git pointer file), hashed without invoking Git. */
  gitMetadataSha256: string;
  gitMetadataEntryCount: number;
}

export interface WorkspaceConformanceTestHooks {
  /** Test-only fault injection; production callers should omit this. */
  afterWorkerForTest?: (controlWorkspace: string, invocation: OpInvocation) => void | Promise<void>;
}

export interface WorkspaceConformanceRequest<Result extends RunSuiteResult = RunSuiteResult> {
  driver: Driver & ObservedDriver;
  experiment: ExperimentContext;
  suiteName: string;
  caseId: string;
  frozenJudgePin: string;
  /** Frozen task-tree inventory made from the trusted task bundle before dispatch. */
  frozenBaseline: {
    contentSha256: string;
    taskCommit: string | null;
    taskTree: string | null;
  };
  artifactRoot: string;
  /** The actual toolkit store is used by default. Injection is for focused failure tests. */
  sessionStore?: Pick<SessionStore, 'load'>;
  /** The callback must call the real runSuite with the supplied wrapped driver. */
  runSuite: (driver: Driver) => Promise<Result>;
  testHooks?: WorkspaceConformanceTestHooks;
}

export interface WorkspaceConformanceReceipt {
  schemaVersion: 1;
  status: 'passed' | 'failed';
  failureCodes: readonly string[];
  identity: {
    campaignId: string;
    cohortId: string;
    experimentId: string;
    taskId: string;
    substrateId: string;
    track: string;
    repeatId: string;
    assignmentId: string;
    stageId: string;
    attemptId: string;
    invocationId: string | null;
    sessionRefSha256: string | null;
  };
  task: { suiteName: string; caseId: string; role: 'fixer-worker' };
  baseline: {
    taskCommit: string | null;
    taskTree: string | null;
    contentSha256: string;
    runSuiteCommit: string | null;
    runSuiteTree: string | null;
  };
  workspaces: {
    assigned: {
      identitySha256: string | null;
      before: WorkspaceInventory | null;
      afterWorker: WorkspaceInventory | null;
      removedByRunSuite: boolean;
    };
    control: {
      identitySha256: string | null;
      before: WorkspaceInventory | null;
      afterWorker: WorkspaceInventory | null;
      afterRunSuite: WorkspaceInventory | null;
      unchanged: boolean;
      removedByConformance: boolean;
    };
  };
  candidate: { sha256: string | null; artifact: ImmutableArtifactRef | null };
  selectedJudgement: {
    judgementId: string;
    version: number;
    judgePin: string;
    candidateSha256: string;
    artifact: ImmutableArtifactRef;
  } | null;
  judgedOutcome: {
    candidateCorrectness: boolean | null;
    formatConformance: boolean | null;
    assignedStrategySuccess: boolean | null;
    operationalStatus: TaskOutcome['operationalStatus'] | null;
  };
  outcomeArtifact: ImmutableArtifactRef | null;
  observationArtifact: ImmutableArtifactRef | null;
  stageArtifacts: TaskOutcome['stages'][number]['artifacts'];
  runSuiteFailed: boolean;
}

export interface WorkspaceConformanceResult<Result extends RunSuiteResult = RunSuiteResult> {
  result: Result;
  receipt: WorkspaceConformanceReceipt;
  artifact: ImmutableArtifactRef;
}

export class WorkspaceConformanceError extends Error {
  constructor(readonly receipt: WorkspaceConformanceReceipt, readonly artifact: ImmutableArtifactRef | null) {
    super(`workspace conformance failed: ${receipt.failureCodes.join(', ') || 'unknown'}`);
    this.name = 'WorkspaceConformanceError';
  }
}

interface InventoryEntry { path: string; kind: 'directory' | 'file' | 'symlink' | 'other'; mode: number; sha256: string | null; }

/** Stable content and complete .git inventories. It never invokes Git or follows symlinks. */
export function inventoryTaskWorkspace(workspacePath: string): WorkspaceInventory {
  const root = realpathSync(workspacePath);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('workspace inventory root must be a real directory');
  const content: InventoryEntry[] = [];
  const git: InventoryEntry[] = [];
  const visitDirectory = (absolute: string, prefix: string, target: InventoryEntry[]): void => {
    for (const name of readdirSync(absolute).sort()) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      addEntry(join(absolute, name), path, target);
    }
  };
  function addEntry(fullPath: string, path: string, target: InventoryEntry[]): void {
    const stat = lstatSync(fullPath);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) target.push({ path, kind: 'symlink', mode, sha256: sha256(readlinkSync(fullPath)) });
    else if (stat.isDirectory()) {
      target.push({ path, kind: 'directory', mode, sha256: null });
      visitDirectory(fullPath, path, target);
    } else if (stat.isFile()) target.push({ path, kind: 'file', mode, sha256: sha256(readFileSync(fullPath)) });
    else target.push({ path, kind: 'other', mode, sha256: null });
  }
  for (const name of readdirSync(root).sort()) {
    const fullPath = join(root, name);
    if (name === '.git') addEntry(fullPath, name, git);
    else addEntry(fullPath, name, content);
  }
  return {
    contentSha256: sha256(canonicalJson(content)),
    contentEntryCount: content.length,
    gitMetadataSha256: sha256(canonicalJson(git)),
    gitMetadataEntryCount: git.length,
  };
}

/**
 * Wrap a future native visible-G1 run with an isolated, same-baseline control.
 * The driver sees only runSuite's sessionRef-bound assigned workspace.
 */
export async function runWorkspaceConformance<Result extends RunSuiteResult = RunSuiteResult>(
  request: WorkspaceConformanceRequest<Result>,
): Promise<WorkspaceConformanceResult<Result>> {
  if (request.driver.getObservation === undefined) throw new Error('workspace conformance requires an observed native driver');
  if (!/^[a-f0-9]{64}$/.test(request.frozenJudgePin) || !/^[a-f0-9]{64}$/.test(request.frozenBaseline.contentSha256)) {
    throw new Error('workspace conformance requires frozen SHA256 judge and task inventory pins');
  }

  const store = request.sessionStore ?? new SessionStore(SESSION_STORE_DIR);
  const frozen = request.experiment;
  const expectedTaskId = suiteTaskId(request.suiteName, frozen.substrateId);
  const failureCodes: string[] = [];
  const state: {
    identity?: InvocationIdentity; sessionRef?: string; workspace?: string; controlRoot?: string; controlWorkspace?: string;
    assignedBefore?: WorkspaceInventory; controlBefore?: WorkspaceInventory; assignedAfterWorker?: WorkspaceInventory;
    controlAfterWorker?: WorkspaceInventory; controlAfterRun?: WorkspaceInventory; suiteFailed: boolean;
  } = { suiteFailed: false };
  let result: Result | undefined;
  let suiteError: unknown;

  const observedDriver = request.driver;
  const wrapper: Driver & ObservedDriver = {
    campaignBudgetCapabilities: observedDriver.campaignBudgetCapabilities,
    async beginInvocation(identity) {
      if (identity.assignmentId !== frozen.assignmentId || identity.stageId !== frozen.stageId || identity.attemptId !== frozen.attemptId) {
        failureCodes.push('frozen-invocation-identity-mismatch');
        throw new Error('workspace conformance invocation identity differs from frozen assignment');
      }
      state.identity = { ...identity };
      if (typeof observedDriver.beginInvocation === 'function') await observedDriver.beginInvocation(identity);
      else if (typeof observedDriver.setInvocationIdentity === 'function') await observedDriver.setInvocationIdentity(identity);
      else throw new Error('observed driver has no invocation identity setter');
    },
    async run(invocation: OpInvocation): Promise<WorkerResult> {
      if (invocation.sessionRef === undefined || invocation.sessionRef === '') {
        failureCodes.push('missing-session-ref');
        throw new Error('workspace conformance requires the runSuite sessionRef');
      }
      if (state.identity === undefined) {
        failureCodes.push('missing-invocation-identity');
        throw new Error('workspace conformance invocation identity was not set');
      }
      state.sessionRef = invocation.sessionRef;
      let record;
      try { record = await store.load(invocation.sessionRef); }
      catch { failureCodes.push('session-resolution-failed'); throw new Error('workspace conformance session lookup failed'); }
      if (record === undefined || record.sessionId !== invocation.sessionRef || !isAbsolute(record.workspace)) {
        failureCodes.push('session-not-found-or-invalid');
        throw new Error('workspace conformance sessionRef did not resolve to an absolute workspace');
      }
      let assignedRoot: string;
      try { assignedRoot = realpathSync(record.workspace); }
      catch { failureCodes.push('assigned-workspace-unavailable'); throw new Error('workspace conformance assigned workspace is unavailable'); }
      const assignedStat = lstatSync(record.workspace);
      if (!assignedStat.isDirectory() || assignedStat.isSymbolicLink()) {
        failureCodes.push('assigned-workspace-not-directory');
        throw new Error('workspace conformance assigned workspace is not a real directory');
      }
      state.workspace = assignedRoot;
      state.assignedBefore = inventoryTaskWorkspace(assignedRoot);
      if (state.assignedBefore.contentSha256 !== request.frozenBaseline.contentSha256) {
        failureCodes.push('assigned-workspace-does-not-match-frozen-task');
        throw new Error('workspace conformance sessionRef workspace does not match the frozen task tree');
      }

      state.controlRoot = mkdtempSync(join(tmpdir(), 'cq-g1-control-'));
      state.controlWorkspace = join(state.controlRoot, 'control');
      cpSync(assignedRoot, state.controlWorkspace, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      const controlRoot = realpathSync(state.controlWorkspace);
      if (controlRoot === assignedRoot) {
        failureCodes.push('control-workspace-not-distinct');
        throw new Error('workspace conformance control workspace is not distinct');
      }
      state.controlWorkspace = controlRoot;
      state.controlBefore = inventoryTaskWorkspace(controlRoot);
      if (canonicalJson(state.assignedBefore) !== canonicalJson(state.controlBefore)) {
        failureCodes.push('control-baseline-copy-mismatch');
        throw new Error('workspace conformance control does not match the assigned baseline');
      }
      if (invocation.prompt.includes(controlRoot)) {
        failureCodes.push('control-workspace-leaked-to-invocation');
        throw new Error('workspace conformance control path appeared in invocation prompt');
      }
      try {
        const worker = await observedDriver.run(invocation);
        return worker;
      } finally {
        try { state.assignedAfterWorker = inventoryTaskWorkspace(assignedRoot); }
        catch { failureCodes.push('assigned-post-run-inventory-failed'); }
        try {
          if (request.testHooks?.afterWorkerForTest !== undefined) await request.testHooks.afterWorkerForTest(controlRoot, invocation);
          state.controlAfterWorker = inventoryTaskWorkspace(controlRoot);
          if (canonicalJson(state.controlBefore) !== canonicalJson(state.controlAfterWorker)) failureCodes.push('control-workspace-mutated');
        } catch {
          failureCodes.push('control-post-run-inventory-or-hook-failed');
        }
      }
    },
    async getObservation(invocationId) {
      return await observedDriver.getObservation(invocationId);
    },
    ...(observedDriver.getLaunchEvidence === undefined ? {} : {
      async getLaunchEvidence(invocationId: string): Promise<LaunchEvidence | undefined> {
        return await observedDriver.getLaunchEvidence!(invocationId);
      },
    }),
  };

  try { result = await request.runSuite(wrapper); }
  catch (error) { suiteError = error; state.suiteFailed = true; failureCodes.push('runSuite-threw'); }
  finally {
    try {
      if (state.controlWorkspace !== undefined && existsSync(state.controlWorkspace)) state.controlAfterRun = inventoryTaskWorkspace(state.controlWorkspace);
    } catch { failureCodes.push('control-final-inventory-failed'); }
  }

  const suiteOutcome = result?.taskOutcomes.filter(({ outcome }) =>
    outcome.identity.assignmentId === frozen.assignmentId && outcome.identity.substrateId === frozen.substrateId,
  ) ?? [];
  if (suiteOutcome.length !== 1) failureCodes.push('task-outcome-not-unique');
  const joined = suiteOutcome[0];
  const outcome = joined?.outcome;
  if (outcome !== undefined) {
    const id = outcome.identity;
    if (id.campaignId !== frozen.campaignId || id.cohortId !== frozen.cohortId || id.experimentId !== frozen.experimentId ||
      id.taskId !== expectedTaskId || id.substrateId !== frozen.substrateId || id.track !== frozen.track ||
      id.repeatId !== frozen.repeatId || id.assignmentId !== frozen.assignmentId || id.strategyId !== frozen.strategyId ||
      id.budgetId !== frozen.budgetId || id.frozenWeight !== frozen.frozenWeight || id.role !== 'fixer-worker') {
      failureCodes.push('task-outcome-identity-mismatch');
    }
  }
  const stage = outcome?.stages.length === 1 ? outcome.stages[0] : undefined;
  if (stage === undefined || state.identity === undefined || stage.invocationId !== state.identity.invocationId ||
    stage.stageId !== frozen.stageId || stage.attemptId !== frozen.attemptId) failureCodes.push('stage-attempt-identity-mismatch');
  const joinedRows = result?.rows.filter((row) => row.case === request.caseId && row.suite === request.suiteName &&
    row.experiment?.assignmentId === frozen.assignmentId && row.experiment.stageId === frozen.stageId &&
    row.experiment.attemptId === frozen.attemptId) ?? [];
  if (joinedRows.length !== 1) failureCodes.push('runSuite-row-not-unique');
  const observation = result?.observations.find((item) => item.observation.identity.invocationId === state.identity?.invocationId);
  const nativeObservation: NativeObservation | undefined = observation?.observation;
  const candidateArtifact = stage?.artifacts.find((artifact) => artifact.kind === 'candidate-patch');
  const judgements = outcome?.judgements.filter((judgement) => judgement.judgePin === request.frozenJudgePin) ?? [];
  const selectedJudgement = judgements.length === 1 ? judgements[0] : undefined;
  if (selectedJudgement === undefined) failureCodes.push('frozen-judgement-not-unique');
  if (stage?.observation === undefined || observation === undefined || stage.observation.sha256 !== observation.artifact.sha256) {
    failureCodes.push('observation-reference-mismatch');
  }
  if (candidateArtifact === undefined || selectedJudgement?.candidateSha256 !== candidateArtifact.sha256 ||
    nativeObservation?.capture.patchSha256 !== candidateArtifact.sha256) failureCodes.push('candidate-capture-join-mismatch');
  if (nativeObservation?.capture.baselineTree !== request.frozenBaseline.taskTree && request.frozenBaseline.taskTree !== null) {
    failureCodes.push('runSuite-baseline-tree-mismatch');
  }
  if (nativeObservation?.capture.baselineCommit === null || nativeObservation?.capture.baselineCommit === undefined) {
    failureCodes.push('runSuite-baseline-commit-missing');
  }
  const assignedIdentitySha256 = state.workspace === undefined ? null : sha256(state.workspace);
  const controlIdentitySha256 = state.controlWorkspace === undefined ? null : sha256(state.controlWorkspace);
  if (assignedIdentitySha256 !== null && assignedIdentitySha256 === controlIdentitySha256) failureCodes.push('workspace-identities-not-distinct');
  const controlSame = state.controlBefore !== undefined && state.controlAfterWorker !== undefined && state.controlAfterRun !== undefined &&
    canonicalJson(state.controlBefore) === canonicalJson(state.controlAfterWorker) && canonicalJson(state.controlBefore) === canonicalJson(state.controlAfterRun);
  if (!controlSame) failureCodes.push('control-workspace-not-unchanged');

  let controlRemoved = false;
  try {
    if (state.controlRoot !== undefined) rmSync(state.controlRoot, { recursive: true, force: false });
    controlRemoved = state.controlRoot === undefined || !existsSync(state.controlRoot);
  } catch { failureCodes.push('control-cleanup-failed'); }
  if (!controlRemoved) failureCodes.push('control-cleanup-incomplete');
  const assignedRemoved = state.workspace === undefined || !existsSync(state.workspace);
  if (!assignedRemoved) failureCodes.push('assigned-workspace-cleanup-incomplete');
  if (state.sessionRef !== undefined) {
    try { if (await store.load(state.sessionRef) !== undefined) failureCodes.push('session-record-cleanup-incomplete'); }
    catch { failureCodes.push('session-cleanup-verification-failed'); }
  }
  if (suiteError !== undefined) failureCodes.push('runSuite-failed');

  const receipt: WorkspaceConformanceReceipt = {
    schemaVersion: 1,
    status: failureCodes.length === 0 ? 'passed' : 'failed',
    failureCodes: [...new Set(failureCodes)],
    identity: {
      campaignId: frozen.campaignId, cohortId: frozen.cohortId, experimentId: frozen.experimentId,
      taskId: outcome?.identity.taskId ?? expectedTaskId, substrateId: frozen.substrateId,
      track: frozen.track, repeatId: frozen.repeatId, assignmentId: frozen.assignmentId,
      stageId: frozen.stageId, attemptId: frozen.attemptId,
      invocationId: state.identity?.invocationId ?? null,
      sessionRefSha256: state.sessionRef === undefined ? null : sha256(state.sessionRef),
    },
    task: { suiteName: request.suiteName, caseId: request.caseId, role: 'fixer-worker' },
    baseline: {
      taskCommit: request.frozenBaseline.taskCommit, taskTree: request.frozenBaseline.taskTree,
      contentSha256: request.frozenBaseline.contentSha256,
      runSuiteCommit: nativeObservation?.capture.baselineCommit ?? null,
      runSuiteTree: nativeObservation?.capture.baselineTree ?? null,
    },
    workspaces: {
      assigned: {
        identitySha256: assignedIdentitySha256, before: state.assignedBefore ?? null,
        afterWorker: state.assignedAfterWorker ?? null, removedByRunSuite: assignedRemoved,
      },
      control: {
        identitySha256: controlIdentitySha256, before: state.controlBefore ?? null,
        afterWorker: state.controlAfterWorker ?? null, afterRunSuite: state.controlAfterRun ?? null,
        unchanged: controlSame, removedByConformance: controlRemoved,
      },
    },
    candidate: { sha256: candidateArtifact?.sha256 ?? null, artifact: candidateArtifact === undefined ? null : { path: candidateArtifact.path, sha256: candidateArtifact.sha256 } },
    selectedJudgement: selectedJudgement === undefined ? null : {
      judgementId: selectedJudgement.judgementId, version: selectedJudgement.version,
      judgePin: selectedJudgement.judgePin, candidateSha256: selectedJudgement.candidateSha256,
      artifact: { ...selectedJudgement.artifact },
    },
    judgedOutcome: outcome === undefined ? {
      candidateCorrectness: null, formatConformance: null, assignedStrategySuccess: null, operationalStatus: null,
    } : {
      candidateCorrectness: outcome.candidateCorrectness,
      formatConformance: outcome.formatConformance,
      assignedStrategySuccess: outcome.assignedStrategySuccess,
      operationalStatus: outcome.operationalStatus,
    },
    outcomeArtifact: joined?.artifact ?? null,
    observationArtifact: observation?.artifact ?? null,
    stageArtifacts: stage?.artifacts ?? [],
    runSuiteFailed: state.suiteFailed,
  };
  let receiptArtifact: ImmutableArtifactRef | null = null;
  try {
    const context: ExperimentContext = { ...frozen, taskId: expectedTaskId };
    receiptArtifact = new ArtifactStore(request.artifactRoot).write(context, 'workspace-conformance.json', `${JSON.stringify(receipt, null, 2)}\n`);
  } catch {
    throw new WorkspaceConformanceError({ ...receipt, status: 'failed', failureCodes: [...receipt.failureCodes, 'receipt-finalization-failed'] }, null);
  }
  if (receipt.status !== 'passed' || result === undefined) throw new WorkspaceConformanceError(receipt, receiptArtifact);
  return { result, receipt, artifact: receiptArtifact };
}
