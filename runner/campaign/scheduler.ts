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
  | 'queued' | 'reserved' | 'running' | 'completed' | 'quarantined' | 'blocked';
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
  readonly retryOf?: string;
  readonly provider: string;
  readonly kind: AssignmentKind;
  readonly state: AssignmentState;
  readonly dependencies: readonly AssignmentDependency[];
  readonly pairedBlockId?: string;
  readonly estimatedRuntimeMs: number;
  readonly estimatedUsageUnits: number | null;
  readonly estimatedUsageConfidence: number | null;
  readonly createdAt: string;
  readonly deadlineAt?: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly reservation?: ResourceReservation;
  readonly completedArtifact?: string;
  readonly quarantine?: QuarantineRecord;
  readonly blockedReason?: string;
}

export interface ResourceReservation {
  id: string;
  provider: string;
  assignmentId: string;
  reservedAt: string;
  estimatedUsageUnits: number | null;
  expiresAt: string;
  /** Supervisor cancellation boundary for provider blackout or assignment deadline. */
  mustStopAt: string | null;
  telemetryFetchedAt: string;
}

export interface QuarantineRecord {
  quarantinedAt: string;
  reason: 'process-crash' | 'orphaned-running' | 'partial-invocation';
  unresolvedUsage: boolean;
  partialArtifactRefs: readonly string[];
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
}

export interface CampaignQueueStore {
  listAssignments(): Promise<readonly CampaignAssignment[]>;
  listPairedBlocks(): Promise<readonly PairedBlock[]>;
  appendEvent(event: AssignmentEvent): Promise<void>;
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

export interface SchedulerDependencies {
  store: CampaignQueueStore;
  quota: QuotaSource;
  clock: SchedulerClock;
  config: SchedulerConfig;
}

const STATE_TRANSITIONS: Readonly<Record<AssignmentState, readonly AssignmentState[]>> = {
  queued: ['reserved', 'blocked'],
  reserved: ['running', 'queued', 'blocked'],
  running: ['completed', 'quarantined'],
  completed: [],
  quarantined: [],
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
  return provider === 'zai' || provider === 'claude-zai';
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
  return snapshot.providers.find((entry) => entry.provider === provider);
}

function providerHasCapacity(quota: ProviderQuota | undefined, estimatedUsageUnits: number | null): boolean {
  if (!quota?.telemetryAvailable) return false;
  const binding = quota.windows.filter((window) => window.binding);
  if (binding.length === 0) return false;
  return binding.every((window) => {
    if (window.remainingUnits === null || estimatedUsageUnits === null) return false;
    return window.remainingUnits >= estimatedUsageUnits;
  });
}

export class CampaignScheduler {
  private readonly maxAgeMs: number;
  private diagnosticAttempts: number;
  private diagnosticUsageUnits: number;

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
    if (!Number.isFinite(assignment.estimatedRuntimeMs) || assignment.estimatedRuntimeMs <= 0) {
      throw new RangeError('Assignment runtime estimate must be positive');
    }
    await this.deps.store.createAssignment(assignment);
    await this.event(assignment, 'new', 'queued', 'assignment-created');
  }

