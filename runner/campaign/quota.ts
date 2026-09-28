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
  consume(request: ResetCreditConsumeRequest): Promise<ResetCreditConsumeResult>;
  readRateLimits(): Promise<QuotaSnapshot>;
}

export interface ResetJournalEntry {
  idempotencyKey: string;
  resetType: string;
  /** Exact caller input; distinguishes omitted ID from an explicit selected ID on replay. */
  requestedCreditId?: string;
  creditId?: string;
  state: 'prepared' | 'action-executed/evidence-pending' | 'completed';
  actionOutcome?: ResetCreditConsumeOutcome;
  beforeQuota?: QuotaSnapshot;
  result?: ResetCreditConsumeResult;
}

export interface ResetJournal {
  get(idempotencyKey: string): Promise<ResetJournalEntry | null>;
  /** Must be create-if-absent. A conflicting entry is an error. */
  create(entry: ResetJournalEntry): Promise<void>;
  /** Record the provider response before attempting a post-action read. */
  recordAction(idempotencyKey: string, outcome: ResetCreditConsumeOutcome, beforeQuota: QuotaSnapshot): Promise<void>;
  /** Must only complete the matching prepared or evidence-pending entry. */
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
  let creditId = request.creditId;
  if (prior?.state === 'action-executed/evidence-pending') {
    beforeQuota = prior.beforeQuota!;
    outcome = prior.actionOutcome!;
    creditId = prior.creditId;
  } else {
    beforeQuota = await consumer.readRateLimits();
    const beforeFreshness = inspectQuotaFreshness(beforeQuota, now(), maxAgeMs);
    if (!beforeFreshness.fresh) throw new Error(`Reset redemption requires fresh rate-limit telemetry (${beforeFreshness.reason})`);
    const eligible = beforeQuota.providers.flatMap((provider) => provider.resetCredits)
      .find((credit) => credit.status === 'available' && credit.resetType === request.resetType
        && (request.creditId === undefined || credit.id === request.creditId));
    if (!eligible?.id) throw new Error('Fresh authenticated telemetry has no eligible credit for the exact native reset type and credit ID');
    creditId = eligible.id;
    if (!prior) {
      prior = { idempotencyKey: request.idempotencyKey, resetType: request.resetType,
        ...(request.creditId === undefined ? {} : { requestedCreditId: request.creditId }),
        creditId, state: 'prepared' };
      await journal.create(prior);
    } else if (prior.creditId !== creditId) {
      throw new Error('Prepared reset journal credit does not match the currently eligible authenticated credit');
    }
    const consumed = await consumer.consume({ ...request, creditId });
    if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(consumed.outcome)) {
      throw new Error('Provider returned an unsupported reset-credit outcome');
    }
    if (consumed.resetType !== request.resetType || consumed.creditId !== creditId) {
      throw new Error('Consumer result does not match the locally authenticated reset type and selected credit');
    }
    outcome = consumed.outcome;
    await journal.recordAction(request.idempotencyKey, outcome, beforeQuota);
  }
  const refreshedQuota = await consumer.readRateLimits();
  const refreshedFreshness = inspectQuotaFreshness(refreshedQuota, now(), maxAgeMs);
  if (!refreshedFreshness.fresh) {
    throw new Error(`Reset action is recorded as evidence-pending; fresh post-action telemetry unavailable (${refreshedFreshness.reason})`);
  }
  const allowanceChangeVerified = hasObservedAllowanceIncrease(beforeQuota, refreshedQuota)
    || (outcome === 'reset' || outcome === 'alreadyRedeemed') && creditNoLongerAvailable(beforeQuota, refreshedQuota, creditId);
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

function creditNoLongerAvailable(before: QuotaSnapshot, after: QuotaSnapshot, creditId: string | undefined): boolean {
  if (!creditId) return false;
  const beforeCredit = before.providers.flatMap((provider) => provider.resetCredits).find((credit) => credit.id === creditId);
  const afterCredit = after.providers.flatMap((provider) => provider.resetCredits).find((credit) => credit.id === creditId);
  return !!beforeCredit && beforeCredit.status === 'available' && (!afterCredit || afterCredit.status !== 'available');
}

function hasObservedAllowanceIncrease(before: QuotaSnapshot, after: QuotaSnapshot): boolean {
  for (const afterProvider of after.providers) {
    const beforeProvider = before.providers.find((provider) => provider.provider === afterProvider.provider);
    if (!beforeProvider) continue;
    for (const afterWindow of afterProvider.windows) {
      const beforeWindow = beforeProvider.windows.find((window) => window.id === afterWindow.id);
      if (!beforeWindow) continue;
      if (afterWindow.remainingUnits !== null && beforeWindow.remainingUnits !== null
        && afterWindow.remainingUnits > beforeWindow.remainingUnits) return true;
      if (afterWindow.remainingFraction !== null && beforeWindow.remainingFraction !== null
        && afterWindow.remainingFraction > beforeWindow.remainingFraction) return true;
      if (afterWindow.resetsAt && beforeWindow.resetsAt && Date.parse(afterWindow.resetsAt) > Date.parse(beforeWindow.resetsAt)) return true;
    }
  }
  return false;
}

export interface BoundedDiagnosticPolicy {
  maxAttempts: number;
  maxEstimatedUnits: number;
  usedAttempts: number;
  usedEstimatedUnits: number;
}

export function diagnosticProbeAllowed(policy: BoundedDiagnosticPolicy, estimatedUnits: number): boolean {
  return Number.isSafeInteger(policy.maxAttempts) && policy.maxAttempts > 0
    && Number.isFinite(policy.maxEstimatedUnits) && policy.maxEstimatedUnits >= 0
    && Number.isSafeInteger(policy.usedAttempts) && policy.usedAttempts >= 0
    && Number.isFinite(policy.usedEstimatedUnits) && policy.usedEstimatedUnits >= 0
    && Number.isFinite(estimatedUnits) && estimatedUnits >= 0
    && policy.usedAttempts < policy.maxAttempts
    && policy.usedEstimatedUnits + estimatedUnits <= policy.maxEstimatedUnits;
}
