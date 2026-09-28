import { describe, expect, it } from 'vitest';
import {
  consumeResetCreditOnce,
  diagnosticProbeAllowed,
  type ProviderQuota,
  type QuotaSnapshot,
  type ResetCreditConsumeResult,
  type ResetJournal,
  type ResetJournalEntry,
  type SupportedResetCreditConsumer,
} from '../runner/campaign/quota.ts';
import {
  CampaignScheduler,
  singaporeGlmBlackoutAt,
  type AssignmentEvent,
  type CampaignAssignment,
  type CampaignQueueStore,
  type PairedBlock,
  type SchedulerClock,
} from '../runner/campaign/scheduler.ts';
import { buildWorkboard } from '../runner/campaign/workboard.ts';
import { CodexAppServerQuotaAdapter, type CodexAppServerSession } from '../runner/campaign/codex-app-server.ts';
import { FileCampaignQueueStore, FileResetJournal } from '../runner/campaign/persistence.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOUR = 60 * 60 * 1000;

class FakeClock implements SchedulerClock {
  constructor(public current: number) {}
  now() { return this.current; }
  advance(ms: number) { this.current += ms; }
}

class MemoryStore implements CampaignQueueStore {
  readonly assignments = new Map<string, CampaignAssignment>();
  readonly events: AssignmentEvent[] = [];
  readonly blocks: PairedBlock[] = [];

  async listAssignments() { return [...this.assignments.values()]; }
  async listPairedBlocks() { return [...this.blocks]; }
  async createAssignment(assignment: CampaignAssignment) {
    if (this.assignments.has(assignment.id)) throw new Error(`immutable assignment already exists: ${assignment.id}`);
    this.assignments.set(assignment.id, assignment);
  }
  async appendEvent(event: AssignmentEvent) {
    if (this.events.some((prior) => prior.id === event.id)) throw new Error(`duplicate event: ${event.id}`);
    const current = this.assignments.get(event.assignmentId);
    if (!current) throw new Error(`unknown assignment ${event.assignmentId}`);
    const attemptIds = current.attemptIds ?? [current.attemptId];
    const retrying = event.attemptId !== undefined && event.attemptId !== current.attemptId;
    if (retrying && (!['quarantined', 'interrupted'].includes(current.state) || event.to !== 'queued' || attemptIds.includes(event.attemptId!))) {
      throw new Error('invalid retry attempt event');
    }
    if (['quarantined', 'interrupted'].includes(current.state) && event.to === 'queued' && !retrying) {
      throw new Error('terminal attempt requires a new attempt ID');
    }
    const history = current.reservationHistory ?? (current.reservation ? [current.reservation] : []);
    this.assignments.set(event.assignmentId, {
      ...current,
      state: event.to,
      ...(event.reservation ? { reservation: event.reservation,
        reservationHistory: history.some((item) => item.id === event.reservation!.id) ? history : [...history, event.reservation] } : {}),
      ...(retrying ? { attemptId: event.attemptId, attemptIds: [...attemptIds, event.attemptId!] } : {}),
      ...(event.clearReservation ? { reservation: undefined } : {}),
      ...(event.artifactRef ? { completedArtifact: event.artifactRef } : {}),
      ...(event.quarantine ? { quarantine: event.quarantine } : {}),
      ...(event.cancellation ? { cancellation: event.cancellation } : {}),
    });
    this.events.push(event);
  }
  async tryReserveIfAvailable(request: Parameters<CampaignQueueStore['tryReserveIfAvailable']>[0]) {
    const assignment = this.assignments.get(request.assignmentId);
    if (!assignment || assignment.state !== request.expectedState || request.event.attemptId !== assignment.attemptId) return false;
    const active = [...this.assignments.values()].filter((candidate) => candidate.reservation?.quotaProvider === request.quotaProvider
      && (candidate.state === 'reserved' || candidate.state === 'running'));
    if (active.length >= request.maxConcurrentPerProvider) return false;
    for (const limit of request.bindingCapacityLimits) {
      const alreadyReserved = active.flatMap((candidate) => candidate.reservation?.windowClaims ?? [])
        .filter((claim) => claim.windowId === limit.windowId && claim.unit === limit.unit)
        .reduce((sum, claim) => sum + claim.amount, 0);
      const candidateClaim = request.reservation.windowClaims.find((claim) => claim.windowId === limit.windowId && claim.unit === limit.unit);
      if (!candidateClaim || alreadyReserved + candidateClaim.amount > limit.amount) return false;
    }
    if (request.reservation.diagnostic && request.diagnosticLimits) {
      const diagnostic = [...this.assignments.values()].flatMap((candidate) => candidate.reservationHistory
        ?? (candidate.reservation ? [candidate.reservation] : []))
        .filter((reservation) => reservation.quotaProvider === request.quotaProvider && reservation.diagnostic);
      if (diagnostic.length >= request.diagnosticLimits.maxAttempts) return false;
      const used = diagnostic.reduce((sum, reservation) => sum + (reservation.estimatedUsageUnits ?? 0), 0);
      if (used + (request.reservation.estimatedUsageUnits ?? 0) > request.diagnosticLimits.maxEstimatedUnits) return false;
    }
    await this.appendEvent(request.event);
    return true;
  }
}

