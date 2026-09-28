/** Provider quota observations and guarded reset-credit consumption contracts. */

export type ProviderId = 'codex' | 'zai' | 'opencodego' | (string & {});

export interface QuotaWindow {
  /** Provider-reported name such as primary, secondary, five-hour or weekly. */
  id: string;
  windowMinutes: number | null;
  observedAt: string;
  resetsAt: string | null;
  /** Normalized remaining fraction, only when the provider reports it. */
  remainingFraction: number | null;
  /** Absolute usable units, only when the provider reports a meaningful unit. */
  remainingUnits: number | null;
  unit: string | null;
  binding: boolean;
  source: string;
}

export interface ResetCredit {
  id?: string;
  resetType: string;
  expiresAt: string;
  status: 'available' | 'unknown' | 'unavailable';
}

export interface ProviderQuota {
  provider: ProviderId;
  observedAt: string;
  source: string;
  windows: readonly QuotaWindow[];
  normalResetsAt: readonly string[];
  resetCredits: readonly ResetCredit[];
  /** Provider-reported count; never inferred from a possibly truncated credit list. */
  resetCreditsAvailableCount: number | null;
  /** True only when the telemetry explicitly establishes that credit metadata was read. */
  resetCreditsKnown: boolean;
  cooldownUntil: string | null;
  telemetryAvailable: boolean;
}

export interface QuotaSnapshot {
  fetchedAt: string;
  providers: readonly ProviderQuota[];
}

export interface QuotaFreshness {
  fresh: boolean;
  ageMs: number | null;
  maxAgeMs: number;
  reason: 'fresh' | 'missing' | 'invalid-timestamp' | 'stale' | 'future-timestamp';
}

export const DEFAULT_MAX_TELEMETRY_AGE_MS = 60_000;
export const RESET_REDEMPTION_INTEGRATION_DEPENDENCY =
  'The verified Codex consume route is implemented but redemption remains disabled pending explicit operator invocation.';

export function inspectQuotaFreshness(
  snapshot: QuotaSnapshot | null | undefined,
  nowMs: number,
  maxAgeMs = DEFAULT_MAX_TELEMETRY_AGE_MS,
): QuotaFreshness {
  if (!snapshot) return { fresh: false, ageMs: null, maxAgeMs, reason: 'missing' };
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return { fresh: false, ageMs: null, maxAgeMs, reason: 'invalid-timestamp' };
  const ageMs = nowMs - fetchedAt;
  if (ageMs < 0) return { fresh: false, ageMs, maxAgeMs, reason: 'future-timestamp' };
  if (ageMs > maxAgeMs) return { fresh: false, ageMs, maxAgeMs, reason: 'stale' };
  return { fresh: true, ageMs, maxAgeMs, reason: 'fresh' };
}

export type ResetCreditConsumeOutcome = 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit';

export interface ResetCreditConsumeRequest {
  /** UUID persisted before the request and reused on every replay. */
  idempotencyKey: string;
  /** Omitted only when the documented endpoint should select an eligible credit. */
  creditId?: string;
  resetType: string;
}

export interface ResetCreditConsumeResult {
  outcome: ResetCreditConsumeOutcome;
  /** Exact native enum established by authenticated pre-action account read. */
  resetType: string;
  /** Opaque ID selected from the authenticated pre-action read, not consume response. */
  creditId?: string;
  beforeAllowance: number | null;
  afterAllowance: number | null;
  observedAt: string;
  beforeQuota?: QuotaSnapshot;
  refreshedQuota?: QuotaSnapshot;
  allowanceChangeVerified?: boolean;
}

/** Narrow adapter for the documented account/rateLimitResetCredit/consume route. */
export interface SupportedResetCreditConsumer {
  readonly route: 'account/rateLimitResetCredit/consume';
  consume(request: ResetCreditConsumeRequest, options?: { replayPrepared: boolean }): Promise<ResetCreditConsumeResult>;
  readRateLimits(): Promise<QuotaSnapshot>;
}

export interface ResetJournalEntry {
  idempotencyKey: string;
  resetType: string;
  /** Exact caller input; distinguishes omitted ID from an explicit selected ID on replay. */
  requestedCreditId?: string;
  creditId?: string;
  /** Fresh authenticated snapshot that selected and pinned the physical credit before action. */
  beforeQuota?: QuotaSnapshot;
  preparedAt?: string;
  state: 'prepared' | 'action-executed/evidence-pending' | 'completed';
  actionOutcome?: ResetCreditConsumeOutcome;
  result?: ResetCreditConsumeResult;
}

export interface ResetJournal {
  get(idempotencyKey: string): Promise<ResetJournalEntry | null>;
  /** Must be create-if-absent. A conflicting entry is an error. */
  create(entry: ResetJournalEntry): Promise<void>;
  /** Record the provider response before attempting a post-action read. */
  recordAction(idempotencyKey: string, outcome: ResetCreditConsumeOutcome, beforeQuota: QuotaSnapshot): Promise<void>;
  /** Must only complete the matching evidence-pending entry with verified evidence for successful resets. */
  complete(idempotencyKey: string, result: ResetCreditConsumeResult): Promise<void>;
}