  async admitNext(): Promise<AdmissionDecision | null> {
    const now = this.deps.clock.now();
    const snapshot = await this.deps.quota.refresh();
    const freshness = inspectQuotaFreshness(snapshot, now, this.maxAgeMs);
    const assignments = await this.deps.store.listAssignments();
    const pairedBlocks = await this.deps.store.listPairedBlocks();
    const completed = new Set(assignments.filter((item) => item.state === 'completed').map((item) => item.id));
    const ready = assignments.filter((item) => item.state === 'queued'
      && item.dependencies.every((dependency) => dependency.requiredState === 'completed' && completed.has(dependency.assignmentId))
      && (!item.pairedBlockId || pairedBlocks.some((block) => block.id === item.pairedBlockId && block.assignmentIds.every((id) => {
        const member = assignments.find((candidate) => candidate.id === id);
        return (member?.state === 'queued' || member?.state === 'reserved' || member?.state === 'completed')
          && member.dependencies.every((dependency) => dependency.requiredState === 'completed' && completed.has(dependency.assignmentId));
      }))));
    const usefulExpiryCapacity = (assignment: CampaignAssignment) => snapshot !== null
      && (this.deps.config.hasUsefulExpiringCapacity?.(assignment, snapshot, now) ?? false);
    const ordered = [...ready].sort((a, b) => priorityClass(a, usefulExpiryCapacity(a))
      - priorityClass(b, usefulExpiryCapacity(b))
      || (Date.parse(a.deadlineAt ?? '9999-12-31T23:59:59.999Z') - Date.parse(b.deadlineAt ?? '9999-12-31T23:59:59.999Z'))
      || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

    for (const assignment of ordered) {
      const decision = this.assess(assignment, snapshot, freshness.fresh, freshness.ageMs, now, assignments);
      if (!decision.admitted || !decision.reservation) continue;
      await this.event(assignment, 'queued', 'reserved', 'fresh-quota-admission', decision.reservation);
      return decision;
    }
    return null;
  }

  private assess(
    assignment: CampaignAssignment,
    snapshot: QuotaSnapshot | null,
    telemetryFresh: boolean,
    telemetryAgeMs: number | null,
    now: number,
    assignments: readonly CampaignAssignment[],
  ): AdmissionDecision {
    const deny = (reason: string): AdmissionDecision => ({ admitted: false, assignmentId: assignment.id, reason, telemetryFresh, telemetryAgeMs });
    const busy = assignments.filter((item) => item.provider === assignment.provider
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
    const telemetryUsable = telemetryFresh && providerFreshness?.fresh === true
      && quota?.telemetryAvailable === true && bindingWindowsFresh;
    if (!telemetryUsable) {
      const policy = this.deps.config.diagnostic ? {
        ...this.deps.config.diagnostic,
        usedAttempts: this.diagnosticAttempts,
        usedEstimatedUnits: this.diagnosticUsageUnits,
      } : undefined;
      if (assignment.kind !== 'validity' && assignment.kind !== 'development') return deny(`quota-telemetry-${snapshot ? 'stale-or-provider-unavailable' : 'missing'}`);
      if (!policy || assignment.estimatedUsageUnits === null || !diagnosticProbeAllowed(policy, assignment.estimatedUsageUnits)) {
        return deny('bounded-diagnostic-limit-or-usage-unavailable');
      }
      const reservation = this.makeReservation(assignment, null, now);
      this.diagnosticAttempts += 1;
      this.diagnosticUsageUnits += assignment.estimatedUsageUnits;
      return { admitted: true, assignmentId: assignment.id, reason: 'bounded-diagnostic-only-no-capacity-claim', reservation, telemetryFresh, telemetryAgeMs };
    }
    if (quota?.cooldownUntil && Date.parse(quota.cooldownUntil) > now) return deny(`provider-cooldown-until:${quota.cooldownUntil}`);
    if (!providerHasCapacity(quota, assignment.estimatedUsageUnits)) return deny('binding-provider-capacity-unknown-or-insufficient');
    const reservation = this.makeReservation(assignment, snapshot, now);
    return { admitted: true, assignmentId: assignment.id, reason: 'fresh-binding-capacity-reserved', reservation, telemetryFresh, telemetryAgeMs };
  }

  private makeReservation(assignment: CampaignAssignment, snapshot: QuotaSnapshot | null, now: number): ResourceReservation {
    const blackout = blackoutWindow(assignment.provider, this.deps.config, now);
    const stopAt = [blackout.startsAt, assignment.deadlineAt ? Date.parse(assignment.deadlineAt) : null]
      .filter((value): value is number => value !== null && value !== undefined && value > now)
      .sort((a, b) => a - b)[0];
    return {
      id: randomUUID(),
      provider: assignment.provider,
      assignmentId: assignment.id,
      reservedAt: new Date(now).toISOString(),
      estimatedUsageUnits: assignment.estimatedUsageUnits,
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
      && Date.parse(assignment.reservation.expiresAt) <= now);
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

  async retryQuarantined(assignmentId: string, retry: CampaignAssignment): Promise<void> {
    const assignments = await this.deps.store.listAssignments();
    const previous = assignments.find((item) => item.id === assignmentId);
    if (!previous || previous.state !== 'quarantined') throw new Error('Only quarantined assignments can be retried');
    if (retry.id === assignmentId || retry.retryOf !== assignmentId || retry.state !== 'queued') {
      throw new Error('Retry requires a new immutable assignment ID linked through retryOf');
    }
    if (retry.attemptId === previous.attemptId || retry.stageId === previous.stageId) {
      throw new Error('Retry requires new stage and attempt IDs');
    }
    await this.enqueue(retry);
  }

  private async transition(
    assignmentId: string,
    from: AssignmentState,
    to: AssignmentState,
    reason: string,
    details: { reservationId?: string; artifactRef?: string; quarantine?: QuarantineRecord; clearReservation?: boolean } = {},
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
    details: { reservationId?: string; artifactRef?: string; quarantine?: QuarantineRecord; clearReservation?: boolean } = {},
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
    });
  }
}