function quotaSnapshot(now: number, opts: {
  provider?: string;
  fetchedAt?: string;
  telemetryAvailable?: boolean;
  windows?: ProviderQuota['windows'];
  resetCredits?: ProviderQuota['resetCredits'];
  resetCreditsKnown?: boolean;
  normalResetsAt?: readonly string[];
} = {}): QuotaSnapshot {
  const provider = opts.provider ?? 'codex';
  return {
    fetchedAt: opts.fetchedAt ?? new Date(now).toISOString(),
    providers: [{
      provider,
      observedAt: new Date(now).toISOString(),
      source: 'fake-codexbar',
      telemetryAvailable: opts.telemetryAvailable ?? true,
      windows: opts.windows ?? [{
        id: 'weekly', windowMinutes: 10_080, observedAt: new Date(now).toISOString(),
        resetsAt: null, remainingFraction: 0.1, remainingUnits: 10, unit: 'work-units',
        binding: true, source: 'fake-codexbar',
      }],
      normalResetsAt: opts.normalResetsAt ?? [],
      resetCredits: opts.resetCredits ?? [],
      resetCreditsAvailableCount: opts.resetCredits?.filter((credit) => credit.status === 'available').length ?? 0,
      resetCreditsKnown: opts.resetCreditsKnown ?? true,
      cooldownUntil: null,
    }],
  };
}

function assignment(id: string, opts: Partial<CampaignAssignment> = {}): CampaignAssignment {
  return {
    id,
    provider: 'codex',
    kind: 'validity',
    state: 'queued',
    dependencies: [],
    estimatedRuntimeMs: 5 * 60_000,
    estimatedUsageUnits: 5,
    estimatedUsageUnit: 'work-units',
    estimatedUsageConfidence: 0.8,
    createdAt: '2026-09-29T00:00:00.000Z',
    stageId: `${id}:stage:1`,
    attemptId: `${id}:attempt:1`,
    ...opts,
  };
}

function scheduler(input: {
  now: number;
  snapshot: QuotaSnapshot | null;
  store?: MemoryStore;
  config?: Partial<ConstructorParameters<typeof CampaignScheduler>[0]['config']>;
}) {
  const clock = new FakeClock(input.now);
  const store = input.store ?? new MemoryStore();
  const instance = new CampaignScheduler({
    store,
    clock,
    quota: { refresh: async () => input.snapshot },
    config: { maxConcurrentPerProvider: 1, reservationTtlMs: 60_000, ...input.config },
  });
  return { instance, clock, store };
}

