/** Bounded, resumable assignment scheduler. Persistence and execution are injected. */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MAX_TELEMETRY_AGE_MS,
  diagnosticProbeAllowed,
  inspectQuotaFreshness,
  type BoundedDiagnosticPolicy,
  type ProviderQuota,
  type QuotaSnapshot,
} from './quota.ts';

export type AssignmentState =
  | 'queued' | 'reserved' | 'running' | 'completed' | 'quarantined' | 'interrupted' | 'blocked';
export type AssignmentKind = 'frozen-evaluation' | 'validity' | 'corpus' | 'screening' | 'development';

export interface AssignmentDependency {
  assignmentId: string;
  requiredState: 'completed';
}

export interface PairedBlock {
  id: string;
  assignmentIds: readonly string[];
  frozen: boolean;
}

export interface CampaignAssignment {
  readonly id: string;
  readonly provider: string;
  readonly kind: AssignmentKind;
  readonly state: AssignmentState;
  readonly dependencies: readonly AssignmentDependency[];
  readonly pairedBlockId?: string;
  readonly estimatedRuntimeMs: number;
  readonly estimatedUsageUnits: number | null;
  readonly estimatedUsageUnit?: string;
  readonly estimatedUsageByWindow?: readonly UsageEstimate[];
  readonly estimatedUsageConfidence: number | null;
  readonly createdAt: string;
  readonly deadlineAt?: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly attemptIds?: readonly string[];
  readonly reservation?: ResourceReservation;
  readonly reservationHistory?: readonly ResourceReservation[];
  readonly completedArtifact?: string;
  readonly completedAt?: string;
  readonly quarantine?: QuarantineRecord;
  readonly cancellation?: CancellationRecord;
  readonly blockedReason?: string;
}

export interface ResourceReservation {
  id: string;
  /** Configured route, retained for strategy identity. */
  provider: string;
  /** Shared quota account used to aggregate reservations. */
  quotaProvider: string;
  assignmentId: string;
  reservedAt: string;
  estimatedUsageUnits: number | null;
  windowClaims: readonly UsageEstimate[];
  diagnostic: boolean;
  expiresAt: string;
  /** Supervisor cancellation boundary for provider blackout or assignment deadline. */
  mustStopAt: string | null;
  telemetryFetchedAt: string;
}

export interface UsageEstimate {
  windowId: string;
  amount: number;
  unit: string;
  /** Required for fractions so estimates are never confused with provider observations. */
  calibrationId?: string;
}

export interface BindingCapacityLimit {
  provider: string;
  windowId: string;
  amount: number;
  unit: string;
}

export interface AtomicReservationRequest {
  assignmentId: string;
  quotaProvider: string;
  expectedState: 'queued';
  event: AssignmentEvent;
  reservation: ResourceReservation;
  maxConcurrentPerProvider: number;
  bindingCapacityLimits: readonly BindingCapacityLimit[];
  diagnosticLimits?: { maxAttempts: number; maxEstimatedUnits: number };
}

export interface QuarantineRecord {
  quarantinedAt: string;
  reason: 'process-crash' | 'orphaned-running' | 'partial-invocation';
  unresolvedUsage: boolean;
  partialArtifactRefs: readonly string[];
  knownUsageUnits: number | null;
}

export interface CancellationRecord {
  cancelledAt: string;
  cause: 'provider-throttle' | 'provider-cancelled' | 'operator-cancelled' | 'blackout-boundary';
  operationalClass: 'cancellation/missingness';
  candidateArtifactRef: string | null;
  candidateCorrectness: boolean | null;
  judgementArtifactRef: string | null;
  unresolvedUsage: boolean;
  knownUsageUnits: number | null;
}

export interface AssignmentEvent {
  id: string;
  assignmentId: string;
  from: AssignmentState | 'new';
  to: AssignmentState;
  at: string;
  reason: string;
  reservationId?: string;
  reservation?: ResourceReservation;
  clearReservation?: boolean;
  artifactRef?: string;
  quarantine?: QuarantineRecord;
  cancellation?: CancellationRecord;
  attemptId?: string;
}

