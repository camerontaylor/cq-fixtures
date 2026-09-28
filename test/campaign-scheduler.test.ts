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
    this.events.push(event);
    const current = this.assignments.get(event.assignmentId);
    if (!current) throw new Error(`unknown assignment ${event.assignmentId}`);
    this.assignments.set(event.assignmentId, {
      ...current,
      state: event.to,
      ...(event.reservation ? { reservation: event.reservation } : {}),
      ...(event.clearReservation ? { reservation: undefined } : {}),
      ...(event.artifactRef ? { completedArtifact: event.artifactRef } : {}),
      ...(event.quarantine ? { quarantine: event.quarantine } : {}),
    });
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
      { id: 'use-window-before-expiry', provider: 'codex', runtimeMs: 30 * 60_000, expectedUsageUnits: 5,
        confidence: 0.7, valid: true, frozen: true, assignmentIds: ['a', 'b'] },
    ] });
    const expiryForecast = board.providers[0]?.forecasts.find((forecast) => forecast.deadlineKind === 'reset-credit-expiry');
    const resetForecast = board.providers[0]?.forecasts.find((forecast) => forecast.deadlineKind === 'normal-reset');
    expect(expiryForecast).toMatchObject({ feasibleWorkIds: ['use-window-before-expiry'], semanticsKnown: true });
    expect(expiryForecast?.note).toContain('replenishment amount and useful gain require demonstrated reset semantics');
    expect(resetForecast?.note).toContain('not assumed to be usable before a credit expires');
  });

  it('exposes the next built-in Singapore GLM blackout and remaining runnable window', () => {
    const now = Date.parse('2026-09-29T05:00:00Z');
    const board = buildWorkboard({
      nowMs: now, snapshot: quotaSnapshot(now, { provider: 'zai' }), maxTelemetryAgeMs: 60_000, work: [],
    });
    expect(board.providers[0]?.blackouts[0]).toMatchObject({
      startsAt: '2026-09-29T06:00:00.000Z', endsAt: '2026-09-29T10:00:00.000Z', route: 'zai',
    });
    expect(board.providers[0]?.runnableTimeMs).toBe(60 * 60_000);
  });

  it('quarantines crash residue, preserves unresolved usage, and retries under new stage/attempt IDs', async () => {
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
    await instance.retryQuarantined('original', assignment('retry-1', {
      retryOf: 'original', attemptId: 'new-attempt', stageId: 'new-stage',
    }));
    expect(store.assignments.get('retry-1')?.state).toBe('queued');
    await expect(instance.retryQuarantined('original', assignment('retry-1', {
      retryOf: 'original', attemptId: 'new-attempt', stageId: 'new-stage',
    }))).rejects.toThrow('immutable assignment already exists');
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
    const first = await consumeResetCreditOnce(consumer, journal, request);
    const replay = await consumeResetCreditOnce(consumer, journal, request);
    expect(first.outcome).toBe('reset');
    expect(first.refreshedQuota?.fetchedAt).toBe('2026-09-28T20:30:01.000Z');
    expect(replay).toEqual(first);
    expect(consumeCalls).toBe(1);
    expect(readCalls).toBe(1);
    await expect(consumeResetCreditOnce(consumer, journal, { ...request, idempotencyKey: 'bad' })).rejects.toThrow('UUID idempotencyKey');
  });

  it('keeps unsupported/missing telemetry probes bounded by both attempt and usage caps', () => {
    const policy = { maxAttempts: 1, maxEstimatedUnits: 2, usedAttempts: 0, usedEstimatedUnits: 0 };
    expect(diagnosticProbeAllowed(policy, 2)).toBe(true);
    expect(diagnosticProbeAllowed({ ...policy, usedAttempts: 1 }, 1)).toBe(false);
    expect(diagnosticProbeAllowed(policy, 2.1)).toBe(false);
  });
});
