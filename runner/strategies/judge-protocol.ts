/** Serializable S4-to-child protocol for the pinned S1 review-loop host judge. */

export interface JudgeProcessIdentity {
  readonly assignmentId: string;
  readonly stageId: string;
  readonly attemptId: string;
}

export interface FrozenJudgeContext {
  readonly campaignId: string;
  readonly cohortId: string;
  readonly experimentId: string;
  readonly taskId: string;
  readonly repeatId: string;
  readonly assignmentId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly track: string;
  readonly strategyId: string;
  readonly settingsId: string;
  readonly budgetId: string;
  readonly profileId: string;
  readonly frozenWeight: number;
  readonly substrateId: string;
  readonly judgeManifest: {
    readonly sourcePin: string;
    readonly dependencies: readonly { readonly path: string; readonly sha256: string }[];
  };
}

export interface FrozenReviewLoopTask {
  readonly id: string;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly oracleId: string;
  readonly substrateFamily: string;
  readonly worktreePath: string;
  readonly baselineCommit: string;
  readonly modelSpec: { readonly model: string; readonly provider: string };
  readonly operationInput: Readonly<Record<string, unknown>>;
}

export interface ReviewLoopJudgeProcessRequest {
  readonly schemaVersion: 1;
  readonly identity: JudgeProcessIdentity;
  readonly deadlineEpochMs: number;
  readonly shutdownDeadlineEpochMs: number;
  readonly s1DependencyRoot: string;
  readonly task: FrozenReviewLoopTask;
  /** Added by the process supervisor; it is never accepted from the caller. */
  readonly processRoot?: string;
  /** Added by the process supervisor under processRoot. */
  readonly artifactRoot?: string;
  readonly model: string;
  readonly provider: string;
  readonly driverName: string;
  readonly checkTimeoutMs: number;
  readonly taskSourceSha256: string;
  readonly suiteSourceSha256: string;
  readonly baselineCommit: string;
  readonly baselineTree: string;
  readonly sourceId: string;
  readonly baselineId: string;
  readonly suiteName: string;
  readonly caseId: string;
  readonly promptSha256: string;
  /** Exact files copied from the frozen task baseline into S1's isolated fixer fixture. */
  readonly taskFixtureFiles: readonly { readonly path: string; readonly sha256: string }[];
  readonly oraclePin: string;
  /** Parent-reconstructed module-only S5 inventory for every expected runSuite host invocation. */
  readonly candidateInventoryHash: string;
  readonly namespaceSlotCount: number;
  /** Added by the parent supervisor and hash-bound into the serialized request. */
  readonly namespacePlanSha256?: string;
  readonly judgeManifest: FrozenJudgeContext['judgeManifest'];
  readonly experiment: FrozenJudgeContext;
  readonly candidate: {
    readonly sha256: string;
    readonly patch: string;
    readonly baselineCommit: string;
    readonly baselineTree: string;
  };
}

export interface SerializedJudgeRow {
  readonly case: string;
  readonly taskOutcome?: {
    readonly identity: Record<string, unknown>;
    readonly candidateCorrectness: boolean | null;
    readonly assignedStrategySuccess: boolean | null;
    readonly formatConformance: boolean | null;
    readonly operationalStatus: string;
    readonly judgements: readonly {
      readonly judgementId: string;
      readonly version: number;
      readonly judgePin: string;
      readonly candidateSha256: string;
      readonly candidateCorrectness: boolean | null;
      readonly artifact: { readonly path: string; readonly sha256: string };
      readonly [key: string]: unknown;
    }[];
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface ReviewLoopJudgeProcessPayload {
  readonly schemaVersion: 1;
  readonly identity: JudgeProcessIdentity;
  readonly requestSha256: string;
  readonly rows: readonly SerializedJudgeRow[];
  readonly tables: readonly unknown[];
  readonly diagnostics: readonly string[];
  readonly selection: {
    readonly judgementId: string;
    readonly version: number;
    readonly judgePin: string;
    readonly candidateSha256: string;
  };
}

export interface ReviewLoopJudgeProcessResult {
  readonly schemaVersion: 1;
  readonly requestSha256: string;
  readonly payloadSha256: string;
  readonly payload: ReviewLoopJudgeProcessPayload;
}