describe('campaign scheduler admission and durable assignment lane', () => {
  it('admits against the full observed binding amount without withholding a fixed reserve', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const { instance, store } = scheduler({ now, snapshot: quotaSnapshot(now) });
    await instance.enqueue(assignment('uses-all-observed-capacity', { estimatedUsageUnits: 10 }));
    const admitted = await instance.admitNext();
    expect(admitted).toMatchObject({ admitted: true, reason: 'fresh-binding-capacity-reserved' });
    expect(store.events.at(-1)).toMatchObject({ to: 'reserved', reservation: { estimatedUsageUnits: 10 } });
  });

  it('captures admission time after refresh completes', async () => {
    const start = Date.parse('2026-09-29T01:00:00Z');
    const clock = new FakeClock(start);
    const store = new MemoryStore();
    const instance = new CampaignScheduler({ store, clock, quota: { async refresh() {
      clock.advance(5_000);
      return quotaSnapshot(clock.now());
    } }, config: { maxConcurrentPerProvider: 1, reservationTtlMs: 60_000 } });
    await instance.enqueue(assignment('refresh-clock'));
    expect(await instance.admitNext()).toMatchObject({ admitted: true, telemetryFresh: true });
  });

  it('rejects stale telemetry for evaluation while admitting only the configured bounded diagnostic count', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const stale = quotaSnapshot(now, { fetchedAt: new Date(now - 60_001).toISOString() });
    const { instance, store } = scheduler({ now, snapshot: stale, config: {
      maxConcurrentPerProvider: 3,
      diagnostic: { maxAttempts: 1, maxEstimatedUnits: 2, usedAttempts: 0, usedEstimatedUnits: 0 },
    } });
    await instance.enqueue(assignment('frozen', { kind: 'frozen-evaluation' }));
    await instance.enqueue(assignment('probe-one', { estimatedUsageUnits: 2 }));
    await instance.enqueue(assignment('probe-two', { estimatedUsageUnits: 1 }));
    expect(await instance.admitNext()).toMatchObject({ admitted: true, assignmentId: 'probe-one', telemetryFresh: false });
    expect(await instance.admitNext()).toBeNull();
    expect(store.assignments.get('frozen')?.state).toBe('queued');
    expect(store.assignments.get('probe-two')?.state).toBe('queued');
  });

  it('treats old provider/window observations as missing telemetry even when the fetch timestamp is fresh', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const snapshot = quotaSnapshot(now);
    const old = new Date(now - 60_001).toISOString();
    const provider = snapshot.providers[0]!;
    const oldProvider = { ...provider, observedAt: old, windows: provider.windows.map((window) => ({ ...window, observedAt: old })) };
    const { instance } = scheduler({ now, snapshot: { ...snapshot, providers: [oldProvider] }, config: {
      diagnostic: { maxAttempts: 1, maxEstimatedUnits: 5, usedAttempts: 0, usedEstimatedUnits: 0 },
    } });
    await instance.enqueue(assignment('stale-provider', { kind: 'frozen-evaluation' }));
    expect(await instance.admitNext()).toBeNull();
  });

  it('requires known capacity for the binding ZAI five-hour window even when weekly remains', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const { instance } = scheduler({ now, snapshot: quotaSnapshot(now, { provider: 'zai', windows: [
      { id: 'five-hour', windowMinutes: 300, observedAt: new Date(now).toISOString(), resetsAt: null,
        remainingFraction: null, remainingUnits: null, unit: null, binding: true, source: 'codexbar' },
      { id: 'weekly', windowMinutes: 10_080, observedAt: new Date(now).toISOString(), resetsAt: null,
        remainingFraction: 0.8, remainingUnits: 100, unit: 'work-units', binding: false, source: 'codexbar' },
    ] }) });
    await instance.enqueue(assignment('zai-task', { provider: 'zai', estimatedUsageUnits: 1 }));
    expect(await instance.admitNext()).toBeNull();
  });

  it('enforces weekday Singapore blackout at 14:00 through 18:00 and blocks estimates crossing its start', async () => {
    const start = Date.parse('2026-09-29T06:00:00Z'); // Tuesday 14:00 Singapore
    expect(singaporeGlmBlackoutAt(start).active).toBe(true);
    expect(singaporeGlmBlackoutAt(Date.parse('2026-09-29T09:59:59Z')).active).toBe(true);
    expect(singaporeGlmBlackoutAt(Date.parse('2026-09-29T10:00:00Z')).active).toBe(false);

    const before = start - 60_000;
    const allowedSnapshot = quotaSnapshot(before, { provider: 'zai' });
    const crossing = scheduler({ now: before, snapshot: allowedSnapshot });
    await crossing.instance.enqueue(assignment('crossing', { provider: 'zai', estimatedRuntimeMs: 2 * 60_000 }));
    expect(await crossing.instance.admitNext()).toBeNull();

    const shortRun = scheduler({ now: before, snapshot: allowedSnapshot });
    await shortRun.instance.enqueue(assignment('short-run', { provider: 'zai', estimatedRuntimeMs: 30_000 }));
    const reservation = await shortRun.instance.admitNext();
    expect(reservation?.reservation?.mustStopAt).toBe(new Date(start).toISOString());
    shortRun.clock.advance(60_000);
    await expect(shortRun.instance.markRunning('short-run', reservation!.reservation!.id)).rejects.toThrow('Execution boundary passed');

    const inside = scheduler({ now: start, snapshot: quotaSnapshot(start, { provider: 'zai' }) });
    await inside.instance.enqueue(assignment('blackout', { provider: 'zai' }));
    expect(await inside.instance.admitNext()).toBeNull();

    const after = scheduler({ now: Date.parse('2026-09-29T10:00:00Z'), snapshot: quotaSnapshot(Date.parse('2026-09-29T10:00:00Z'), { provider: 'zai' }) });
    await after.instance.enqueue(assignment('after-blackout', { provider: 'zai' }));
    expect((await after.instance.admitNext())?.admitted).toBe(true);
  });

  it('records exact 3h25m47s normal-reset to first-credit expiry overlap without assuming redemption gain', () => {
    const normalReset = '2026-10-03T21:27:33Z';
    const expiry = '2026-10-04T00:53:20Z';
    const deltaMs = Date.parse(expiry) - Date.parse(normalReset);
    expect(deltaMs).toBe(3 * HOUR + 25 * 60_000 + 47_000);
    const now = Date.parse('2026-10-03T20:00:00Z');
    const snapshot = quotaSnapshot(now, {
      normalResetsAt: [normalReset],
      resetCreditsKnown: true,
      resetCredits: [{ resetType: 'codex_rate_limits', expiresAt: expiry, status: 'available' }],
    });
    const board = buildWorkboard({ nowMs: now, snapshot, maxTelemetryAgeMs: 60_000, work: [
      { id: 'use-window-before-expiry', provider: 'codex', runtimeMs: 30 * 60_000, expectedUsageUnits: 5, expectedUsageUnit: 'work-units',
        confidence: 0.7, valid: true, frozen: true, assignmentIds: ['a', 'b'] },
    ] });
    const expiryForecast = board.providers[0]?.forecasts.find((forecast) => forecast.deadlineKind === 'reset-credit-expiry');
    const resetForecast = board.providers[0]?.forecasts.find((forecast) => forecast.deadlineKind === 'normal-reset');
    expect(expiryForecast).toMatchObject({ feasibleWorkIds: ['use-window-before-expiry'], semanticsKnown: true });
    expect(expiryForecast?.note).toContain('reset gain is not inferred');
    expect(resetForecast?.note).toContain('Post-reset capacity and replenishment are not assumed');
  });

  it('exposes the next built-in Singapore GLM blackout and remaining runnable window', () => {
    const now = Date.parse('2026-09-29T05:00:00Z');
    const board = buildWorkboard({
      nowMs: now, snapshot: quotaSnapshot(now, { provider: 'zai' }), maxTelemetryAgeMs: 60_000, work: [],
    });
    expect(board.providers[0]?.blackouts[0]).toMatchObject({
      startsAt: '2026-09-29T06:00:00.000Z', endsAt: '2026-09-29T10:00:00.000Z', route: 'zcode',
    });
    expect(board.providers[0]?.runnableTimeMs).toBe(60 * 60_000);
  });

  it('quarantines crash residue and starts a new attempt under the same assignment and stage', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const { instance, store } = scheduler({ now, snapshot: quotaSnapshot(now) });
    await instance.enqueue(assignment('original'));
    const admission = await instance.admitNext();
    await instance.markRunning('original', admission!.reservation!.id);
    await instance.quarantine('original', {
      quarantinedAt: new Date(now).toISOString(), reason: 'process-crash', unresolvedUsage: true,
      partialArtifactRefs: ['attempt/original/events.json'], knownUsageUnits: 1,
    });
    expect(store.assignments.get('original')).toMatchObject({
      state: 'quarantined', quarantine: { unresolvedUsage: true, knownUsageUnits: 1 },
    });
    await instance.retryQuarantined('original', 'new-attempt');
    expect(store.assignments.get('original')).toMatchObject({ state: 'queued', stageId: 'original:stage:1', attemptId: 'new-attempt', attemptIds: ['original:attempt:1', 'new-attempt'] });
    await expect(instance.retryQuarantined('original', 'another-attempt')).rejects.toThrow('Only quarantined assignments');
  });

  it('releases an unclaimed expired reservation without duplicating its assignment', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const { instance, clock, store } = scheduler({ now, snapshot: quotaSnapshot(now), config: { reservationTtlMs: 1_000 } });
    await instance.enqueue(assignment('reservation-expiry'));
    const admitted = await instance.admitNext();
    clock.advance(1_000);
    expect(await instance.releaseExpiredReservations()).toEqual(['reservation-expiry']);
    expect(store.assignments.get('reservation-expiry')).toMatchObject({ state: 'queued', reservation: undefined });
    expect(store.events.at(-1)).toMatchObject({ to: 'queued', reason: 'reservation-expired-before-start', clearReservation: true });
    expect(admitted?.reservation).toBeDefined();
  });

  it('keeps dependencies and paired blocks queued until prerequisites are complete', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const store = new MemoryStore();
    store.blocks.push({ id: 'pair-1', assignmentIds: ['left', 'right'], frozen: true });
    const { instance } = scheduler({ now, snapshot: quotaSnapshot(now), store, config: { maxConcurrentPerProvider: 3 } });
    await instance.enqueue(assignment('gate', { kind: 'validity' }));
    await instance.enqueue(assignment('left', { pairedBlockId: 'pair-1', dependencies: [{ assignmentId: 'gate', requiredState: 'completed' }] }));
    await instance.enqueue(assignment('right', { pairedBlockId: 'pair-1' }));
    expect(await instance.admitNext()).toMatchObject({ admitted: true, assignmentId: 'gate' });
    expect(await instance.admitNext()).toBeNull();
  });

  it('records one-time redemption through the supported injected route and refreshes rate limits', async () => {
    const idempotencyKey = '5df197d0-974c-4a96-bc2d-eed93f0fc523';
    const entries = new Map<string, ResetJournalEntry>();
    const journal: ResetJournal = {
      async get(key) { return entries.get(key) ?? null; },
      async create(entry) {
        if (entries.has(entry.idempotencyKey)) throw new Error('journal conflict');
        entries.set(entry.idempotencyKey, entry);
      },
      async complete(key, result) {
        const prior = entries.get(key);
        if (!prior || prior.state !== 'prepared') throw new Error('no prepared journal entry');
        entries.set(key, { ...prior, state: 'completed', result });
      },
    };
    let consumeCalls = 0;
    let readCalls = 0;
    const outcome: ResetCreditConsumeResult = {
      outcome: 'reset', resetType: 'codex_rate_limits', creditId: 'credit-1',
      beforeAllowance: 4, afterAllowance: 100, observedAt: '2026-09-28T20:30:00Z',
    };
    const consumer: SupportedResetCreditConsumer = {
      route: 'account/rateLimitResetCredit/consume',
      async consume(request) {
        expect(request.idempotencyKey).toBe(idempotencyKey);
        consumeCalls += 1;
        return outcome;
      },
      async readRateLimits() {
        readCalls += 1;
        return quotaSnapshot(Date.parse('2026-09-28T20:30:01Z'));
      },
    };
    const request = { idempotencyKey, resetType: 'codex_rate_limits', creditId: 'credit-1' };
    const first = await consumeResetCreditOnce(consumer, journal, request, { now: () => Date.parse('2026-09-28T20:30:02Z') });
    const replay = await consumeResetCreditOnce(consumer, journal, request, { now: () => Date.parse('2026-09-28T20:30:02Z') });
    expect(first.outcome).toBe('reset');
    expect(first.refreshedQuota?.fetchedAt).toBe('2026-09-28T20:30:01.000Z');
    expect(replay).toEqual(first);
    expect(consumeCalls).toBe(1);
    expect(readCalls).toBe(2);
    await expect(consumeResetCreditOnce(consumer, journal, { ...request, resetType: 'different-reset' }, { now: () => Date.parse('2026-09-28T20:30:02Z') }))
      .rejects.toThrow('different reset request');
    await expect(consumeResetCreditOnce(consumer, journal, { ...request, creditId: 'credit-2' }, { now: () => Date.parse('2026-09-28T20:30:02Z') }))
      .rejects.toThrow('different reset request');
    await expect(consumeResetCreditOnce(consumer, journal, { ...request, idempotencyKey: 'bad' })).rejects.toThrow('UUID idempotencyKey');
  });

  it('keeps unsupported/missing telemetry probes bounded by both attempt and usage caps', () => {
    const policy = { maxAttempts: 1, maxEstimatedUnits: 2, usedAttempts: 0, usedEstimatedUnits: 0 };
    expect(diagnosticProbeAllowed(policy, 2)).toBe(true);
    expect(diagnosticProbeAllowed({ ...policy, usedAttempts: 1 }, 1)).toBe(false);
    expect(diagnosticProbeAllowed(policy, 2.1)).toBe(false);
  });

  it('validates calibrated fraction estimates and reserves fractions across active assignments', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const fractionSnapshot = quotaSnapshot(now, { windows: [{
      id: 'weekly', windowMinutes: 10_080, observedAt: new Date(now).toISOString(), resetsAt: null,
      remainingFraction: 0.4, remainingUnits: null, unit: null, binding: true, source: 'codexbar',
    }] });
    const store = new MemoryStore();
    const first = scheduler({ now, snapshot: fractionSnapshot, store, config: { maxConcurrentPerProvider: 2 } });
    await first.instance.enqueue(assignment('fraction-1', {
      estimatedUsageUnits: null,
      estimatedUsageByWindow: [{ windowId: 'weekly', amount: 0.3, unit: 'fraction', calibrationId: 'cal-v1' }],
    }));
    await first.instance.enqueue(assignment('fraction-2', {
      estimatedUsageUnits: null,
      estimatedUsageByWindow: [{ windowId: 'weekly', amount: 0.2, unit: 'fraction', calibrationId: 'cal-v1' }],
    }));
    expect(await first.instance.admitNext()).toMatchObject({ admitted: true, assignmentId: 'fraction-1' });
    expect(await first.instance.admitNext()).toBeNull();
    await expect(first.instance.enqueue(assignment('bad-fraction', {
      estimatedUsageUnits: null,
      estimatedUsageByWindow: [{ windowId: 'weekly', amount: 1.2, unit: 'fraction', calibrationId: 'cal-v1' }],
    }))).rejects.toThrow('[0,1]');
  });

  it('serializes cross-instance admissions against provider concurrency and in-flight capacity', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const store = new MemoryStore();
    const first = scheduler({ now, snapshot: quotaSnapshot(now), store, config: { maxConcurrentPerProvider: 2 } });
    const second = scheduler({ now, snapshot: quotaSnapshot(now), store, config: { maxConcurrentPerProvider: 2 } });
    await first.instance.enqueue(assignment('six', { estimatedUsageUnits: 6 }));
    await first.instance.enqueue(assignment('five', { estimatedUsageUnits: 5 }));
    const decisions = await Promise.all([first.instance.admitNext(), second.instance.admitNext()]);
    expect(decisions.filter((decision) => decision?.admitted)).toHaveLength(1);
    expect((await store.listAssignments()).filter((item) => item.state === 'reserved')).toHaveLength(1);
  });

  it('recognizes zcode as the ZAI quota route and blocks known cooldown even with stale diagnostic telemetry', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const cooldownSnapshot = quotaSnapshot(now, { provider: 'zai', fetchedAt: new Date(now - 120_000).toISOString() });
    const cooledProvider = { ...cooldownSnapshot.providers[0]!, cooldownUntil: new Date(now + HOUR).toISOString() };
    const { instance } = scheduler({ now, snapshot: { ...cooldownSnapshot, providers: [cooledProvider] }, config: {
      diagnostic: { maxAttempts: 1, maxEstimatedUnits: 5, usedAttempts: 0, usedEstimatedUnits: 0 },
    } });
    await instance.enqueue(assignment('zcode-cooled', { provider: 'zcode' }));
    expect(await instance.admitNext()).toBeNull();
  });

  it('blocks a known exhausted binding window through stale diagnostic mode', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const staleExhausted = quotaSnapshot(now, { fetchedAt: new Date(now - 120_000).toISOString(), windows: [{
      id: 'weekly', windowMinutes: 10_080, observedAt: new Date(now - 120_000).toISOString(), resetsAt: null,
      remainingFraction: 0, remainingUnits: 0, unit: 'work-units', binding: true, source: 'codexbar',
    }] });
    const { instance } = scheduler({ now, snapshot: staleExhausted, config: {
      diagnostic: { maxAttempts: 1, maxEstimatedUnits: 5, usedAttempts: 0, usedEstimatedUnits: 0 },
    } });
    await instance.enqueue(assignment('known-empty', { kind: 'validity' }));
    expect(await instance.admitNext()).toBeNull();
  });

  it('resumes after cooldown and releases a reservation at its earlier cancellation boundary', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    let snapshot = quotaSnapshot(now);
    const provider = snapshot.providers[0]!;
    snapshot = { ...snapshot, providers: [{ ...provider, cooldownUntil: new Date(now + 1_000).toISOString() }] };
    const store = new MemoryStore();
    const clock = new FakeClock(now);
    const instance = new CampaignScheduler({ store, clock, quota: { refresh: async () => snapshot }, config: {
      maxConcurrentPerProvider: 1, reservationTtlMs: HOUR,
    } });
    await instance.enqueue(assignment('short-boundary', { estimatedRuntimeMs: 500, deadlineAt: new Date(now + 2_000).toISOString() }));
    await instance.enqueue(assignment('next-work'));
    expect(await instance.admitNext()).toBeNull();
    clock.advance(1_001);
    snapshot = quotaSnapshot(clock.now());
    const reserved = await instance.admitNext();
    expect(reserved?.assignmentId).toBe('short-boundary');
    clock.advance(1_000);
    expect(await instance.releaseExpiredReservations()).toEqual(['short-boundary']);
    expect((await instance.admitNext())?.assignmentId).toBe('next-work');
  });

  it('packs deadline work within combined capacity and reports authoritative credit count under truncation', () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const quota = quotaSnapshot(now, { resetCredits: [{ resetType: 'codex_rate_limits', expiresAt: new Date(now + HOUR).toISOString(), status: 'available' }] });
    const board = buildWorkboard({ nowMs: now, snapshot: { ...quota, providers: [{
      ...quota.providers[0]!, resetCreditsAvailableCount: 3,
    }] }, maxTelemetryAgeMs: 60_000, work: [1, 2].map((value) => ({
      id: `work-${value}`, provider: 'codex', runtimeMs: 10 * 60_000, expectedUsageUnits: 6,
      expectedUsageUnit: 'work-units', confidence: 0.8, valid: true, frozen: false, assignmentIds: [`a${value}`],
    })) });
    const forecast = board.providers[0]!.forecasts[0]!;
    expect(forecast.feasibleWorkIds).toHaveLength(1);
    expect(board.providers[0]).toMatchObject({ resetCreditCount: 3, listedAvailableCredits: 1, resetCreditListMayBeTruncated: true });
  });

  it('admits only useful work that completes before the observed first-credit expiry', async () => {
    const expiry = Date.parse('2026-10-04T00:53:20Z');
    const normalReset = Date.parse('2026-10-03T21:27:33Z');
    expect(expiry - normalReset).toBe(3 * HOUR + 25 * 60_000 + 47_000);
    const now = normalReset - 30 * 60_000;
    const snapshot = quotaSnapshot(now, { normalResetsAt: [new Date(normalReset).toISOString()], resetCredits: [
      { resetType: 'codexRateLimits', expiresAt: new Date(expiry).toISOString(), status: 'available' },
    ] });
    const { instance } = scheduler({ now, snapshot, config: {
      hasUsefulExpiringCapacity: (_assignment, observed, current) => current < expiry
        && observed.providers[0]?.resetCredits.some((credit) => credit.status === 'available' && Date.parse(credit.expiresAt) === expiry) === true,
    } });
    await instance.enqueue(assignment('fits-credit-window', { deadlineAt: new Date(expiry).toISOString(), estimatedRuntimeMs: 20 * 60_000 }));
    expect(await instance.admitNext()).toMatchObject({ admitted: true, assignmentId: 'fits-credit-window' });
    const tooLate = scheduler({ now: expiry - 10 * 60_000, snapshot: quotaSnapshot(expiry - 10 * 60_000), config: {
      hasUsefulExpiringCapacity: () => true,
    } });
    await tooLate.instance.enqueue(assignment('misses-credit-window', { deadlineAt: new Date(expiry).toISOString(), estimatedRuntimeMs: 20 * 60_000 }));
    expect(await tooLate.instance.admitNext()).toBeNull();
  });

  it('uses provider and binding-window observation ages for workboard freshness', () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const snapshot = quotaSnapshot(now);
    const provider = snapshot.providers[0]!;
    const old = new Date(now - 5 * 60_000).toISOString();
    const board = buildWorkboard({ nowMs: now, snapshot: { ...snapshot, providers: [{
      ...provider, observedAt: old, windows: provider.windows.map((window) => ({ ...window, observedAt: old })),
    }] }, maxTelemetryAgeMs: 60_000, work: [] });
    expect(board.telemetryFresh).toBe(false);
    expect(board.providers[0]).toMatchObject({ telemetryFresh: false, telemetryAgeMs: 5 * 60_000 });
  });

  it('retries a quarantined paired stage with a new attempt and unblocks its frozen block and dependents', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const store = new MemoryStore();
    store.blocks.push({ id: 'pair-retry', assignmentIds: ['left', 'right'], frozen: true });
    const { instance } = scheduler({ now, snapshot: quotaSnapshot(now), store, config: { maxConcurrentPerProvider: 1 } });
    await instance.enqueue(assignment('left', { kind: 'frozen-evaluation', pairedBlockId: 'pair-retry' }));
    await instance.enqueue(assignment('right', { kind: 'frozen-evaluation', pairedBlockId: 'pair-retry' }));
    await instance.enqueue(assignment('dependent', { dependencies: [{ assignmentId: 'left', requiredState: 'completed' }] }));
    const first = await instance.admitNext();
    expect(first?.assignmentId).toBe('left');
    await instance.markRunning('left', first!.reservation!.id);
    await instance.quarantine('left', { quarantinedAt: new Date(now).toISOString(), reason: 'process-crash', unresolvedUsage: true, partialArtifactRefs: [], knownUsageUnits: null });
    await instance.retryQuarantined('left', 'left-attempt-2');
    const retry = await instance.admitNext();
    expect(retry?.assignmentId).toBe('left');
    await instance.markRunning('left', retry!.reservation!.id);
    await instance.complete('left', 'artifacts/left/stage/left:stage:1/attempt/left-attempt-2/manifest.json');
    const right = await instance.admitNext();
    expect(right?.assignmentId).toBe('right');
    await instance.markRunning('right', right!.reservation!.id);
    await instance.complete('right', 'artifacts/right/manifest.json');
    expect((await instance.admitNext())?.assignmentId).toBe('dependent');
  });

  it('finalizes cancellation evidence before interruption and preserves stage identity for retry', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const { instance, store } = scheduler({ now, snapshot: quotaSnapshot(now) });
    await instance.enqueue(assignment('cancelled', { kind: 'frozen-evaluation' }));
    const reserved = await instance.admitNext();
    await instance.markRunning('cancelled', reserved!.reservation!.id);
    await instance.interruptRunning('cancelled', {
      cancelledAt: new Date(now).toISOString(), cause: 'provider-throttle', operationalClass: 'cancellation/missingness',
      candidateArtifactRef: 'attempt/candidate.patch', candidateCorrectness: false, judgementArtifactRef: 'judgment/1.json',
      unresolvedUsage: true, knownUsageUnits: null,
    });
    expect(store.assignments.get('cancelled')).toMatchObject({ state: 'interrupted', cancellation: { cause: 'provider-throttle', candidateCorrectness: false } });
    await instance.retryInterrupted('cancelled', 'attempt-2');
    expect(store.assignments.get('cancelled')).toMatchObject({ id: 'cancelled', stageId: 'cancelled:stage:1', attemptId: 'attempt-2' });
  });

  it('keeps bounded diagnostic spend across scheduler restarts using durable assignment events', async () => {
    const now = Date.parse('2026-09-29T01:00:00Z');
    const store = new MemoryStore();
    const config = { maxConcurrentPerProvider: 2, diagnostic: { maxAttempts: 1, maxEstimatedUnits: 2, usedAttempts: 0, usedEstimatedUnits: 0 } };
    const first = scheduler({ now, snapshot: null, store, config });
    await first.instance.enqueue(assignment('diagnostic-one', { kind: 'validity', estimatedUsageUnits: 2 }));
    expect((await first.instance.admitNext())?.admitted).toBe(true);
    const restarted = scheduler({ now, snapshot: null, store, config });
    await restarted.instance.enqueue(assignment('diagnostic-two', { kind: 'validity', estimatedUsageUnits: 1 }));
    expect(await restarted.instance.admitNext()).toBeNull();
  });

  it('reads native Codex account limits through the injected read-only session without consuming credits', async () => {
    const methods: string[] = [];
    let closed = false;
    const session: CodexAppServerSession = {
      async request(method) {
        methods.push(method);
        return { rateLimits: {
          primary: { usedPercent: 22, windowDurationMins: 10_080, resetsAt: 1_791_000_000 }, secondary: null,
        }, rateLimitsByLimitId: {}, rateLimitResetCredits: { availableCount: 3, credits: [] } };
      },
      notify() {}, async close() { closed = true; },
    };
    const adapter = new CodexAppServerQuotaAdapter(async () => session, () => Date.parse('2026-09-29T01:00:00Z'));
    const result = await adapter.refresh();
    expect(result.providers[0]?.windows[0]).toMatchObject({ remainingFraction: 0.78, remainingUnits: null, unit: null });
    expect(result.providers[0]).toMatchObject({ resetCreditsAvailableCount: 3, resetCreditsKnown: true });
    expect(methods).toEqual(['account/rateLimits/read']);
    expect(closed).toBe(true);
  });

  it('persists queue and reset journal records append-only across store instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'campaign-scheduler-'));
    try {
      const store = new FileCampaignQueueStore(directory);
      const now = Date.parse('2026-09-29T01:00:00Z');
      await store.createAssignment(assignment('durable'));
      await store.appendEvent({ id: 'created-durable', assignmentId: 'durable', from: 'new', to: 'queued', at: new Date(now).toISOString(), reason: 'assignment-created' });
      expect((await new FileCampaignQueueStore(directory).listAssignments())[0]?.state).toBe('queued');
      const diagnosticConfig = { maxConcurrentPerProvider: 2, reservationTtlMs: 60_000,
        diagnostic: { maxAttempts: 1, maxEstimatedUnits: 5, usedAttempts: 0, usedEstimatedUnits: 0 } };
      const first = new CampaignScheduler({ store, clock: new FakeClock(now), quota: { refresh: async () => null }, config: diagnosticConfig });
      expect((await first.admitNext())?.assignmentId).toBe('durable');
      const secondStore = new FileCampaignQueueStore(directory);
      const second = new CampaignScheduler({ store: secondStore, clock: new FakeClock(now), quota: { refresh: async () => null }, config: diagnosticConfig });
      await second.enqueue(assignment('durable-second', { estimatedUsageUnits: 1 }));
      expect(await second.admitNext()).toBeNull();
      const journal = new FileResetJournal(directory);
      await journal.create({ idempotencyKey: '5df197d0-974c-4a96-bc2d-eed93f0fc523', resetType: 'codexRateLimits', state: 'prepared' });
      expect(await new FileResetJournal(directory).get('5df197d0-974c-4a96-bc2d-eed93f0fc523')).toMatchObject({ state: 'prepared', resetType: 'codexRateLimits' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
