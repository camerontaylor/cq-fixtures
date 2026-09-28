/** Read-only capacity and deadline summary used to explain scheduler decisions. */
import type { QuotaSnapshot, ProviderQuota, ResetCredit } from './quota.ts';
import type { ResourceReservation, UsageEstimate } from './scheduler.ts';

export interface ForecastWork {
  id: string;
  provider: string;
  runtimeMs: number;
  expectedUsageUnits: number | null;
  expectedUsageUnit?: string;
  expectedUsageByWindow?: readonly UsageEstimate[];
  confidence: number | null;
  valid: boolean;
  frozen: boolean;
  priorityClass?: number;
  pairedBlockId?: string;
  assignmentIds: readonly string[];
}

export interface DeadlineCapacityForecast {
  provider: string;
  deadline: string;
  deadlineKind: 'normal-reset' | 'reset-credit-expiry' | 'blackout-start';
  feasibleWorkIds: readonly string[];
  unboundedWorkIds: readonly string[];
  usageByWindow: readonly { windowId: string; amount: number; unit: string }[];
  expectedUsageUnits: number | null;
  confidenceRange: readonly [number, number] | null;
  capacityKnown: boolean;
  concurrency: 1;
  semanticsKnown: boolean;
  note: string;
}

export interface ProviderWorkboard {
  provider: string;
  configuredRoutes: readonly string[];
  telemetryAgeMs: number | null;
  telemetryFresh: boolean;
  source: string | null;
  telemetryAvailable: boolean;
  windows: ProviderQuota['windows'];
  resetCreditCount: number | null;
  listedAvailableCredits: number;
  resetCreditListMayBeTruncated: boolean;
  resetCredits: readonly ResetCredit[];
  normalResetsAt: readonly string[];
  cooldownUntil: string | null;
  blackouts: readonly { startsAt: string; endsAt: string; route: string }[];
  /** Sequentially runnable time before the next blackout; 0 during an active blackout. */
  runnableTimeMs: number | null;
  forecasts: readonly DeadlineCapacityForecast[];
}

export interface Workboard {
  generatedAt: string;
  telemetryFresh: boolean;
  telemetryAgeMs: number | null;
  maxTelemetryAgeMs: number;
  providers: readonly ProviderWorkboard[];
}

function quotaProviderForRoute(provider: string): string {
  return ['zcode', 'zai', 'claude-zai'].includes(provider) ? 'zai' : provider;
}

function defaultSingaporeGlmBlackouts(provider: string, nowMs: number) {
  if (provider !== 'zai') return [];
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(nowMs);
  const [year, month, day] = localDate.split('-').map(Number);
  const windows: { startsAt: string; endsAt: string; route: string }[] = [];
  const dayStartUtc = Date.UTC(year, month - 1, day, 6);
  for (let offset = 0; offset <= 7; offset += 1) {
    const start = dayStartUtc + offset * 86_400_000;
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', weekday: 'short' }).format(start);
    if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) || start + 4 * 60 * 60 * 1000 <= nowMs) continue;
    for (const route of ['zcode', 'claude-zai']) {
      windows.push({
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 4 * 60 * 60 * 1000).toISOString(),
        route,
      });
    }
  }
  return windows;
}

function estimatesForWork(work: ForecastWork, provider: ProviderQuota): UsageEstimate[] | null {
  const binding = provider.windows.filter((window) => window.binding);
  const explicit = work.expectedUsageByWindow;
  if (explicit?.length) {
    const byId = new Map(explicit.map((estimate) => [estimate.windowId, estimate]));
    const mapped = binding.map((window) => byId.get(window.id));
    if (mapped.some((estimate) => !estimate || !Number.isFinite(estimate.amount) || estimate.amount < 0
      || (estimate.unit === 'fraction' && (estimate.amount > 1 || !estimate.calibrationId)))) return null;
    return mapped as UsageEstimate[];
  }
  if (binding.length !== 1 || work.expectedUsageUnits === null || !work.expectedUsageUnit) return null;
  const window = binding[0]!;
  const availableUnit = window.remainingUnits !== null ? window.unit : 'fraction';
  if (availableUnit !== work.expectedUsageUnit) return null;
  if (availableUnit === 'fraction') return null;
  return [{ windowId: window.id, amount: work.expectedUsageUnits, unit: availableUnit }];
}

function capacityForWindow(window: ProviderQuota['windows'][number]) {
  if (window.remainingUnits !== null && window.unit) return { amount: window.remainingUnits, unit: window.unit };
  if (window.remainingFraction !== null) return { amount: window.remainingFraction, unit: 'fraction' };
  return null;
}

