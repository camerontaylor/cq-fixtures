# CQ campaign runner contract

This fixtures-local contract is additive. The exported cq-toolkit `Driver`
interface stays unchanged; native bridges may implement `Driver` plus the
structural observation seam below. `OpInvocation` has no campaign metadata
carrier, so the runner does not cast extra properties onto it.

```ts
import type { Usage, WorkerResult } from '@camerontaylor/cq-toolkit';
import type {
  JudgeDependencyManifest, StageAttemptEvidenceRef, TaskAssignmentIdentity, TaskOutcome, TaskOutcomeJudgement,
} from './runner/experiment.ts';

interface NativeObservationDriver {
  campaignBudgetCapabilities?: { hardTokenCap: boolean; authoritativeTokenTotal: boolean };
  beginInvocation?(identity: InvocationIdentity): void | Promise<void>;
  setInvocationIdentity?(identity: InvocationIdentity): void | Promise<void>;
  getObservation(invocationId: string): Promise<NativeObservation | undefined>
    | NativeObservation | undefined;
}

interface InvocationIdentity {
  invocationId: string;
  assignmentId: string;
  stageId: string;
  attemptId: string;
}

interface UsageCounter {
  value: number | null;
  availability: 'observed' | 'unavailable' | 'not-reported';
  source: string | null;
  semantics: UsageCounterName;
}

type UsageCounterName = keyof Usage;

interface NativeObservation {
  schemaVersion: 1;
  identity: InvocationIdentity;
  transport: string;
  executable: { path: string; version: string | null; profile: string };
  artifacts: Array<{ kind: string; path: string; sha256: string }>;
  withheldArtifacts: Array<{ kind: string; reason: string; sha256: string | null }>;
  model: {
    configuredTarget: string;
    requested: { value: string | null; source: string; status: string };
    observed: { value: string | null; source: string | null; status: string };
    settings: Record<string, { value: unknown; source: string; status: string }>;
  };
  usage: {
    counters: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning', UsageCounter>;
    tokenTotal: { value: number | null; availability: string; source: string | null; semantics: 'authoritative-total' | 'unknown' };
    inclusion: { input: string | null; output: string | null; cache: string | null; reasoning: string | null };
  };
  terminal: {
    cause: string | null;
    cancelled: boolean;
    transportException: { name: string; message: string } | null;
    observedAt: string;
  };
  capture: { status: string; baselineCommit: string | null; baselineTree: string | null; patchSha256: string | null; workspaceSha256: string | null };
  timing: { startedAt: string; endedAt: string | null; stages: Record<string, number | null> };
  workerResult: WorkerResult | null;
}
```

`JudgeDependencyManifest`, `TaskOutcome`, `TaskAssignmentIdentity`, `TaskOutcomeJudgement`, and
`StageAttemptEvidenceRef` are the canonical exported join types in
`runner/experiment.ts`. One task assignment freezes campaign, cohort,
experiment, suite-plus-explicit-substrate task, track,
repeat, assignment, strategy, role, budget and analysis weight. Every stage and retry joins to that same frozen
identity; a retry keeps its stage ID and gets a new attempt ID. `stages[]`
retains every attempt's invocation, observation and artifact references.
`judgements[]` is append-only: each version pins an independent judge and the
exact candidate SHA-256. Regrading creates a new judgement ID/version and
never overwrites or implicitly selects a “best” attempt.

For one-case runs, `ExperimentContext.substrateId` and
`ExperimentContext.judgeManifest` identify the task. Multi-case runs require
each `caseAssignments[caseId]` entry to carry its own assignment, stage,
attempt, substrate ID and judge dependency manifest. The suite case label is
not used as a substrate identity. Each task supplies the independent judge's
source pin and dependency path/hash manifest; the runner verifies those files,
binds the manifest hash and immutable initial workspace tree into `judgePin`,
preserves the manifest and baseline commit/tree in the judgement artifact, and
passes the baseline commit to the check process as `CQ_BASELINE_REF`. This
always names the pristine commit captured before dispatch, never mutable
`HEAD`.

