/** Read-only capacity and deadline summary used to explain scheduler decisions. */
import type { QuotaSnapshot, ProviderQuota, ResetCredit } from './quota.ts';

export interface ForecastWork {
  id: string;
  provider: string;
  runtimeMs: number;
  expectedUsageUnits: number | null;
  confidence: number | null;
  valid: boolean;
  frozen: boolean;
  pairedBlockId?: string;
  assignmentIds: readonly string[];
}

export interface DeadlineCapacityForecast {
  provider: string;
  deadline: string;
  deadlineKind: 'normal-reset' | 'reset-credit-expiry' | 'blackout-start';
  feasibleWorkIds: readonly string[];
  usefulRuntimeMs: number;
  expectedUsageUnits: number | null;
  confidenceRange: readonly [number, number] | null;
  semanticsKnown: boolean;
  note: string;
}

export interface ProviderWorkboard {
  provider: string;
  telemetryAgeMs: number | null;
  source: string | null;
  telemetryAvailable: boolean;
  windows: ProviderQuota['windows'];
  resetCreditCount: number | null;
  resetCredits: readonly ResetCredit[];
  normalResetsAt: readonly string[];
  cooldownUntil: string | null;
  blackouts: readonly { startsAt: string; endsAt: string; route: string }[];
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

function defaultSingaporeGlmBlackouts(provider: string, nowMs: number) {
  if (provider !== 'zai' && provider !== 'claude-zai') return [];
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
    windows.push({
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 4 * 60 * 60 * 1000).toISOString(),
      route: provider,
    });
  }
  return windows;
}

export function buildWorkboard(input: {
  nowMs: number;
  snapshot: QuotaSnapshot | null;
  maxTelemetryAgeMs: number;
  work: readonly ForecastWork[];
  blackouts?: Readonly<Record<string, readonly { startsAt: string; endsAt: string; route: string }[]>>;
}): Workboard {
  const age = input.snapshot ? input.nowMs - Date.parse(input.snapshot.fetchedAt) : null;
  const fresh = age !== null && age >= 0 && age <= input.maxTelemetryAgeMs;
  const providers = (input.snapshot?.providers ?? []).map((provider) => {
    const blackouts = [
      ...defaultSingaporeGlmBlackouts(provider.provider, input.nowMs),
      ...(input.blackouts?.[provider.provider] ?? []),
    ].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const providerWork = input.work.filter((work) => work.provider === provider.provider && work.valid);
    const deadlines: Array<{ time: string; kind: DeadlineCapacityForecast['deadlineKind']; credit?: ResetCredit }> = [];
    for (const reset of provider.normalResetsAt) deadlines.push({ time: reset, kind: 'normal-reset' });
    for (const credit of provider.resetCredits) {
      if (credit.status === 'available') deadlines.push({ time: credit.expiresAt, kind: 'reset-credit-expiry', credit });
    }
    for (const blackout of blackouts) {
      deadlines.push({ time: blackout.startsAt, kind: 'blackout-start' });
    }
    const forecasts = deadlines
      .filter((deadline) => Number.isFinite(Date.parse(deadline.time)) && Date.parse(deadline.time) > input.nowMs)
      .map((deadline): DeadlineCapacityForecast => {
        const cutoff = Date.parse(deadline.time);
        const feasible = providerWork.filter((work) => input.nowMs + work.runtimeMs <= cutoff);
        const confidenceValues = feasible.map((work) => work.confidence).filter((value): value is number => value !== null);
        const knownUsage = feasible.every((work) => work.expectedUsageUnits !== null);
        return {
          provider: provider.provider,
          deadline: deadline.time,
          deadlineKind: deadline.kind,
          feasibleWorkIds: feasible.map((work) => work.id),
          usefulRuntimeMs: feasible.reduce((sum, work) => sum + work.runtimeMs, 0),
          expectedUsageUnits: knownUsage
            ? feasible.reduce((sum, work) => sum + (work.expectedUsageUnits ?? 0), 0)
            : null,
          confidenceRange: confidenceValues.length > 0
            ? [Math.min(...confidenceValues), Math.max(...confidenceValues)]
            : null,
          semanticsKnown: deadline.kind !== 'reset-credit-expiry' || provider.resetCreditsKnown,
          note: deadline.kind === 'reset-credit-expiry'
            ? 'Expiry is observed; replenishment amount and useful gain require demonstrated reset semantics.'
            : deadline.kind === 'normal-reset'
              ? 'Normal reset replenishment is not assumed to be usable before a credit expires.'
              : 'Only work whose conservative runtime fits before blackout is counted.',
        };
      });
    const nextBlackout = blackouts
      .map((entry) => Date.parse(entry.startsAt))
      .filter((time) => time > input.nowMs)
      .sort((a, b) => a - b)[0];
    const currentlyBlackouted = blackouts.some((entry) => Date.parse(entry.startsAt) <= input.nowMs && input.nowMs < Date.parse(entry.endsAt));
    return {
      provider: provider.provider,
      telemetryAgeMs: age,
      source: provider.source,
      telemetryAvailable: provider.telemetryAvailable,
      windows: provider.windows,
      resetCreditCount: provider.resetCreditsKnown
        ? provider.resetCredits.filter((credit) => credit.status === 'available').length
        : null,
      resetCredits: provider.resetCredits,
      normalResetsAt: provider.normalResetsAt,
      cooldownUntil: provider.cooldownUntil,
      blackouts,
      runnableTimeMs: currentlyBlackouted ? 0 : nextBlackout === undefined ? null : nextBlackout - input.nowMs,
      forecasts,
    };
  });
  return {
    generatedAt: new Date(input.nowMs).toISOString(),
    telemetryFresh: fresh,
    telemetryAgeMs: age,
    maxTelemetryAgeMs: input.maxTelemetryAgeMs,
    providers,
  };
}