function packFeasibleWork(
  provider: ProviderQuota,
  work: readonly ForecastWork[],
  nowMs: number,
  cutoffMs: number,
  reservations: readonly ResourceReservation[],
): DeadlineCapacityForecast['feasibleWorkIds'] extends readonly string[] ? {
  feasibleWorkIds: string[];
  unboundedWorkIds: string[];
  usageByWindow: { windowId: string; amount: number; unit: string }[];
  confidenceRange: readonly [number, number] | null;
  capacityKnown: boolean;
} : never {
  const binding = provider.windows.filter((window) => window.binding);
  const remaining = new Map(binding.map((window) => [window.id, capacityForWindow(window)]));
  const outstanding = reservations.flatMap((reservation) => reservation.windowClaims);
  const activeReservationIds = new Set(reservations.map((reservation) => reservation.assignmentId));
  const activeRuntimeMs = work.filter((candidate) => candidate.assignmentIds.some((id) => activeReservationIds.has(id)))
    .reduce((sum, candidate) => sum + Math.max(0, candidate.runtimeMs), 0);
  for (const claim of outstanding) {
    const current = remaining.get(claim.windowId);
    if (current?.unit === claim.unit) remaining.set(claim.windowId, { ...current, amount: current.amount - claim.amount });
  }
  const candidates = [...work].sort((a, b) => (a.priorityClass ?? (a.frozen ? 1 : 3)) - (b.priorityClass ?? (b.frozen ? 1 : 3))
    || a.id.localeCompare(b.id));
  const feasibleWorkIds: string[] = [];
  const unboundedWorkIds: string[] = [];
  const used = new Map<string, { amount: number; unit: string }>();
  let runtimeMs = activeRuntimeMs;
  const confidence: number[] = [];

  for (const candidate of candidates) {
    if (!candidate.valid || !Number.isFinite(candidate.runtimeMs) || candidate.runtimeMs <= 0
      || nowMs + runtimeMs + candidate.runtimeMs > cutoffMs) continue;
    const claims = estimatesForWork(candidate, provider);
    if (!claims) {
      unboundedWorkIds.push(candidate.id);
      continue;
    }
    const fits = !activeReservationIds.size && claims.every((claim) => {
      const available = remaining.get(claim.windowId);
      return available !== null && available !== undefined && available.unit === claim.unit
        && Number.isFinite(claim.amount) && claim.amount >= 0
        && claim.amount <= available.amount - (used.get(claim.windowId)?.amount ?? 0);
    });
    if (!fits) continue;
    feasibleWorkIds.push(candidate.id);
    runtimeMs += candidate.runtimeMs;
    for (const claim of claims) {
      const previous = used.get(claim.windowId);
      used.set(claim.windowId, { amount: (previous?.amount ?? 0) + claim.amount, unit: claim.unit });
    }
    if (candidate.confidence !== null && Number.isFinite(candidate.confidence)) confidence.push(candidate.confidence);
  }

  const rows = [...used].map(([windowId, value]) => ({ windowId, ...value }));
  return {
    feasibleWorkIds,
    unboundedWorkIds,
    usageByWindow: rows,
    confidenceRange: confidence.length ? [Math.min(...confidence), Math.max(...confidence)] : null,
    capacityKnown: binding.length > 0 && binding.every((window) => capacityForWindow(window) !== null),
  };
}