An invocation envelope is execution evidence, never task success by itself.
Candidate correctness and assigned-strategy success are separate nullable
outcomes, with operational status retained separately. Apply the approved
mapping mechanically: prelaunch failures retain assignment but do not count as
launched outcomes; a launched budget stop without a candidate is a failed
candidate and assigned-strategy outcome; a recoverable partial
candidate at budget stop is independently judged and follows that oracle;
transport failure after recoverable edits is independently judged while its
transport status remains visible; a transport failure without a candidate,
operator cancellation, or judge-host failure has null assigned success unless
the frozen analysis rule supplies a valid oracle result. A recoverable patch
after operator cancellation retains independently judged candidate correctness
and its oracle-derived assigned success, with `interrupted` operational status. Deterministic
judge assertion failure is measured failure. A final-format miss is tracked as
separate conformance evidence: identical patch correctness and assigned
strategy success remain identical regardless of format. The adapter consumes
`assignedStrategySuccess`, including its explicit nulls for interrupted or
unmeasurable assignments; it never estimates budget exhaustion from a zero
score. `TaskOutcome.execution` is optional for historical records and has the
exact shape `{ launched: boolean | null, terminalCause: 'complete' |
'budget-exhausted' | 'transport-error' | 'provider-cancelled' |
'operator-cancelled' | 'prelaunch-failure' | 'unknown', sourceInvocationIds:
readonly string[] }`. Missing execution, `launched: null`, or cause `unknown`
means the budget-exhaustion count is unknown. The runner emits
`budget-exhausted` only for an authoritative launched `WorkerResult` budget
stop; transport and operator evidence remain separately visible. A
prelaunch failure has `launched: false`. The current one-invocation run binds
the field to that invocation ID; a staged pipeline counts whole assignments
and retains each stage's cause separately. Integrity violations remain
separately flagged and disqualified under the approved table.

`runSuite` accepts an optional host-only
`hostCheckScoringEnvironment(workspacePath, pinnedBaselineCommit)` callback.
It merges the returned string environment into the check subprocess while
always supplying the runner's captured commit as `CQ_BASELINE_REF`. If the
provider returns `CQ_REVIEW_LOOP_ORACLE_PIN`, that SHA256 is the judgement pin
for the candidate; the corpus provider verifies its workspace and baseline
pins before returning `CQ_REVIEW_LOOP_BASELINE_SHA` and the oracle pin.

`UsageCounterName` is the fixtures-local union `'input' | 'output' |
'cacheRead' | 'cacheWrite' | 'reasoning'`, matching `Usage` keys. The runner
calls `beginInvocation(identity)` (preferred), or `setInvocationIdentity`,
immediately before `Driver.run()`. A native bridge must implement one of these
identity handoff methods and `getObservation(invocationId)`. The runner awaits
the handoff and dispatches one invocation at a time per Driver, so the ID used
for retrieval is unambiguous. Any future concurrent dispatch must use a
per-invocation token/handle instead of relying on serialized current identity.
Retrieval happens after both returned and thrown `run()` outcomes.

Missing counters use `null`; numeric compatibility values on `WorkerResult`
are projections only and never count as measurements. Every observed counter,
including `tokenTotal`, must be a finite nonnegative number. The runner does
not recompute `tokenTotal` by summing counters. The token total counts as authoritative only with `semantics: 'authoritative-total'`; otherwise it remains unknown and cannot enforce a hard cap. `inclusion` records source
semantics and overlap (including whether reasoning is already included in
output), so consumers must not double-count overlapping counters. The runner
may pass native counters into the toolkit governor or derive cost only when
input, output, cacheRead, and cacheWrite are all observed and the bridge sets
`inclusion.cache` to the exact value `disjoint-from-input`. Otherwise native
usage remains reportable but does not drive a folded governor total or modeled
cost. `tokenTotal` remains the bridge-reported authoritative total.
When `maxTokens` is a hard campaign cap, the native bridge must expose
`campaignBudgetCapabilities: { hardTokenCap: true, authoritativeTokenTotal: true }`.
The runner passes the remaining cap to each invocation and refuses later
assignments after missing authoritative totals; an unsupported native route
fails before dispatch instead of silently admitting an unbounded suite.

The runner persists the observation before scoring and before workspace cleanup.
The native bridge owns transport/process evidence and raw event artifacts; the
runner owns assignment/stage/attempt identity, patch capture, independent
judgement and campaign accounting. New campaign artifacts use create-if-absent
semantics with content hashes. Regrading references a candidate hash and judge
pin and writes a new judgement artifact.