export interface CampaignQueueStore {
  listAssignments(): Promise<readonly CampaignAssignment[]>;
  listPairedBlocks(): Promise<readonly PairedBlock[]>;
  appendEvent(event: AssignmentEvent): Promise<void>;
  /** Atomically compare assignment state, concurrency, durable reservations and limits. */
  tryReserveIfAvailable(request: AtomicReservationRequest): Promise<boolean>;
  /** Append-only create-if-absent; assignment identity and recipe never mutate. */
  createAssignment(assignment: CampaignAssignment): Promise<void>;
}

export interface QuotaSource {
  refresh(): Promise<QuotaSnapshot | null>;
}

export interface SchedulerClock {
  now(): number;
}

export interface SchedulerConfig {
  maxTelemetryAgeMs?: number;
  diagnostic?: BoundedDiagnosticPolicy;
  blackouts?: Readonly<Record<string, readonly { startsAt: string; endsAt: string; route: string }[]>>;
  /** Required conservative cap; no fixed quota reserve is applied. */
  maxConcurrentPerProvider: number;
  reservationTtlMs: number;
  /** True only when a verified reset forecast proves useful capacity and a feasible deadline. */
  hasUsefulExpiringCapacity?: (assignment: CampaignAssignment, snapshot: QuotaSnapshot, nowMs: number) => boolean;
}

export interface AdmissionDecision {
  admitted: boolean;
  assignmentId: string;
  reason: string;
  reservation?: ResourceReservation;
  telemetryFresh: boolean;
  telemetryAgeMs: number | null;
}

interface InternalAdmissionDecision extends AdmissionDecision {
  bindingCapacityLimits: readonly BindingCapacityLimit[];
}

export interface SchedulerDependencies {
  store: CampaignQueueStore;
  quota: QuotaSource;
  clock: SchedulerClock;
  config: SchedulerConfig;
}

const STATE_TRANSITIONS: Readonly<Record<AssignmentState, readonly AssignmentState[]>> = {
  queued: ['reserved', 'blocked'],
  reserved: ['running', 'queued', 'blocked'],
  running: ['completed', 'quarantined', 'interrupted'],
  completed: [],
  quarantined: ['queued'],
  interrupted: ['queued'],
  blocked: ['queued'],
};

export function canTransition(from: AssignmentState, to: AssignmentState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

/** Fixed, explicit scheduling classes. No scalar weighted score can cross a class. */
export function priorityClass(assignment: CampaignAssignment, hasUsefulExpiringCapacity: boolean): number {
  if (hasUsefulExpiringCapacity && assignment.estimatedUsageUnits !== 0) return 0;
  if (assignment.kind === 'frozen-evaluation' || assignment.pairedBlockId) return 1;
  if (assignment.kind === 'validity' || assignment.kind === 'corpus') return 2;
  return 3;
}

export function isGlmRoute(provider: string): boolean {
  return provider === 'zcode' || provider === 'zai' || provider === 'claude-zai';
}

export function quotaProviderForRoute(provider: string): string {
  return isGlmRoute(provider) ? 'zai' : provider;
}

/** Asia/Singapore weekday wall-clock blackout: Monday-Friday, 14:00 through 18:00. */
export function singaporeGlmBlackoutAt(epochMs: number): { active: boolean; startsAt?: string; endsAt?: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(epochMs);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(value.weekday);
  const minuteOfDay = Number(value.hour) * 60 + Number(value.minute);
  const active = weekday && minuteOfDay >= 14 * 60 && minuteOfDay < 18 * 60;
  if (!active) return { active: false };
  const date = `${value.year}-${value.month}-${value.day}`;
  return {
    active: true,
    startsAt: `${date}T06:00:00.000Z`,
    endsAt: `${date}T10:00:00.000Z`,
  };
}

function nextBlackoutStart(epochMs: number): number | null {
  const now = new Date(epochMs);
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const [year, month, day] = local.split('-').map(Number);
  // Singapore has no DST; 14:00 SGT is 06:00 UTC. Scan the next eight UTC dates.
  const base = Date.UTC(year, month - 1, day, 6);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = base + offset * 86_400_000;
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', weekday: 'short' }).format(candidate);
    if (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) && candidate > epochMs) return candidate;
  }
  return null;
}

