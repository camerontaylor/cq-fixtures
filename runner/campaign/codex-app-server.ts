/** Safe, narrow Codex account/rate-limit adapter over the installed app-server CLI. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { QuotaSource } from './scheduler.ts';
import { inspectQuotaFreshness } from './quota.ts';
import type {
  ProviderQuota,
  QuotaSnapshot,
  ResetCreditConsumeRequest,
  ResetCreditConsumeResult,
  SupportedResetCreditConsumer,
} from './quota.ts';

export interface CodexAppServerSession {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): Promise<void>;
}

export type CodexAppServerSessionFactory = () => Promise<CodexAppServerSession>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function epochIso(value: unknown): string | null {
  const seconds = finite(value);
  if (seconds === null || seconds < 0) return null;
  const timestamp = seconds > 10_000_000_000 ? seconds : seconds * 1_000;
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) return null;
  return new Date(timestamp).toISOString();
}

function nativeQuotaSnapshot(result: unknown, fetchedAt: string): QuotaSnapshot {
  const response = record(result);
  const base = record(response?.rateLimits);
  if (!base) throw new Error('Codex app-server account/rateLimits/read omitted rateLimits');
  const byLimit = record(response?.rateLimitsByLimitId) ?? {};
  // The backwards-compatible base view commonly duplicates one entry in the
  // keyed view. Deduplicate by the provider's physical limit identity, while
  // retaining distinct native limit IDs as separate capacity windows.
  const limitsByIdentity = new Map<string, Record<string, unknown>>();
  const addLimit = (limit: Record<string, unknown>, fallbackIdentity: string) => {
    const nativeId = typeof limit.limitId === 'string' && limit.limitId.length > 0 ? limit.limitId : fallbackIdentity;
    if (!limitsByIdentity.has(nativeId)) limitsByIdentity.set(nativeId, limit);
  };
  addLimit(base, 'base');
  for (const [key, value] of Object.entries(byLimit)) {
    const limit = record(value);
    if (limit) addLimit(limit, key);
  }
  const windows = [...limitsByIdentity.entries()].flatMap(([limitId, limit]) => {
    const rows: ProviderQuota['windows'][number][] = [];
    for (const key of ['primary', 'secondary'] as const) {
      const detail = record(limit[key]);
      if (!detail) continue;
      const usedPercent = finite(detail.usedPercent);
      const remainingFraction = usedPercent !== null && usedPercent >= 0 && usedPercent <= 100
        ? (100 - usedPercent) / 100 : null;
      const windowMinutes = finite(detail.windowDurationMins);
      const resetsAt = epochIso(detail.resetsAt);
      rows.push({
        id: `${limitId}:${key}`,
        windowMinutes: windowMinutes !== null && windowMinutes >= 0 ? windowMinutes : null,
        observedAt: fetchedAt,
        resetsAt,
        remainingFraction,
        remainingUnits: null,
        unit: null,
        binding: true,
        source: 'codex-app-server:account/rateLimits/read',
      });
    }
    return rows;
  });
  const creditData = record(response?.rateLimitResetCredits);
  const availableCountValue = finite(creditData?.availableCount);
  const resetCreditsAvailableCount = availableCountValue !== null && Number.isInteger(availableCountValue) && availableCountValue >= 0
    ? availableCountValue : null;
  const credits = Array.isArray(creditData?.credits) ? creditData.credits : [];
  const resetCredits = credits.flatMap((value) => {
    const credit = record(value);
    const resetType = typeof credit?.resetType === 'string' ? credit.resetType : null;
    const expiresAt = epochIso(credit?.expiresAt);
    const status = credit?.status;
    if (!resetType || !expiresAt || !['available', 'redeemed', 'expired', 'unavailable'].includes(String(status))) return [];
    const id = typeof credit?.id === 'string' ? credit.id : undefined;
    return [{ ...(id ? { id } : {}), resetType, expiresAt, status: status === 'available' ? 'available' as const : 'unavailable' as const }];
  });
  const normalResetsAt = windows.map((window) => window.resetsAt).filter((value): value is string => value !== null);
  const provider: ProviderQuota = {
    provider: 'codex',
    observedAt: fetchedAt,
    source: 'codex-app-server:account/rateLimits/read',
    windows,
    normalResetsAt,
    resetCredits,
    resetCreditsAvailableCount,
    resetCreditsKnown: resetCreditsAvailableCount !== null,
    cooldownUntil: null,
    telemetryAvailable: true,
  };
  return { fetchedAt, providers: [provider] };
}

function consumeOutcome(value: unknown): ResetCreditConsumeResult['outcome'] {
  const response = record(value);
  if (!response || Object.keys(response).length !== 1 || !Object.hasOwn(response, 'outcome')) {
    throw new Error('Codex app-server reset-credit response did not match the installed outcome-only schema');
  }
  const candidate = response.outcome;
  if (candidate === 'reset' || candidate === 'alreadyRedeemed' || candidate === 'nothingToReset' || candidate === 'noCredit') {
    return candidate;
  }
  throw new Error('Codex app-server returned an unknown reset-credit outcome');
}

function appServerError(message: unknown): Error {
  const response = record(message);
  const error = record(response?.error);
  const code = typeof error?.code === 'number' || typeof error?.code === 'string' ? String(error.code) : 'unknown';
  // Omit server message/data: those fields are not needed and may contain account data.
  return new Error(`Codex app-server request failed (code ${code})`);
}

function spawnSession(executable = 'codex', timeoutMs = 30_000): Promise<CodexAppServerSession> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'], detached: true,
    });
    const lines = createInterface({ input: child.stdout! });
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    let nextId = 1;
    let closed = false;
    const failPending = (error: Error) => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
    };
    lines.on('line', (line) => {
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        const object = record(parsed);
        if (!object) return;
        message = object;
      } catch {
        return;
      }
      const id = message.id;
      if (typeof id !== 'number') return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(appServerError(message));
      else waiter.resolve(message.result);
    });
    child.once('error', (error) => failPending(new Error(`Unable to start Codex app-server: ${error.name}`)));
    child.once('exit', (code) => {
      if (!closed) failPending(new Error(`Codex app-server exited before response (code ${code ?? 'unknown'})`));
    });
    const request = (method: string, params: Record<string, unknown>) => new Promise<unknown>((requestResolve, requestReject) => {
      if (closed || !child.stdin?.writable) return requestReject(new Error('Codex app-server is not writable'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        requestReject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve: requestResolve, reject: requestReject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) {
          const waiter = pending.get(id);
          if (waiter) {
            pending.delete(id);
            clearTimeout(waiter.timer);
            waiter.reject(new Error(`Codex app-server write failed: ${method}`));
          }
        }
      });
    });
    const session: CodexAppServerSession = {
      request,
      notify(method, params) {
        if (!closed && child.stdin?.writable) child.stdin.write(`${JSON.stringify({ method, params })}\n`);
      },
      async close() {
        if (closed) return;
        closed = true;
        failPending(new Error('Codex app-server session closed'));
        lines.close();
        try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* Already exited. */ }
        await new Promise<void>((done) => {
          const timer = setTimeout(() => {
            try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already exited. */ }
            done();
          }, 1_000);
          child.once('exit', () => { clearTimeout(timer); done(); });
        });
      },
    };
    void (async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'cq-settings-campaign', version: '1.0.0' },
          capabilities: { experimentalApi: true },
        });
        session.notify('initialized', {});
        resolve(session);
      } catch (error) {
        await session.close();
        reject(error);
      }
    })();
  });
}

