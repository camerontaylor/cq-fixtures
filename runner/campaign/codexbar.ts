/** Read-only CodexBar telemetry for provider routes outside Codex app-server. */
import { spawn } from 'node:child_process';
import type { QuotaSource } from './scheduler.ts';
import type { ProviderId, ProviderQuota, QuotaSnapshot } from './quota.ts';

export type CodexBarProviderName = 'zai' | 'opencodego';

export interface CodexBarReader {
  read(provider: CodexBarProviderName): Promise<unknown>;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payloadUsage(value: unknown): Record<string, unknown> | null {
  const root = object(value);
  const row = Array.isArray(value) ? object(value[0]) : root;
  if (!row) return null;
  return object(row.usage) ?? row;
}

function unavailable(provider: CodexBarProviderName, observedAt: string): ProviderQuota {
  return {
    provider: provider as ProviderId, observedAt, source: 'codexbar:usage', windows: [],
    normalResetsAt: [], resetCredits: [], resetCreditsAvailableCount: null,
    resetCreditsKnown: false, cooldownUntil: null, telemetryAvailable: false,
  };
}

export function codexBarProviderQuota(
  provider: CodexBarProviderName,
  value: unknown,
  fetchedAt: string,
): ProviderQuota {
  const usage = payloadUsage(value);
  if (!usage) return unavailable(provider, fetchedAt);
  const observedAt = iso(usage.updatedAt) ?? iso(usage.fetchedAt) ?? fetchedAt;
  const windows = (['primary', 'secondary', 'tertiary'] as const).flatMap((name) => {
    const detail = object(usage[name]);
    if (!detail) return [];
    const usedPercent = number(detail.usedPercent);
    const windowMinutes = number(detail.windowMinutes);
    const resetsAt = iso(detail.resetsAt) ?? iso(detail.resetAt);
    const remainingFraction = usedPercent !== null && usedPercent >= 0 && usedPercent <= 100
      ? (100 - usedPercent) / 100 : null;
    return [{
      id: `${provider}:${name}`,
      windowMinutes: windowMinutes !== null && windowMinutes >= 0 ? windowMinutes : null,
      observedAt, resetsAt, remainingFraction, remainingUnits: null, unit: null,
      binding: true, source: 'codexbar:usage',
    }];
  });
  if (!windows.length) return unavailable(provider, observedAt);
  return {
    provider: provider as ProviderId, observedAt, source: 'codexbar:usage', windows,
    normalResetsAt: windows.map((window) => window.resetsAt).filter((reset): reset is string => reset !== null),
    resetCredits: [], resetCreditsAvailableCount: null, resetCreditsKnown: false,
    cooldownUntil: null, telemetryAvailable: true,
  };
}

/** Executes only CodexBar's usage read and discards stderr/raw errors. */
export class ProcessCodexBarReader implements CodexBarReader {
  private readonly executable: string;
  private readonly timeoutMs: number;

  constructor(executable = 'codexbar', timeoutMs = 40_000) {
    this.executable = executable;
    this.timeoutMs = timeoutMs;
  }

  read(provider: CodexBarProviderName): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['usage', '--provider', provider, '--format', 'json', '--no-color', '--web-timeout', '10'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`CodexBar ${provider} read timed out`));
      }, this.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 2_000_000) {
          child.kill('SIGTERM');
          clearTimeout(timer);
          reject(new Error(`CodexBar ${provider} response exceeded the read limit`));
        }
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error(`CodexBar ${provider} could not start`));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`CodexBar ${provider} read exited with code ${code ?? 'unknown'}`));
        try { resolve(JSON.parse(stdout) as unknown); }
        catch { reject(new Error(`CodexBar ${provider} returned invalid JSON`)); }
      });
    });
  }
}

export class CodexBarQuotaSource implements QuotaSource {
  private readonly reader: CodexBarReader;
  private readonly clock: () => number;

  constructor(
    reader: CodexBarReader = new ProcessCodexBarReader(),
    clock: () => number = Date.now,
  ) {
    this.reader = reader;
    this.clock = clock;
  }

  async refresh(): Promise<QuotaSnapshot> {
    const providers: CodexBarProviderName[] = ['zai', 'opencodego'];
    const results = await Promise.all(providers.map(async (provider) => {
      try { return { provider, payload: await this.reader.read(provider) }; }
      catch { return { provider, payload: null }; }
    }));
    // Timestamp after all reads have completed so admission freshness measures
    // completion age; provider.updatedAt remains the source-observation age.
    const fetchedAt = new Date(this.clock()).toISOString();
    return { fetchedAt, providers: results.map(({ provider, payload }) => codexBarProviderQuota(provider, payload, fetchedAt)) };
  }
}

/** Merges independent read-only sources by provider without masking source age. */
export class AggregateQuotaSource implements QuotaSource {
  private readonly sources: readonly QuotaSource[];
  private readonly clock: () => number;

  constructor(sources: readonly QuotaSource[], clock: () => number = Date.now) {
    this.sources = sources;
    this.clock = clock;
  }

  async refresh(): Promise<QuotaSnapshot> {
    const snapshots = await Promise.all(this.sources.map(async (source) => {
      try { return await source.refresh(); }
      catch { return null; }
    }));
    const byProvider = new Map<ProviderId, ProviderQuota>();
    for (const snapshot of snapshots) {
      for (const provider of snapshot?.providers ?? []) byProvider.set(provider.provider, provider);
    }
    return { fetchedAt: new Date(this.clock()).toISOString(), providers: [...byProvider.values()] };
  }
}