export const UUID_IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Explicitly invoked only by an orchestrator after fresh telemetry and a reviewed
 * useful-capacity forecast. Merely constructing the scheduler never calls this.
 */
export async function consumeResetCreditOnce(
  consumer: SupportedResetCreditConsumer,
  journal: ResetJournal,
  request: ResetCreditConsumeRequest,
  options: { now?: () => number; maxAgeMs?: number } = {},
): Promise<ResetCreditConsumeResult> {
  if (consumer.route !== 'account/rateLimitResetCredit/consume') {
    throw new Error('Unsupported reset-credit route');
  }
  if (!UUID_IDEMPOTENCY_KEY.test(request.idempotencyKey)) {
    throw new Error('Reset redemption requires a UUID idempotencyKey');
  }
  if (!request.resetType.trim()) throw new Error('Reset type must be explicit');

  let prior = await journal.get(request.idempotencyKey);
  if (prior && (prior.resetType !== request.resetType || prior.requestedCreditId !== request.creditId)) {
    throw new Error('Idempotency key is already journaled for a different reset request');
  }
  if (prior?.state === 'completed' && prior.result) return prior.result;
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_TELEMETRY_AGE_MS;
  let beforeQuota: QuotaSnapshot;
  let outcome: ResetCreditConsumeOutcome;
  let creditId = prior?.creditId ?? request.creditId;
  if (prior?.state === 'action-executed/evidence-pending') {
    beforeQuota = requirePreparedQuota(prior);
    outcome = prior.actionOutcome!;
  } else if (prior?.state === 'prepared') {
    beforeQuota = requirePreparedQuota(prior);
    if (!creditId) throw new Error('Prepared reset journal omitted its pinned physical credit ID');
    const boundCredit = beforeQuota.providers.find((provider) => provider.provider === 'codex')?.resetCredits
      .find((credit) => credit.id === creditId && credit.resetType === request.resetType && credit.status === 'available');
    if (!boundCredit) throw new Error('Prepared reset journal lacks the original authenticated available-credit binding');
    // The consumer performs a new fresh read, but must send this same physical
    // ID and UUID even when current telemetry now marks the credit redeemed.
    outcome = await consumePinnedCredit(consumer, journal, request, creditId, beforeQuota, true);
  } else {
    beforeQuota = await consumer.readRateLimits();
    const beforeFreshness = resetSnapshotFreshness(beforeQuota, now(), maxAgeMs, 'codex');
    if (!beforeFreshness.fresh) throw new Error(`Reset redemption requires fresh authenticated binding windows (${beforeFreshness.reason})`);
    const eligible = beforeQuota.providers.find((provider) => provider.provider === 'codex')?.resetCredits
      .find((credit) => credit.status === 'available' && credit.resetType === request.resetType
        && (request.creditId === undefined || credit.id === request.creditId));
    if (!eligible?.id) throw new Error('Fresh authenticated telemetry has no eligible credit for the exact native reset type and credit ID');
    creditId = eligible.id;
    prior = { idempotencyKey: request.idempotencyKey, resetType: request.resetType,
      ...(request.creditId === undefined ? {} : { requestedCreditId: request.creditId }),
      creditId, beforeQuota, preparedAt: new Date(now()).toISOString(), state: 'prepared' };
    await journal.create(prior);
    outcome = await consumePinnedCredit(consumer, journal, request, creditId, beforeQuota, false);
  }
  const refreshedQuota = await consumer.readRateLimits();
  const refreshedFreshness = resetSnapshotFreshness(refreshedQuota, now(), maxAgeMs, 'codex');
  if (!refreshedFreshness.fresh) {
    throw new Error(`Reset action is recorded as evidence-pending; fresh post-action telemetry unavailable (${refreshedFreshness.reason})`);
  }
  const windowEvidence = compareResetWindows(beforeQuota, refreshedQuota, 'codex');
  if (!windowEvidence.compatible) {
    throw new Error('Reset action remains evidence-pending: post-action binding-window identity set changed');
  }
  const allowanceChangeVerified = windowEvidence.changed;
  if ((outcome === 'reset' || outcome === 'alreadyRedeemed') && !allowanceChangeVerified) {
    throw new Error('Reset action remains evidence-pending: post-action read did not verify an allowance or credit-state change');
  }
  const result: ResetCreditConsumeResult = {
    outcome, resetType: request.resetType, ...(creditId ? { creditId } : {}),
    beforeAllowance: null, afterAllowance: null, observedAt: refreshedQuota.fetchedAt,
    beforeQuota, refreshedQuota, allowanceChangeVerified,
  };
  await journal.complete(request.idempotencyKey, result);
  return result;
}