/** Uses only initialize, account/rateLimits/read, and explicit consume calls. */
export class CodexAppServerQuotaAdapter implements QuotaSource, SupportedResetCreditConsumer {
  readonly route = 'account/rateLimitResetCredit/consume' as const;
  private readonly sessionFactory: CodexAppServerSessionFactory;
  private readonly clock: () => number;

  constructor(
    sessionFactory: CodexAppServerSessionFactory = () => spawnSession(),
    clock: () => number = Date.now,
  ) {
    this.sessionFactory = sessionFactory;
    this.clock = clock;
  }

  async refresh(): Promise<QuotaSnapshot> {
    return this.readRateLimits();
  }

  async readRateLimits(): Promise<QuotaSnapshot> {
    const raw = await this.withSession((session) => session.request('account/rateLimits/read', {}));
    return nativeQuotaSnapshot(raw, new Date(this.clock()).toISOString());
  }

  async consume(request: ResetCreditConsumeRequest): Promise<ResetCreditConsumeResult> {
    if (request.resetType !== 'codexRateLimits') throw new Error('Unsupported native Codex reset type');
    // The native endpoint has no resetType parameter. Validate it against the
    // authenticated account read, then preserve the opaque ID privately.
    const beforeQuota = await this.readRateLimits();
    if (!inspectQuotaFreshness(beforeQuota, this.clock()).fresh) {
      throw new Error('Codex reset consume requires fresh authenticated rate-limit telemetry');
    }
    const credits = beforeQuota.providers.flatMap((provider) => provider.resetCredits);
    const selected = credits.find((credit) => credit.status === 'available'
      && credit.resetType === request.resetType
      && (request.creditId === undefined || credit.id === request.creditId));
    if (!selected?.id) throw new Error('No authenticated available reset credit matches the requested native reset type and credit ID');
    const params: Record<string, unknown> = {
      idempotencyKey: request.idempotencyKey,
      creditId: selected.id,
    };
    const raw = await this.withSession((session) => session.request('account/rateLimitResetCredit/consume', params));
    return {
      outcome: consumeOutcome(raw),
      // This is the ID selected from the authenticated pre-action read, not an
      // ID returned by the consume endpoint (which has no such response field).
      resetType: request.resetType,
      creditId: selected.id,
      beforeAllowance: null,
      afterAllowance: null,
      observedAt: new Date(this.clock()).toISOString(),
      beforeQuota,
    };
  }

  private async withSession<T>(action: (session: CodexAppServerSession) => Promise<T>): Promise<T> {
    const session = await this.sessionFactory();
    try {
      return await action(session);
    } finally {
      await session.close();
    }
  }
}