export function buildWorkboard(input: {
  nowMs: number;
  snapshot: QuotaSnapshot | null;
  maxTelemetryAgeMs: number;
  work: readonly ForecastWork[];
  blackouts?: Readonly<Record<string, readonly { startsAt: string; endsAt: string; route: string }[]>>;
  reservations?: readonly ResourceReservation[];
}): Workboard {
  const age = input.snapshot ? input.nowMs - Date.parse(input.snapshot.fetchedAt) : null;
  const snapshotFresh = age !== null && age >= 0 && age <= input.maxTelemetryAgeMs;
  const providerFreshness = new Map<string, { ageMs: number | null; fresh: boolean }>();
  const providers = (input.snapshot?.providers ?? []).map((provider) => {
    const observationAges = [provider.observedAt, ...provider.windows.filter((window) => window.binding).map((window) => window.observedAt)]
      .map((timestamp) => input.nowMs - Date.parse(timestamp));
    const providerAgeMs = observationAges.length && observationAges.every(Number.isFinite)
      ? Math.max(...observationAges) : null;
    const providerFresh = snapshotFresh && providerAgeMs !== null && providerAgeMs >= 0 && providerAgeMs <= input.maxTelemetryAgeMs;
    providerFreshness.set(provider.provider, { ageMs: providerAgeMs, fresh: providerFresh });
    const canonical = quotaProviderForRoute(provider.provider);
    const providerWork = input.work.filter((work) => quotaProviderForRoute(work.provider) === canonical && work.valid);
    const configuredBlackouts = [
      ...(input.blackouts?.[provider.provider] ?? []),
      ...(input.blackouts?.[canonical] ?? []),
      ...(input.blackouts?.zcode ?? []),
      ...(input.blackouts?.['claude-zai'] ?? []),
    ];
    const blackouts = [
      ...defaultSingaporeGlmBlackouts(canonical, input.nowMs),
      ...configuredBlackouts,
    ].filter((window, index, all) => all.findIndex((candidate) => candidate.startsAt === window.startsAt
      && candidate.endsAt === window.endsAt && candidate.route === window.route) === index)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const deadlines: Array<{ time: string; kind: DeadlineCapacityForecast['deadlineKind'] }> = [];
    for (const reset of provider.normalResetsAt) deadlines.push({ time: reset, kind: 'normal-reset' });
    for (const credit of provider.resetCredits) {
      if (credit.status === 'available') deadlines.push({ time: credit.expiresAt, kind: 'reset-credit-expiry' });
    }
    for (const blackout of blackouts) deadlines.push({ time: blackout.startsAt, kind: 'blackout-start' });
    const forecasts = deadlines
      .filter((deadline) => Number.isFinite(Date.parse(deadline.time)) && Date.parse(deadline.time) > input.nowMs)
      .map((deadline): DeadlineCapacityForecast => {
        const providerReservations = (input.reservations ?? []).filter((reservation) => reservation.quotaProvider === canonical);
        const packed = providerFresh && provider.telemetryAvailable
          ? packFeasibleWork(provider, providerWork, input.nowMs, Date.parse(deadline.time), providerReservations)
          : { feasibleWorkIds: [], unboundedWorkIds: providerWork.map((work) => work.id), usageByWindow: [], confidenceRange: null, capacityKnown: false };
        const units = new Set(packed.usageByWindow.map((row) => row.unit));
        const expectedUsageUnits = packed.usageByWindow.length === 1 && units.size === 1
          ? packed.usageByWindow.reduce((sum, row) => sum + row.amount, 0)
          : null;
        const semanticsKnown = deadline.kind !== 'reset-credit-expiry' || provider.resetCreditsKnown;
        return {
          provider: provider.provider,
          deadline: deadline.time,
          deadlineKind: deadline.kind,
          feasibleWorkIds: packed.feasibleWorkIds,
          unboundedWorkIds: packed.unboundedWorkIds,
          usageByWindow: packed.usageByWindow,
          expectedUsageUnits,
          confidenceRange: packed.confidenceRange,
          capacityKnown: packed.capacityKnown,
          concurrency: 1,
          semanticsKnown,
          note: deadline.kind === 'reset-credit-expiry'
            ? 'Only currently observed capacity and explicitly calibrated work estimates are packed; reset gain is not inferred.'
            : deadline.kind === 'normal-reset'
              ? 'Post-reset capacity and replenishment are not assumed.'
              : 'Sequential work must fit its runtime and every binding window before blackout.',
        };
      });
    const nextBlackout = blackouts.map((entry) => Date.parse(entry.startsAt))
      .filter((time) => time > input.nowMs).sort((a, b) => a - b)[0];
    const currentlyBlackouted = blackouts.some((entry) => Date.parse(entry.startsAt) <= input.nowMs && input.nowMs < Date.parse(entry.endsAt));
    const listedAvailableCredits = provider.resetCredits.filter((credit) => credit.status === 'available').length;
    const routes = input.work.filter((work) => quotaProviderForRoute(work.provider) === canonical).map((work) => work.provider);
    if (canonical === 'zai') routes.push('zcode');
    return {
      provider: provider.provider,
      configuredRoutes: [...new Set(routes)].sort(),
      telemetryAgeMs: providerAgeMs,
      telemetryFresh: providerFresh,
      source: provider.source,
      telemetryAvailable: provider.telemetryAvailable,
      windows: provider.windows,
      resetCreditCount: provider.resetCreditsKnown ? provider.resetCreditsAvailableCount : null,
      listedAvailableCredits,
      resetCreditListMayBeTruncated: provider.resetCreditsAvailableCount !== null
        && provider.resetCreditsAvailableCount > listedAvailableCredits,
      // Opaque backend credit IDs stay in the private quota snapshot for an
      // explicitly invoked consume flow; never serialize them to the board.
      resetCredits: provider.resetCredits.map(({ resetType, expiresAt, status }) => ({ resetType, expiresAt, status })),
      normalResetsAt: provider.normalResetsAt,
      cooldownUntil: provider.cooldownUntil,
      blackouts,
      runnableTimeMs: currentlyBlackouted ? 0 : nextBlackout === undefined ? null : nextBlackout - input.nowMs,
      forecasts,
    };
  });
  return {
    generatedAt: new Date(input.nowMs).toISOString(),
    telemetryFresh: snapshotFresh && [...providerFreshness.values()].every((entry) => entry.fresh),
    telemetryAgeMs: age,
    maxTelemetryAgeMs: input.maxTelemetryAgeMs,
    providers,
  };
}