function blackoutWindow(provider: string, config: SchedulerConfig, nowMs: number) {
  const configured = config.blackouts?.[provider] ?? [];
  const configuredActive = configured.find((window) => Date.parse(window.startsAt) <= nowMs && nowMs < Date.parse(window.endsAt));
  if (configuredActive) return { active: true, endsAt: Date.parse(configuredActive.endsAt), startsAt: Date.parse(configuredActive.startsAt) };
  const configuredStart = configured.map((window) => Date.parse(window.startsAt))
    .filter((start) => Number.isFinite(start) && start > nowMs)
    .sort((a, b) => a - b)[0] ?? null;
  if (isGlmRoute(provider)) {
    const result = singaporeGlmBlackoutAt(nowMs);
    if (result.active) return { active: true, startsAt: Date.parse(result.startsAt!), endsAt: Date.parse(result.endsAt!) };
    const scheduled = nextBlackoutStart(nowMs);
    const startsAt = [scheduled, configuredStart].filter((value): value is number => value !== null).sort((a, b) => a - b)[0] ?? null;
    return { active: false, startsAt, endsAt: null };
  }
  return { active: false, startsAt: configuredStart, endsAt: null };
}

function providerQuota(snapshot: QuotaSnapshot, provider: string): ProviderQuota | undefined {
  const quotaProvider = quotaProviderForRoute(provider);
  return snapshot.providers.find((entry) => entry.provider === quotaProvider);
}

function providerQuotaIsFresh(snapshot: QuotaSnapshot, provider: string, now: number, maxAgeMs: number): boolean {
  const quota = providerQuota(snapshot, provider);
  return !!quota && quota.telemetryAvailable
    && inspectQuotaFreshness({ fetchedAt: quota.observedAt, providers: [] }, now, maxAgeMs).fresh
    && quota.windows.filter((window) => window.binding).length > 0
    && quota.windows.filter((window) => window.binding).every((window) =>
      inspectQuotaFreshness({ fetchedAt: window.observedAt, providers: [] }, now, maxAgeMs).fresh);
}

function knownExhausted(quota: ProviderQuota | undefined, nowMs: number): boolean {
  return quota?.windows.some((window) => {
    if (!window.binding) return false;
    if (window.resetsAt && Date.parse(window.resetsAt) <= nowMs) return false;
    return window.remainingUnits === 0 || window.remainingFraction === 0;
  }) ?? false;
}

function estimateForWindow(assignment: CampaignAssignment, window: ProviderQuota['windows'][number]): UsageEstimate | null {
  const explicit = assignment.estimatedUsageByWindow?.find((estimate) => estimate.windowId === window.id);
  if (explicit) {
    if (explicit.unit === 'fraction') {
      return window.remainingFraction !== null && explicit.calibrationId ? explicit : null;
    }
    return window.remainingUnits !== null && window.unit === explicit.unit ? explicit : null;
  }
  if (assignment.estimatedUsageUnits === null || !assignment.estimatedUsageUnit
    || window.remainingUnits === null || !window.unit || window.unit !== assignment.estimatedUsageUnit) return null;
  return { windowId: window.id, amount: assignment.estimatedUsageUnits, unit: window.unit };
}

