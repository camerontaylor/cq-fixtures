import type { Usage, WorkerResult } from '@camerontaylor/cq-toolkit';

export const USAGE_COUNTERS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const satisfies readonly (keyof Usage)[];
export type UsageCounterName = keyof Usage;
export type CounterAvailability = 'observed' | 'unavailable' | 'not-reported';
export type TokenTotalSemantics = 'authoritative-total' | 'unknown';

export interface InvocationIdentity {
  invocationId: string;
  assignmentId: string;
  stageId: string;
  attemptId: string;
}

export interface CounterObservation {
  value: number | null;
  availability: CounterAvailability;
  source: string | null;
  semantics: UsageCounterName;
}

export interface NativeObservation {
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
    counters: Record<UsageCounterName, CounterObservation>;
    tokenTotal: { value: number | null; availability: CounterAvailability; source: string | null; semantics: TokenTotalSemantics };
    inclusion: { input: string | null; output: string | null; cache: string | null; reasoning: string | null };
  };
  terminal: {
    cause: string | null;
    cancelled: boolean;
    transportException: { name: string; message: string } | null;
    observedAt: string;
  };
  capture: { status: string; baselineCommit: string | null; patchSha256: string | null; workspaceSha256: string | null };
  timing: { startedAt: string; endedAt: string | null; stages: Record<string, number | null> };
  workerResult: WorkerResult | null;
}

/** Additive fixtures-local seam. The toolkit Driver interface is unchanged. */
export interface ObservedDriver {
  campaignBudgetCapabilities?: { hardTokenCap: boolean; authoritativeTokenTotal: boolean };
  beginInvocation?(identity: InvocationIdentity): void | Promise<void>;
  setInvocationIdentity?(identity: InvocationIdentity): void | Promise<void>;
  getObservation(invocationId: string): NativeObservation | undefined | Promise<NativeObservation | undefined>;
}

export interface CampaignUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  tokenTotal: number | null;
  complete: boolean;
}

export function campaignUsage(observation: NativeObservation): CampaignUsage {
  const counters = observation.usage.counters;
  const value = (name: UsageCounterName): number | null => {
    const counter = counters[name];
    return counter.availability === 'observed' && Number.isFinite(counter.value) && counter.value! >= 0
      ? counter.value
      : null;
  };
  const totalCounter = observation.usage.tokenTotal;
  const reportedTotal = totalCounter.semantics === 'authoritative-total' && totalCounter.availability === 'observed' &&
    typeof totalCounter.value === 'number' && Number.isFinite(totalCounter.value) && totalCounter.value >= 0
    ? totalCounter.value : null;
  const usage = {
    input: value('input'), output: value('output'), cacheRead: value('cacheRead'),
    cacheWrite: value('cacheWrite'), reasoning: value('reasoning'),
    tokenTotal: reportedTotal,
  };
  return { ...usage, complete: USAGE_COUNTERS.every((name) => usage[name] !== null) && reportedTotal !== null };
}

export function emptyCampaignUsage(): CampaignUsage {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, tokenTotal: null, complete: false };
}

export function unavailableObservation(identity: InvocationIdentity, transport: string, workerResult: WorkerResult | null, observedAt = new Date().toISOString()): NativeObservation {
  const counters = Object.fromEntries(USAGE_COUNTERS.map((name) => [name, {
    value: null, availability: 'unavailable', source: null, semantics: name,
  }])) as Record<UsageCounterName, CounterObservation>;
  return {
    schemaVersion: 1, identity, transport,
    executable: { path: 'unknown', version: null, profile: 'unknown' }, artifacts: [], withheldArtifacts: [],
    model: {
      configuredTarget: 'unknown',
      requested: { value: null, source: 'unknown', status: 'unknown' },
      observed: { value: workerResult?.model ?? null, source: workerResult?.model ? 'worker-result' : null, status: workerResult?.model ? 'observed' : 'unavailable' },
      settings: {},
    },
    usage: {
      counters, tokenTotal: { value: null, availability: 'unavailable', source: null, semantics: 'unknown' },
      inclusion: { input: null, output: null, cache: null, reasoning: null },
    },
    terminal: { cause: 'observation-unavailable', cancelled: false, transportException: null, observedAt },
    capture: { status: 'pending-runner-capture', baselineCommit: null, patchSha256: null, workspaceSha256: null },
    timing: { startedAt: observedAt, endedAt: observedAt, stages: {} }, workerResult,
  };
}

/** Build an observation from legacy measured usage without claiming native provenance. */
export function legacyObservation(identity: InvocationIdentity, result: WorkerResult, startedAt: string, endedAt: string): NativeObservation {
  const names = USAGE_COUNTERS;
  const counters = Object.fromEntries(names.map((name) => {
    const value = result.usage[name];
    return [name, { value: value ?? null, availability: value === undefined ? 'not-reported' : 'observed', source: 'toolkit-driver', semantics: name }];
  })) as Record<UsageCounterName, CounterObservation>;
  const total = names.slice(0, 4).reduce((sum, name) => sum + (counters[name].value ?? 0), 0);
  return {
    schemaVersion: 1, identity, transport: 'legacy-driver',
    executable: { path: 'unknown', version: null, profile: 'legacy' }, artifacts: [], withheldArtifacts: [],
    model: {
      configuredTarget: result.model ?? 'unknown',
      requested: { value: null, source: 'unavailable', status: 'unknown' },
      observed: { value: result.model ?? null, source: result.model === undefined ? null : 'worker-result', status: result.model === undefined ? 'unavailable' : 'observed' },
      settings: {},
    },
    usage: { counters, tokenTotal: { value: total, availability: 'observed', source: 'toolkit-driver', semantics: 'authoritative-total' }, inclusion: { input: 'driver-defined', output: 'driver-defined', cache: 'driver-defined', reasoning: 'driver-defined' } },
    terminal: { cause: result.stopReason === 'complete' ? null : result.stopReason, cancelled: result.stopReason === 'aborted', transportException: null, observedAt: endedAt },
    capture: { status: 'pending-runner-capture', baselineCommit: null, patchSha256: null, workspaceSha256: null },
    timing: { startedAt, endedAt, stages: {} }, workerResult: result,
  };
}

/** Sanitize persisted/reported envelopes without altering the scorer's WorkerResult. */
export function sanitizeNativeObservation(observation: NativeObservation): NativeObservation {
  const redactText = (value: string): string => value
    .replace(/\b(sk|pk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [redacted]')
    .replace(/\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 16_384);
  const visit = (value: unknown, key = ''): unknown => {
    if (/(?:^token$|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|credential|authorization)/i.test(key)) return '[redacted]';
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, visit(item, name)]));
    }
    return value;
  };
  return visit(observation) as NativeObservation;
}