async function consumePinnedCredit(
  consumer: SupportedResetCreditConsumer,
  journal: ResetJournal,
  request: ResetCreditConsumeRequest,
  creditId: string,
  beforeQuota: QuotaSnapshot,
  replayPrepared: boolean,
): Promise<ResetCreditConsumeOutcome> {
  const consumed = await consumer.consume({ ...request, creditId }, { replayPrepared });
  if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(consumed.outcome)) {
    throw new Error('Provider returned an unsupported reset-credit outcome');
  }
  if (consumed.resetType !== request.resetType || consumed.creditId !== creditId) {
    throw new Error('Consumer result does not match the locally authenticated reset type and pinned credit ID');
  }
  await journal.recordAction(request.idempotencyKey, consumed.outcome, beforeQuota);
  return consumed.outcome;
}

function requirePreparedQuota(entry: ResetJournalEntry): QuotaSnapshot {
  if (!entry.beforeQuota || !entry.creditId || !entry.preparedAt) {
    throw new Error('Reset journal recovery lacks its durable pre-action credit binding');
  }
  return entry.beforeQuota;
}

function resetSnapshotFreshness(
  snapshot: QuotaSnapshot,
  nowMs: number,
  maxAgeMs: number,
  providerId: string,
): { fresh: boolean; reason: string } {
  const aggregate = inspectQuotaFreshness(snapshot, nowMs, maxAgeMs);
  if (!aggregate.fresh) return { fresh: false, reason: aggregate.reason };
  const provider = snapshot.providers.find((candidate) => candidate.provider === providerId);
  if (!provider || !provider.telemetryAvailable) return { fresh: false, reason: 'provider-unavailable' };
  const providerFresh = inspectQuotaFreshness({ fetchedAt: provider.observedAt, providers: [] }, nowMs, maxAgeMs);
  if (!providerFresh.fresh) return { fresh: false, reason: `provider-${providerFresh.reason}` };
  const binding = provider.windows.filter((window) => window.binding);
  if (!binding.length) return { fresh: false, reason: 'binding-windows-missing' };
  for (const window of binding) {
    const freshness = inspectQuotaFreshness({ fetchedAt: window.observedAt, providers: [] }, nowMs, maxAgeMs);
    if (!freshness.fresh) return { fresh: false, reason: `binding-window-${window.id}-${freshness.reason}` };
  }
  return { fresh: true, reason: 'fresh' };
}

function compareResetWindows(before: QuotaSnapshot, after: QuotaSnapshot, providerId: string): { compatible: boolean; changed: boolean } {
  const beforeProvider = before.providers.find((provider) => provider.provider === providerId);
  const afterProvider = after.providers.find((provider) => provider.provider === providerId);
  if (!beforeProvider || !afterProvider) return { compatible: false, changed: false };
  const beforeWindows = beforeProvider.windows.filter((window) => window.binding);
  const afterWindows = afterProvider.windows.filter((window) => window.binding);
  const beforeIds = beforeWindows.map((window) => window.id).sort();
  const afterIds = afterWindows.map((window) => window.id).sort();
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) return { compatible: false, changed: false };
  const changed = beforeWindows.some((prior) => {
    const current = afterWindows.find((window) => window.id === prior.id);
    if (!current) return false;
    return current.remainingUnits !== null && prior.remainingUnits !== null && current.remainingUnits > prior.remainingUnits
      || current.remainingFraction !== null && prior.remainingFraction !== null && current.remainingFraction > prior.remainingFraction
      || !!current.resetsAt && !!prior.resetsAt && Date.parse(current.resetsAt) > Date.parse(prior.resetsAt);
  });
  return { compatible: true, changed };
}

export interface BoundedDiagnosticPolicy {
  maxAttempts: number;
  maxEstimatedUnits: number;
  usedAttempts: number;
  usedEstimatedUnits: number;
  /** Permit a bounded one-attempt probe with unknown spend and no capacity claim. */
  allowUnknownUsage?: boolean;
}

export function diagnosticProbeAllowed(policy: BoundedDiagnosticPolicy, estimatedUnits: number | null): boolean {
  const unknownUsageAllowed = estimatedUnits === null && policy.allowUnknownUsage === true && policy.maxEstimatedUnits === 0;
  const requestedUnits = estimatedUnits ?? 0;
  return Number.isSafeInteger(policy.maxAttempts) && policy.maxAttempts > 0
    && Number.isFinite(policy.maxEstimatedUnits) && policy.maxEstimatedUnits >= 0
    && Number.isSafeInteger(policy.usedAttempts) && policy.usedAttempts >= 0
    && Number.isFinite(policy.usedEstimatedUnits) && policy.usedEstimatedUnits >= 0
    && (unknownUsageAllowed || Number.isFinite(estimatedUnits) && estimatedUnits! >= 0)
    && policy.usedAttempts < policy.maxAttempts
    && (unknownUsageAllowed || policy.usedEstimatedUnits + requestedUnits <= policy.maxEstimatedUnits);
}