export class CampaignScheduler {
  private readonly maxAgeMs: number;
  private diagnosticAttempts: number;
  private diagnosticUsageUnits: number;
  private admissionTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SchedulerDependencies) {
    this.maxAgeMs = deps.config.maxTelemetryAgeMs ?? DEFAULT_MAX_TELEMETRY_AGE_MS;
    this.diagnosticAttempts = deps.config.diagnostic?.usedAttempts ?? 0;
    this.diagnosticUsageUnits = deps.config.diagnostic?.usedEstimatedUnits ?? 0;
    if (!Number.isInteger(deps.config.maxConcurrentPerProvider) || deps.config.maxConcurrentPerProvider < 1) {
      throw new RangeError('maxConcurrentPerProvider must be a positive integer');
    }
    if (!Number.isFinite(deps.config.reservationTtlMs) || deps.config.reservationTtlMs <= 0) {
      throw new RangeError('reservationTtlMs must be positive');
    }
  }

  async enqueue(assignment: CampaignAssignment): Promise<void> {
    if (assignment.state !== 'queued' || assignment.reservation || assignment.completedArtifact) {
      throw new Error('New assignments must begin queued without reservation or completed artifact');
    }
    if (!assignment.id || !assignment.stageId || !assignment.attemptId) throw new Error('Assignment identity is incomplete');
    if (assignment.attemptIds && (assignment.attemptIds.length !== 1 || assignment.attemptIds[0] !== assignment.attemptId)) {
      throw new Error('New assignments may declare only their initial attempt ID');
    }
    if (!Number.isFinite(assignment.estimatedRuntimeMs) || assignment.estimatedRuntimeMs <= 0) {
      throw new RangeError('Assignment runtime estimate must be positive');
    }
    if (assignment.estimatedUsageUnits !== null
      && (!Number.isFinite(assignment.estimatedUsageUnits) || assignment.estimatedUsageUnits < 0)) {
      throw new RangeError('Estimated usage must be a finite nonnegative number');
    }
    if (assignment.estimatedUsageUnits !== null && !assignment.estimatedUsageUnit
      && !(assignment.estimatedUsageByWindow?.length)) {
      throw new Error('Scalar usage estimates require explicit unit semantics');
    }
    const estimateWindowIds = new Set<string>();
    for (const estimate of assignment.estimatedUsageByWindow ?? []) {
      if (!estimate.windowId || estimateWindowIds.has(estimate.windowId)) throw new Error('Usage estimate window IDs must be unique');
      estimateWindowIds.add(estimate.windowId);
      if (!Number.isFinite(estimate.amount) || estimate.amount < 0 || !estimate.unit) {
        throw new RangeError('Per-window usage estimates need a finite nonnegative amount and explicit unit');
      }
      if (estimate.unit === 'fraction' && (estimate.amount > 1 || !estimate.calibrationId?.trim())) {
        throw new Error('Fraction estimates must be in [0,1] and include a calibrationId');
      }
    }
    await this.deps.store.createAssignment({ ...assignment, attemptIds: assignment.attemptIds ?? [assignment.attemptId] });
    await this.event(assignment, 'new', 'queued', 'assignment-created');
  }

  async admitNext(): Promise<AdmissionDecision | null> {
    return this.withAdmissionLock(async () => {
      const snapshot = await this.deps.quota.refresh();
      // Capture time only after refresh; provider timestamps cannot be in the future
      // merely because the observation completed after admission began.
      const now = this.deps.clock.now();
      const freshness = inspectQuotaFreshness(snapshot, now, this.maxAgeMs);
      const assignments = await this.deps.store.listAssignments();
      const pairedBlocks = await this.deps.store.listPairedBlocks();
      const ready = assignments.filter((item) => item.state === 'queued'
        && item.dependencies.every((dependency) => dependency.requiredState === 'completed'
          && this.logicalAssignmentCompleted(dependency.assignmentId, assignments))
        && (!item.pairedBlockId || pairedBlocks.some((block) => block.id === item.pairedBlockId && block.assignmentIds.every((id) => {
          const member = assignments.find((candidate) => candidate.id === id);
          return (member?.state === 'queued' || member?.state === 'reserved' || member?.state === 'completed')
            && member.dependencies.every((dependency) => dependency.requiredState === 'completed'
              && this.logicalAssignmentCompleted(dependency.assignmentId, assignments));
        }))));
      this.diagnosticAttempts = Math.max(this.diagnosticAttempts, assignments.reduce((sum, item) =>
        sum + (item.reservationHistory ?? (item.reservation ? [item.reservation] : [])).filter((reservation) => reservation.diagnostic).length, 0));
      this.diagnosticUsageUnits = Math.max(this.diagnosticUsageUnits, assignments.reduce((sum, item) =>
        sum + (item.reservationHistory ?? (item.reservation ? [item.reservation] : []))
          .filter((reservation) => reservation.diagnostic)
          .reduce((total, reservation) => total + (reservation.estimatedUsageUnits ?? 0), 0), 0));
      const usefulExpiryCapacity = (assignment: CampaignAssignment) => snapshot !== null && freshness.fresh
        && providerQuotaIsFresh(snapshot, assignment.provider, now, this.maxAgeMs)
        && (this.deps.config.hasUsefulExpiringCapacity?.(assignment, snapshot, now) ?? false);
      const ordered = [...ready].sort((a, b) => priorityClass(a, usefulExpiryCapacity(a))
        - priorityClass(b, usefulExpiryCapacity(b))
        || (Date.parse(a.deadlineAt ?? '9999-12-31T23:59:59.999Z') - Date.parse(b.deadlineAt ?? '9999-12-31T23:59:59.999Z'))
        || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

      for (const assignment of ordered) {
        const decision = this.assess(assignment, snapshot, freshness.fresh, freshness.ageMs, now, assignments);
        if (!decision.admitted || !decision.reservation) continue;
        const event: AssignmentEvent = {
          id: randomUUID(), assignmentId: assignment.id, from: 'queued', to: 'reserved',
          at: new Date(now).toISOString(), reason: decision.reason,
          reservationId: decision.reservation.id, reservation: decision.reservation, attemptId: assignment.attemptId,
        };
        const reserved = await this.deps.store.tryReserveIfAvailable({
          assignmentId: assignment.id,
          quotaProvider: decision.reservation.quotaProvider,
          expectedState: 'queued',
          event,
          reservation: decision.reservation,
          maxConcurrentPerProvider: this.deps.config.maxConcurrentPerProvider,
          bindingCapacityLimits: decision.bindingCapacityLimits,
          diagnosticLimits: this.remainingDiagnosticLimits(),
        });
        if (!reserved) continue;
        return decision;
      }
      return null;
    });
  }

  private assess(
    assignment: CampaignAssignment,
    snapshot: QuotaSnapshot | null,
    telemetryFresh: boolean,
    telemetryAgeMs: number | null,
    now: number,
    assignments: readonly CampaignAssignment[],
  ): InternalAdmissionDecision {
    const deny = (reason: string): InternalAdmissionDecision => ({ admitted: false, assignmentId: assignment.id, reason, telemetryFresh, telemetryAgeMs, bindingCapacityLimits: [] });
    const quotaProviderId = quotaProviderForRoute(assignment.provider);
    const busy = assignments.filter((item) => item.reservation?.quotaProvider === quotaProviderId
      && (item.state === 'reserved' || item.state === 'running')).length;
    if (busy >= this.deps.config.maxConcurrentPerProvider) return deny('provider-concurrency-bound');
    const blackout = blackoutWindow(assignment.provider, this.deps.config, now);
    if (blackout.active) return deny(`glm-blackout-active-until:${new Date(blackout.endsAt!).toISOString()}`);
    if (blackout.startsAt !== null && blackout.startsAt !== undefined
      && now + assignment.estimatedRuntimeMs >= blackout.startsAt) {
      return deny(`estimated-runtime-crosses-glm-blackout:${new Date(blackout.startsAt).toISOString()}`);
    }
    if (assignment.deadlineAt && now + assignment.estimatedRuntimeMs > Date.parse(assignment.deadlineAt)) {
      return deny('assignment-deadline-not-feasible');
    }
    const quota = snapshot ? providerQuota(snapshot, assignment.provider) : undefined;
    const providerFreshness = quota ? inspectQuotaFreshness({ fetchedAt: quota.observedAt, providers: [] }, now, this.maxAgeMs) : null;
    const bindingWindowsFresh = quota?.windows.filter((window) => window.binding).every((window) =>
      inspectQuotaFreshness({ fetchedAt: window.observedAt, providers: [] }, now, this.maxAgeMs).fresh) ?? false;
    if (quota?.cooldownUntil && Date.parse(quota.cooldownUntil) > now) return deny(`provider-cooldown-until:${quota.cooldownUntil}`);
    if (knownExhausted(quota, now)) return deny('known-binding-window-exhausted');
    const telemetryUsable = telemetryFresh && providerFreshness?.fresh === true
      && quota?.telemetryAvailable === true && bindingWindowsFresh;
      const binding = quota?.windows.filter((window) => window.binding) ?? [];
    const limits: BindingCapacityLimit[] = [];
    const claims: UsageEstimate[] = [];
    let calibratedEstimateAvailable = telemetryUsable && binding.length > 0;
    for (const window of binding) {
      const estimate = estimateForWindow(assignment, window);
      // Select the observed capacity in the estimate's units. CodexBar fractions
      // remain valid inputs even when no absolute unit count is available.
      const useFraction = estimate?.unit === 'fraction';
      const capacityAmount = useFraction ? window.remainingFraction : window.remainingUnits;
      const capacityUnit = useFraction ? 'fraction' : window.unit;
      if (capacityAmount === null || capacityUnit === null) {
        calibratedEstimateAvailable = false;
        continue;
      }
      limits.push({ provider: quotaProviderId, windowId: window.id, amount: capacityAmount, unit: capacityUnit });
      if (!estimate) {
        calibratedEstimateAvailable = false;
        continue;
      }
      const outstanding = assignments
        .filter((item) => item.reservation?.quotaProvider === quotaProviderId
          && (item.state === 'reserved' || item.state === 'running'))
        .flatMap((item) => item.reservation?.windowClaims ?? [])
        .filter((claim) => claim.windowId === window.id && claim.unit === estimate.unit)
        .reduce((sum, claim) => sum + claim.amount, 0);
      const unknownActiveProbe = assignments.some((item) => item.reservation?.quotaProvider === quotaProviderId
        && item.reservation.diagnostic && (item.state === 'reserved' || item.state === 'running'));
      if (unknownActiveProbe) return deny('bounded-diagnostic-probe-in-flight');
      if (capacityAmount - outstanding < estimate.amount) return deny(`binding-window-capacity-reserved-or-insufficient:${window.id}`);
      claims.push(estimate);
    }
    if (!telemetryUsable || !calibratedEstimateAvailable || claims.length !== binding.length) {
      const policy = this.deps.config.diagnostic ? {
        ...this.deps.config.diagnostic,
        usedAttempts: this.diagnosticAttempts,
        usedEstimatedUnits: this.diagnosticUsageUnits,
      } : undefined;
      if (assignment.kind !== 'validity' && assignment.kind !== 'development') return deny(`quota-telemetry-${snapshot ? 'stale-or-provider-unavailable' : 'missing'}`);
      if (!policy || assignment.estimatedUsageUnits === null || !diagnosticProbeAllowed(policy, assignment.estimatedUsageUnits)) {
        return deny('bounded-diagnostic-limit-or-usage-unavailable');
      }
      const reservation = this.makeReservation(assignment, snapshot, now, [], true);
      this.diagnosticAttempts += 1;
      this.diagnosticUsageUnits += assignment.estimatedUsageUnits;
      return { admitted: true, assignmentId: assignment.id, reason: telemetryUsable
        ? 'bounded-calibration-diagnostic-no-capacity-claim' : 'bounded-diagnostic-only-no-capacity-claim',
        reservation, telemetryFresh, telemetryAgeMs, bindingCapacityLimits: [] };
    }
    const reservation = this.makeReservation(assignment, snapshot, now, claims, false);
    return { admitted: true, assignmentId: assignment.id, reason: 'fresh-binding-capacity-reserved', reservation,
      telemetryFresh, telemetryAgeMs, bindingCapacityLimits: limits };
  }

  private logicalAssignmentCompleted(assignmentId: string, assignments: readonly CampaignAssignment[]): boolean {
    return assignments.find((item) => item.id === assignmentId)?.state === 'completed';
  }

  private makeReservation(assignment: CampaignAssignment, snapshot: QuotaSnapshot | null, now: number,
    windowClaims: readonly UsageEstimate[], diagnostic: boolean): ResourceReservation {
    const blackout = blackoutWindow(assignment.provider, this.deps.config, now);
    const stopAt = [blackout.startsAt, assignment.deadlineAt ? Date.parse(assignment.deadlineAt) : null]
      .filter((value): value is number => value !== null && value !== undefined && value > now)
      .sort((a, b) => a - b)[0];
    return {
      id: randomUUID(),
      provider: assignment.provider,
      quotaProvider: quotaProviderForRoute(assignment.provider),
      assignmentId: assignment.id,
      reservedAt: new Date(now).toISOString(),
      estimatedUsageUnits: assignment.estimatedUsageUnits,
      windowClaims,
      diagnostic,
      expiresAt: new Date(now + this.deps.config.reservationTtlMs).toISOString(),
      mustStopAt: stopAt === undefined ? null : new Date(stopAt).toISOString(),
      telemetryFetchedAt: snapshot?.fetchedAt ?? 'unavailable',
    };
  }

  async markRunning(assignmentId: string, reservationId: string): Promise<void> {
    const assignment = (await this.deps.store.listAssignments()).find((item) => item.id === assignmentId);
    const now = this.deps.clock.now();
    if (!assignment?.reservation) throw new Error(`Reservation missing for assignment ${assignmentId}`);
    if (assignment.reservation.mustStopAt && Date.parse(assignment.reservation.mustStopAt) <= now) {
      throw new Error(`Execution boundary passed for assignment ${assignmentId}`);
    }
    if (Date.parse(assignment.reservation.expiresAt) <= now) {
      throw new Error(`Reservation expired for assignment ${assignmentId}`);
    }
    await this.transition(assignmentId, 'reserved', 'running', 'invocation-started', { reservationId });
  }

  async releaseReservation(assignmentId: string, reservationId: string, reason: string): Promise<void> {
    await this.transition(assignmentId, 'reserved', 'queued', reason, { reservationId, clearReservation: true });
  }

  /** Release durable reservations whose worker never claimed them before expiry. */
  async releaseExpiredReservations(): Promise<string[]> {
    const now = this.deps.clock.now();
    const expired = (await this.deps.store.listAssignments()).filter((assignment) =>
      assignment.state === 'reserved' && assignment.reservation
      && (Date.parse(assignment.reservation.expiresAt) <= now
        || (assignment.reservation.mustStopAt !== null && Date.parse(assignment.reservation.mustStopAt) <= now)));
    for (const assignment of expired) {
      await this.releaseReservation(assignment.id, assignment.reservation!.id, 'reservation-expired-before-start');
    }
    return expired.map((assignment) => assignment.id);
  }

  async complete(assignmentId: string, artifactRef: string): Promise<void> {
    if (!artifactRef) throw new Error('Completed assignments require an immutable artifact reference');
    await this.transition(assignmentId, 'running', 'completed', 'artifact-finalized', { artifactRef });
  }

  async quarantine(assignmentId: string, quarantine: QuarantineRecord): Promise<void> {
    await this.transition(assignmentId, 'running', 'quarantined', 'unfinished-invocation-quarantined', { quarantine });
  }

  async retryQuarantined(assignmentId: string, newAttemptId: string): Promise<void> {
    const assignments = await this.deps.store.listAssignments();
    const previous = assignments.find((item) => item.id === assignmentId);
    if (!previous || previous.state !== 'quarantined') throw new Error('Only quarantined assignments can be retried');
    this.validateNewAttempt(previous, newAttemptId);
    await this.transition(assignmentId, 'quarantined', 'queued', 'retry-attempt-created', { newAttemptId });
  }

  /** Persist cancellation after finally-captured evidence and its authoritative judgment. */
  async interruptRunning(assignmentId: string, cancellation: CancellationRecord): Promise<void> {
    if (cancellation.operationalClass !== 'cancellation/missingness') throw new Error('Cancellation must retain its operational class');
    if (cancellation.candidateArtifactRef && cancellation.candidateCorrectness === null) {
      throw new Error('A captured candidate must be judged before interruption is finalized');
    }
    if (!cancellation.candidateArtifactRef && (cancellation.candidateCorrectness !== null || cancellation.judgementArtifactRef)) {
      throw new Error('Judgment evidence cannot exist without a captured candidate artifact');
    }
    if (cancellation.candidateCorrectness !== null && !cancellation.judgementArtifactRef) {
      throw new Error('Candidate correctness requires an immutable judgment artifact');
    }
    await this.transition(assignmentId, 'running', 'interrupted', `interrupted:${cancellation.cause}`, { cancellation });
  }

  async retryInterrupted(assignmentId: string, newAttemptId: string): Promise<void> {
    const assignments = await this.deps.store.listAssignments();
    const previous = assignments.find((item) => item.id === assignmentId);
    if (!previous || previous.state !== 'interrupted') throw new Error('Only interrupted assignments can be retried');
    this.validateNewAttempt(previous, newAttemptId);
    await this.transition(assignmentId, 'interrupted', 'queued', 'retry-attempt-created-after-cancellation', { newAttemptId });
  }

  private validateNewAttempt(assignment: CampaignAssignment, newAttemptId: string): void {
    if (!newAttemptId.trim() || newAttemptId === assignment.attemptId) throw new Error('Retry requires a new attempt ID');
    if ((assignment.attemptIds ?? [assignment.attemptId]).includes(newAttemptId)) {
      throw new Error(`Attempt ID already exists for assignment ${assignment.id}`);
    }
  }

  private async transition(
    assignmentId: string,
    from: AssignmentState,
    to: AssignmentState,
    reason: string,
    details: { reservationId?: string; artifactRef?: string; quarantine?: QuarantineRecord; cancellation?: CancellationRecord; clearReservation?: boolean; newAttemptId?: string } = {},
  ): Promise<void> {
    if (!canTransition(from, to)) throw new Error(`Invalid assignment transition ${from} -> ${to}`);
    const assignments = await this.deps.store.listAssignments();
    const assignment = assignments.find((item) => item.id === assignmentId);
    if (!assignment || assignment.state !== from) throw new Error(`Assignment ${assignmentId} is not ${from}`);
    if (details.reservationId && assignment.reservation?.id !== details.reservationId) {
      throw new Error(`Reservation mismatch for assignment ${assignmentId}`);
    }
    await this.event(assignment, from, to, reason, details.reservationId ? assignment.reservation : undefined, details);
  }

  private async event(
    assignment: CampaignAssignment,
    from: AssignmentState | 'new',
    to: AssignmentState,
    reason: string,
    reservation?: ResourceReservation,
    details: { reservationId?: string; artifactRef?: string; quarantine?: QuarantineRecord; cancellation?: CancellationRecord; clearReservation?: boolean; newAttemptId?: string } = {},
  ) {
    await this.deps.store.appendEvent({
      id: randomUUID(),
      assignmentId: assignment.id,
      from,
      to,
      at: new Date(this.deps.clock.now()).toISOString(),
      reason,
      reservationId: reservation?.id ?? details.reservationId,
      reservation,
      clearReservation: details.clearReservation,
      artifactRef: details.artifactRef,
      quarantine: details.quarantine,
      cancellation: details.cancellation,
      attemptId: details.newAttemptId ?? assignment.attemptId,
    });
  }

  private remainingDiagnosticLimits() {
    const diagnostic = this.deps.config.diagnostic;
    if (!diagnostic) return undefined;
    return {
      // The durable store counts every persisted diagnostic reservation, so pass
      // a total remaining ceiling relative only to externally supplied history.
      maxAttempts: Math.max(0, diagnostic.maxAttempts - diagnostic.usedAttempts),
      maxEstimatedUnits: Math.max(0, diagnostic.maxEstimatedUnits - diagnostic.usedEstimatedUnits),
    };
  }

  private async withAdmissionLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.admissionTail;
    let release!: () => void;
    this.admissionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
