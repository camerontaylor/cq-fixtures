/** Child entrypoint. It accepts JSON data only; no executable code crosses IPC. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Driver, OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import type { FrozenReviewLoopTask, ReviewLoopJudgeProcessPayload, ReviewLoopJudgeProcessRequest, ReviewLoopJudgeProcessResult } from './judge-protocol.ts';

const TASK_SOURCE = 'campaigns/cq-settings/corpus/review-loop-task.ts';
const SUITE_SOURCE = 'runner/workflow-corpus/review-loop-suite.ts';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
type MaterializedJudgeRequest = ReviewLoopJudgeProcessRequest & { readonly processRoot: string; readonly artifactRoot: string };
interface JudgeOwnershipBindings {
  stableJudgeCandidateInventory(module: string, bytes: Uint8Array): { inventoryHash: string };
}

const OWNERSHIP_CLOSURE = 'runner/boundary/evidence/fallback/judge-ownership-source-closure.public.json';
const OWNERSHIP_MODULE = 'runner/boundary/judge-ownership.ts';
const OWNERSHIP_CLOSURE_ASSETS = [
  'runner/boundary/broker-toolchain.ts', 'runner/boundary/codex-final-profile.ts',
  'runner/boundary/container-prepare.ts', 'runner/boundary/container.ts', 'runner/boundary/docker-control.ts',
  'runner/boundary/egress-broker.ts', 'runner/boundary/judge-child.ts', OWNERSHIP_MODULE,
  'runner/boundary/lifecycle-evidence.ts', 'runner/boundary/namespace-acl.sh',
  'runner/boundary/subscription-auth.ts', 'runner/boundary/task-session.ts',
  'runner/boundary/task-staging.ts', 'runner/boundary/task-tree.ts', 'runner/boundary/volume-io.mjs',
] as const;

interface ChildTask {
  id: string;
  sourceId: string;
  baselineId: string;
  oracleId: string;
  substrateFamily: string;
  worktreePath: string;
  baselineCommit: string;
  modelSpec: { model: string; provider: string };
  operationInput: Record<string, unknown>;
  cleanup(): Promise<void>;
}
interface ChildBundle {
  suiteDir: string;
  repoRoot: string;
  suite: { name: string; cases: { id: string; task: { prompt: string } }[] };
  oraclePin: { sha256: string; dependencies: readonly { path: string; sha256: string }[] };
  wrapDriver<T extends Driver>(driver: T): T;
  hostCheckScoringEnvironment(workspace: string, baseline: string): Readonly<Record<string, string>>;
  pinnedBaselineCommit(workspace: string): string | undefined;
  cleanup(): Promise<void>;
}
interface ChildS1 {
  createReviewLoopRunSuiteBundle(task: ChildTask, root: string): Promise<ChildBundle>;
  runSuite(input: Record<string, unknown>): Promise<{
    rows: ReviewLoopJudgeProcessPayload['rows']; tables: unknown[]; diagnostics?: string[];
    absences?: readonly unknown[]; materializationDiagnostics?: readonly string[];
    observations?: readonly { observation: { capture?: unknown } }[];
  }>;
  suiteTaskId(suite: string, task: string): string;
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeDirectory(rootPath: string, targetPath = rootPath): void {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('judge child directory escaped its private root');
  const components = rel === '' ? [] : rel.split(sep);
  let current = root;
  for (const component of [current, ...components.map((part) => { current = join(current, part); return current; })]) {
    if (!existsSync(component)) mkdirSync(component, { mode: 0o700 });
    const stat = lstatSync(component);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`judge child path is not a real directory: ${component}`);
  }
}

function underRoot(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validateRequest(value: unknown): asserts value is MaterializedJudgeRequest {
  if (!value || typeof value !== 'object') throw new Error('judge child request must be an object');
  const request = value as ReviewLoopJudgeProcessRequest;
  if (request.schemaVersion !== 1 || !request.identity?.assignmentId || !request.identity.stageId || !request.identity.attemptId) {
    throw new Error('judge child request has invalid protocol or stage identity');
  }
  for (const pin of [request.taskSourceSha256, request.suiteSourceSha256,
    request.oraclePin, request.promptSha256, request.candidate?.sha256]) {
    if (!/^[a-f0-9]{64}$/i.test(pin ?? '')) throw new Error('judge child request has a malformed content pin');
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(request.baselineTree ?? '')) {
    throw new Error('judge child baseline tree pin is malformed');
  }
  const expectedFixtureFiles = ['package.json', 'settings/module.js', 'settings/display.js', 'test/public-settings.test.mjs'];
  if (!Array.isArray(request.taskFixtureFiles) || request.taskFixtureFiles.length !== expectedFixtureFiles.length
    || request.taskFixtureFiles.some((file, index) => file.path !== expectedFixtureFiles[index]
      || !/^[a-f0-9]{64}$/i.test(file.sha256))) throw new Error('judge child task fixture pins are invalid');
  if (!/^[a-f0-9]{40}$/i.test(request.baselineCommit) || request.candidate.baselineCommit !== request.baselineCommit
    || request.candidate.baselineTree !== request.baselineTree) throw new Error('judge child baseline identity mismatch');
  if (hash(request.candidate.patch) !== request.candidate.sha256) throw new Error('judge child candidate patch hash mismatch');
  if (!/^[a-f0-9]{64}$/i.test(request.candidateInventoryHash ?? '')
    || !/^[a-f0-9]{64}$/i.test(request.namespacePlanSha256 ?? '')
    || !Number.isInteger(request.namespaceSlotCount) || request.namespaceSlotCount < 1 || request.namespaceSlotCount > 8) {
    throw new Error('judge child request omits its frozen S5 namespace inventory');
  }
  if (request.experiment.assignmentId !== request.identity.assignmentId
    || request.experiment.stageId !== request.identity.stageId || request.experiment.attemptId !== request.identity.attemptId
    || request.experiment.judgeManifest.sourcePin !== request.oraclePin
    || JSON.stringify(request.experiment.judgeManifest) !== JSON.stringify(request.judgeManifest)) {
    throw new Error('judge child context identity or pin mismatch');
  }
  if (!Number.isFinite(request.deadlineEpochMs) || !Number.isFinite(request.checkTimeoutMs) || request.checkTimeoutMs <= 0) {
    throw new Error('judge child deadline is invalid');
  }
  if (typeof request.processRoot !== 'string' || !isAbsolute(request.processRoot)
    || typeof request.artifactRoot !== 'string' || !isAbsolute(request.artifactRoot)) throw new Error('judge child private roots are missing');
  const root = resolve(request.processRoot);
  if (!underRoot(root, request.artifactRoot)) throw new Error('judge child artifact path escaped its private root');
  if (!isAbsolute(request.s1DependencyRoot)) throw new Error('judge child S1 root must be absolute and explicit');
}

async function loadS1(root: string): Promise<ChildS1> {
  const at = (file: string): string => pathToFileURL(join(root, file)).href;
  const [corpus, runner, experiment, suite] = await Promise.all([
    import(at(TASK_SOURCE)), import(at('runner/index.ts')), import(at('runner/experiment.ts')), import(at(SUITE_SOURCE)),
  ]);
  return { ...corpus, ...runner, ...experiment, ...suite } as unknown as ChildS1;
}

async function loadPinnedOwnership(root: string, dependencies: readonly { path: string; sha256: string }[]): Promise<JudgeOwnershipBindings> {
  const dependencyHashes = new Map(dependencies.map((entry) => [entry.path, entry.sha256]));
  if (dependencyHashes.size !== dependencies.length) throw new Error('protected-judge dependency manifest contains duplicate paths');
  const closurePath = join(root, OWNERSHIP_CLOSURE);
  const closureStat = lstatSync(closurePath);
  if (!closureStat.isFile() || closureStat.isSymbolicLink()) throw new Error('protected-judge source closure is not a regular file');
  const closureBytes = readFileSync(closurePath);
  const closurePin = dependencyHashes.get(OWNERSHIP_CLOSURE);
  if (!closurePin || hash(closureBytes) !== closurePin) throw new Error('pinned protected-judge source closure is missing or changed');
  const closure = JSON.parse(closureBytes.toString('utf8')) as { schemaVersion?: number; assets?: Record<string, string> };
  if (closure.schemaVersion !== 1 || !closure.assets || Object.keys(closure.assets).length !== OWNERSHIP_CLOSURE_ASSETS.length) {
    throw new Error('pinned protected-judge source closure is malformed');
  }
  if (JSON.stringify((closure as { entrypoints?: unknown }).entrypoints)
    !== JSON.stringify(['runner/boundary/judge-ownership.ts', 'runner/boundary/judge-child.ts'])) {
    throw new Error('pinned protected-judge source closure entrypoints are malformed');
  }
  for (const path of OWNERSHIP_CLOSURE_ASSETS) {
    const expected = closure.assets[path];
    const assetPath = join(root, path);
    const stat = lstatSync(assetPath);
    if (!expected || dependencyHashes.get(path) !== expected || !stat.isFile() || stat.isSymbolicLink()
      || hash(readFileSync(assetPath)) !== expected) {
      throw new Error(`protected-judge source closure pin mismatch: ${path}`);
    }
  }
  return await import(pathToFileURL(join(root, OWNERSHIP_MODULE)).href) as JudgeOwnershipBindings;
}

function validateNamespace(request: MaterializedJudgeRequest): void {
  const planPath = process.env.CQ_PROTECTED_JUDGE_PLAN;
  if (!planPath || !isAbsolute(planPath) || !underRoot(request.processRoot, planPath)) throw new Error('protected-judge plan environment is missing or escaped');
  const stat = lstatSync(planPath);
  if (!stat.isFile() || stat.isSymbolicLink() || hash(readFileSync(planPath)) !== request.namespacePlanSha256) {
    throw new Error('protected-judge plan bytes do not match the frozen request');
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
    schemaVersion?: number; identity?: { assignmentId?: string; stageId?: string; attemptId?: string };
    candidateSha256?: string; oraclePin?: string; slots?: readonly { inventoryHash?: string }[];
  };
  if (plan.schemaVersion !== 1 || plan.identity?.assignmentId !== request.identity.assignmentId
    || plan.identity?.stageId !== request.identity.stageId || plan.identity?.attemptId !== request.identity.attemptId
    || plan.candidateSha256 !== request.candidate.sha256 || plan.oraclePin !== request.oraclePin
    || plan.slots?.length !== request.namespaceSlotCount
    || plan.slots.some((slot) => slot.inventoryHash !== request.candidateInventoryHash)) {
    throw new Error('protected-judge plan identity or candidate inventory mismatch');
  }
}

function workspaceFromPrompt(prompt: string): string {
  const value = prompt.match(/^workspace: (.+)$/m)?.[1];
  if (!value) throw new Error('S1 runSuite invocation omitted its workspace path');
  return resolve(value);
}

function git(cwd: string, args: string[]): string {
  const { execFileSync } = requireChildProcess();
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function requireChildProcess(): typeof import('node:child_process') {
  // Kept as a local static dependency so task materialization remains pinned to Node's Git invocation.
  return childProcess;
}

import * as childProcess from 'node:child_process';

async function execute(request: MaterializedJudgeRequest, requestSha256: string): Promise<ReviewLoopJudgeProcessPayload> {
  const source = (relativePath: string): string => readFileSync(join(request.s1DependencyRoot, relativePath), 'utf8');
  if (hash(source(TASK_SOURCE)) !== request.taskSourceSha256 || hash(source(SUITE_SOURCE)) !== request.suiteSourceSha256) {
    throw new Error('judge child S1 task or suite source pin changed');
  }
  safeDirectory(request.processRoot);
  safeDirectory(request.processRoot, request.artifactRoot);
  validateNamespace(request);
  const ownership = await loadPinnedOwnership(request.s1DependencyRoot, request.judgeManifest.dependencies);
  const s1 = await loadS1(request.s1DependencyRoot);
  const dataRoot = join(request.processRoot, 's1-runtime');
  safeDirectory(dataRoot);
  const task: ChildTask = { ...(request.task as FrozenReviewLoopTask), cleanup: async () => {} };
  if (task.modelSpec.model !== request.model || task.modelSpec.provider !== request.provider
    || task.baselineCommit !== request.baselineCommit
    || git(task.worktreePath, ['rev-parse', 'HEAD']) !== request.baselineCommit
    || git(task.worktreePath, ['rev-parse', 'HEAD^{tree}']) !== request.baselineTree) {
    throw new Error('parent-prepared task no longer matches its frozen model or baseline pins');
  }
  let bundle: ChildBundle | undefined;
  try {
    bundle = await s1.createReviewLoopRunSuiteBundle(task, dataRoot);
    const baselineTree = git(task.worktreePath, ['rev-parse', `${task.baselineCommit}^{tree}`]);
    const prompt = bundle.suite.cases[0]?.task.prompt;
    if (task.baselineCommit !== request.baselineCommit || baselineTree !== request.baselineTree
      || hash(prompt ?? '') !== request.promptSha256 || task.sourceId !== request.sourceId
      || task.baselineId !== request.baselineId || bundle.suite.name !== request.suiteName
      || bundle.suite.cases[0]?.id !== request.caseId || bundle.oraclePin.sha256 !== request.oraclePin
      || JSON.stringify(bundle.oraclePin.dependencies) !== JSON.stringify(request.judgeManifest.dependencies)) {
      throw new Error('child materialized a task, baseline, suite, prompt, or judge pin that differs from the frozen request');
    }
    for (const dependency of request.judgeManifest.dependencies) {
      const sourcePath = join(request.s1DependencyRoot, dependency.path);
      const content = readFileSync(sourcePath);
      if (hash(content) !== dependency.sha256) throw new Error(`review-loop judge dependency changed: ${dependency.path}`);
      const targetPath = join(bundle.repoRoot, dependency.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content, { flag: 'wx', mode: 0o600 });
    }

    const injectedDriver: Driver = {
      async run(invocation: OpInvocation): Promise<WorkerResult> {
        if (Date.now() >= request.deadlineEpochMs) throw new Error('independent judge decision deadline elapsed');
        const workspace = workspaceFromPrompt(invocation.prompt);
        if (!underRoot(request.processRoot, workspace)) throw new Error('S1 selected a workspace outside the private judge process root');
        const suiteBaselineCommit = bundle!.pinnedBaselineCommit(workspace);
        if (!suiteBaselineCommit || git(workspace, ['rev-parse', 'HEAD']) !== suiteBaselineCommit) {
          throw new Error('S1 host judge workspace is not at its frozen suite baseline');
        }
        for (const fixture of request.taskFixtureFiles) {
          const fixturePath = join(workspace, fixture.path);
          const info = lstatSync(fixturePath);
          if (!info.isFile() || info.isSymbolicLink() || hash(readFileSync(fixturePath)) !== fixture.sha256) {
            throw new Error(`S1 host judge fixture differs from the frozen task baseline: ${fixture.path}`);
          }
        }
        const { execFileSync } = childProcess;
        execFileSync('git', ['apply', '--binary', '--whitespace=nowarn', '-'], {
          cwd: workspace, input: request.candidate.patch, stdio: ['pipe', 'ignore', 'pipe'],
        });
        const candidateModule = join(workspace, 'settings/module.js');
        const moduleStat = lstatSync(candidateModule);
        if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) throw new Error('protected judge candidate module is not a regular file');
        const inventory = ownership.stableJudgeCandidateInventory('settings/module.js', readFileSync(candidateModule));
        if (inventory.inventoryHash !== request.candidateInventoryHash) throw new Error('protected judge candidate module inventory changed');
        return {
          structuredOutput: { fixed: true, notes: 'Apply frozen candidate patch for local host judgement.' },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'complete', model: request.model,
        };
      },
    };

    const result = await s1.runSuite({
      suiteDir: bundle.suiteDir,
      repoRoot: bundle.repoRoot,
      artifactRoot: request.artifactRoot,
      driver: bundle.wrapDriver(injectedDriver),
      model: request.model,
      provider: request.provider,
      driverName: request.driverName,
      checkTimeoutMs: Math.min(request.checkTimeoutMs, Math.max(1, request.deadlineEpochMs - Date.now())),
      hostCheckScoringEnvironment: (workspace: string, baseline: string) => bundle!.hostCheckScoringEnvironment(workspace, baseline),
      experiment: request.experiment,
    });
  const row = result.rows.find((entry) => entry.case === request.caseId);
  const outcome = row?.taskOutcome;
    if (!outcome) throw new Error(`S1 runSuite produced no TaskOutcome for the frozen case: ${JSON.stringify({
      rows: result.rows.map((entry) => ({ case: entry.case, outcomes: entry.outcomes })),
      diagnostics: result.diagnostics, absences: result.absences, materializationDiagnostics: result.materializationDiagnostics,
      observations: result.observations?.map(({ observation }) => observation.capture),
    })}`);
    const matching = outcome.judgements.filter((entry) => entry.candidateSha256 === request.candidate.sha256
      && entry.judgePin === request.oraclePin);
    if (matching.length !== 1) throw new Error(`S1 runSuite produced ${matching.length} exact frozen candidate/judge matches`);
    const selected = matching[0]!;
    return {
      schemaVersion: 1,
      identity: request.identity,
      requestSha256,
      rows: result.rows,
      tables: result.tables,
      diagnostics: result.diagnostics ?? [],
      selection: { judgementId: selected.judgementId, version: selected.version,
        judgePin: selected.judgePin, candidateSha256: selected.candidateSha256 },
    };
  } finally {
    await bundle?.cleanup();
  }
}

async function main(args: readonly string[]): Promise<void> {
  const [requestPathArg, resultPathArg, expectedRequestHash] = args;
  if (!requestPathArg || !resultPathArg || !/^[a-f0-9]{64}$/.test(expectedRequestHash ?? '')) throw new Error('usage: judge-child <request> <result> <request-sha256>');
  const requestPath = resolve(requestPathArg);
  const resultPath = resolve(resultPathArg);
  const requestBytes = readFileSync(requestPath);
  if (requestBytes.byteLength > MAX_REQUEST_BYTES || hash(requestBytes) !== expectedRequestHash) throw new Error('judge child request hash/size validation failed');
  const request = JSON.parse(requestBytes.toString('utf8')) as unknown;
  validateRequest(request);
  if (!underRoot(request.processRoot, requestPath) || !underRoot(request.processRoot, resultPath)) throw new Error('judge child IPC path escaped its private process root');
  const payload = await execute(request, expectedRequestHash);
  const canonicalPayload = Buffer.from(JSON.stringify(payload));
  if (canonicalPayload.byteLength > MAX_RESULT_BYTES) throw new Error('judge child result exceeded its bounded size');
  const result: ReviewLoopJudgeProcessResult = {
    schemaVersion: 1, requestSha256: expectedRequestHash, payloadSha256: hash(canonicalPayload), payload,
  };
  const output = Buffer.from(`${JSON.stringify(result)}\n`);
  if (output.byteLength > MAX_RESULT_BYTES) throw new Error('judge child result envelope exceeded its bounded size');
  const tempPath = `${resultPath}.tmp-${process.pid}`;
  const fd = openSync(tempPath, 'wx', 0o600);
  try { writeFileSync(fd, output); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tempPath, resultPath);
  const directoryFd = openSync(dirname(resultPath), 'r');
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
