/** Crash-safe append-only campaign queue and reset journal for one local workspace. */
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canTransition } from './scheduler.ts';
import type {
  AssignmentEvent,
  AtomicReservationRequest,
  CampaignAssignment,
  CampaignQueueStore,
  PairedBlock,
} from './scheduler.ts';
import type { ResetCreditConsumeResult, ResetJournal, ResetJournalEntry } from './quota.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FileMutex {
  constructor(private readonly lockPath: string, private readonly timeoutMs = 10_000) {}

  async run<T>(action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    await mkdir(dirname(this.lockPath), { recursive: true });
    while (true) {
      try {
        await mkdir(this.lockPath);
        await writeFile(join(this.lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), { flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          await rm(this.lockPath, { recursive: true, force: true });
          throw error;
        }
        await this.clearAbandonedLock();
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for durable campaign lock ${this.lockPath}`);
        await delay(15);
      }
    }
    try {
      return await action();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async clearAbandonedLock() {
    try {
      const owner = JSON.parse(await readFile(join(this.lockPath, 'owner.json'), 'utf8')) as { pid?: number };
      if (Number.isInteger(owner.pid) && owner.pid! > 0) {
        try {
          process.kill(owner.pid!, 0);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
        }
      }
      const info = await stat(this.lockPath);
      if (Date.now() - info.mtimeMs > 1_000) await rm(this.lockPath, { recursive: true, force: true });
    } catch {
      // A newly created lock can be observed before owner.json is written.
    }
  }
}

async function readLines<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function appendDurable(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'a');
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function projectAssignments(
  created: readonly CampaignAssignment[],
  events: readonly AssignmentEvent[],
): Map<string, CampaignAssignment> {
  const assignments = new Map<string, CampaignAssignment>();
  for (const assignment of created) {
    if (assignments.has(assignment.id)) throw new Error(`Duplicate immutable assignment ${assignment.id}`);
    assignments.set(assignment.id, assignment);
  }
  for (const event of events) {
    const current = assignments.get(event.assignmentId);
    if (!current) throw new Error(`Event references unknown assignment ${event.assignmentId}`);
    if (event.from !== 'new' && current.state !== event.from) {
      throw new Error(`Invalid persisted transition for ${event.assignmentId}: expected ${event.from}, found ${current.state}`);
    }
    if (event.from !== 'new' && !canTransition(event.from, event.to)) {
      throw new Error(`Invalid persisted transition for ${event.assignmentId}: ${event.from} -> ${event.to}`);
    }
    if (event.from === 'new' && (event.to !== 'queued' || events.some((prior) => prior.assignmentId === event.assignmentId && prior.from === 'new' && prior.id !== event.id))) {
      throw new Error('New assignment can enter queued state only once');
    }
    const priorAttempts = current.attemptIds ?? [current.attemptId];
    const retrying = event.attemptId !== undefined && event.attemptId !== current.attemptId;
    if (retrying && (event.to !== 'queued' || !['quarantined', 'interrupted'].includes(event.from)
      || priorAttempts.includes(event.attemptId!))) {
      throw new Error(`Invalid attempt retry event for ${event.assignmentId}`);
    }
    if (['quarantined', 'interrupted'].includes(event.from) && event.to === 'queued' && !retrying) {
      throw new Error(`Terminal attempt requires a new attempt ID for ${event.assignmentId}`);
    }
    if (!retrying && event.attemptId !== undefined && event.attemptId !== current.attemptId) {
      throw new Error(`Attempt ID changed outside a retry event for ${event.assignmentId}`);
    }
    const history = current.reservationHistory ?? (current.reservation ? [current.reservation] : []);
    assignments.set(event.assignmentId, {
      ...current,
      state: event.to,
      ...(event.reservation ? { reservation: event.reservation, reservationHistory: history.some((item) => item.id === event.reservation!.id)
        ? history : [...history, event.reservation] } : {}),
      ...(retrying ? { attemptId: event.attemptId, attemptIds: [...priorAttempts, event.attemptId!] } : {}),
      ...(event.clearReservation ? { reservation: undefined } : {}),
      ...(event.artifactRef ? { completedArtifact: event.artifactRef, completedAt: event.at } : {}),
      ...(event.quarantine ? { quarantine: event.quarantine } : {}),
      ...(event.cancellation ? { cancellation: event.cancellation } : {}),
    });
  }
  return assignments;
}

export class FileCampaignQueueStore implements CampaignQueueStore {
  private readonly mutex: FileMutex;
  private readonly assignmentLog: string;
  private readonly eventLog: string;
  private readonly pairedBlockLog: string;

  constructor(private readonly directory: string, lockTimeoutMs = 10_000) {
    this.mutex = new FileMutex(join(directory, '.queue-lock'), lockTimeoutMs);
    this.assignmentLog = join(directory, 'assignments.jsonl');
    this.eventLog = join(directory, 'assignment-events.jsonl');
    this.pairedBlockLog = join(directory, 'paired-blocks.jsonl');
  }

  async listAssignments(): Promise<readonly CampaignAssignment[]> {
    await mkdir(this.directory, { recursive: true });
    const assignments = projectAssignments(await readLines<CampaignAssignment>(this.assignmentLog), await readLines<AssignmentEvent>(this.eventLog));
    return [...assignments.values()];
  }

  async listPairedBlocks(): Promise<readonly PairedBlock[]> {
    await mkdir(this.directory, { recursive: true });
    return readLines<PairedBlock>(this.pairedBlockLog);
  }

  async createPairedBlock(block: PairedBlock): Promise<void> {
    if (!block.id || block.assignmentIds.length < 2 || new Set(block.assignmentIds).size !== block.assignmentIds.length) {
      throw new Error('Paired block needs an ID and at least two distinct assignments');
    }
    await this.mutex.run(async () => {
      const blocks = await readLines<PairedBlock>(this.pairedBlockLog);
      if (blocks.some((prior) => prior.id === block.id)) throw new Error(`Immutable paired block already exists: ${block.id}`);
      await appendDurable(this.pairedBlockLog, block);
    });
  }

  async createAssignment(assignment: CampaignAssignment): Promise<void> {
    await this.mutex.run(async () => {
      const created = await readLines<CampaignAssignment>(this.assignmentLog);
      if (created.some((prior) => prior.id === assignment.id)) throw new Error(`Immutable assignment already exists: ${assignment.id}`);
      await appendDurable(this.assignmentLog, assignment);
    });
  }

  async appendEvent(event: AssignmentEvent): Promise<void> {
    await this.mutex.run(async () => {
      const events = await readLines<AssignmentEvent>(this.eventLog);
      const current = projectAssignments(await readLines<CampaignAssignment>(this.assignmentLog), events);
      const assignment = current.get(event.assignmentId);
      if (!assignment || (event.from !== 'new' && assignment.state !== event.from)
        || (event.from !== 'new' && !canTransition(event.from, event.to))
        || events.some((prior) => prior.id === event.id)
        || (event.from === 'new' && events.some((prior) => prior.assignmentId === event.assignmentId && prior.from === 'new'))) {
        throw new Error(`Assignment state changed before event ${event.id}`);
      }
      projectAssignments(await readLines<CampaignAssignment>(this.assignmentLog), [...events, event]);
      await appendDurable(this.eventLog, event);
    });
  }

  async tryReserveIfAvailable(request: AtomicReservationRequest): Promise<boolean> {
    return this.mutex.run(async () => {
      if (request.event.to !== 'reserved' || request.event.assignmentId !== request.assignmentId
        || request.event.reservation?.id !== request.reservation.id
        || !Number.isInteger(request.maxConcurrentPerProvider) || request.maxConcurrentPerProvider < 1) {
        throw new Error('Invalid atomic reservation request');
      }
      for (const claim of request.reservation.windowClaims) {
        if (!claim.windowId || !claim.unit || !Number.isFinite(claim.amount) || claim.amount < 0
          || (claim.unit === 'fraction' && (claim.amount > 1 || !claim.calibrationId))) {
          throw new Error('Atomic reservation contains invalid usage claims');
        }
      }
      const current = projectAssignments(await readLines<CampaignAssignment>(this.assignmentLog), await readLines<AssignmentEvent>(this.eventLog));
      const assignment = current.get(request.assignmentId);
      if (!assignment || assignment.state !== request.expectedState || request.event.attemptId !== assignment.attemptId) return false;
      const active = [...current.values()].filter((candidate) => candidate.reservation?.quotaProvider === request.quotaProvider
        && (candidate.state === 'reserved' || candidate.state === 'running'));
      if (active.length >= request.maxConcurrentPerProvider) return false;

      for (const limit of request.bindingCapacityLimits) {
        const reserved = active.flatMap((candidate) => candidate.reservation?.windowClaims ?? [])
          .filter((claim) => claim.windowId === limit.windowId && claim.unit === limit.unit)
          .reduce((sum, claim) => sum + claim.amount, 0);
        const requested = request.reservation.windowClaims.find((claim) => claim.windowId === limit.windowId && claim.unit === limit.unit);
        if (!requested || reserved + requested.amount > limit.amount) return false;
      }

      if (request.reservation.diagnostic) {
        const diagnostics = [...current.values()].flatMap((candidate) => candidate.reservationHistory
          ?? (candidate.reservation ? [candidate.reservation] : []))
          .filter((reservation) => reservation.quotaProvider === request.quotaProvider && reservation.diagnostic);
        const limits = request.diagnosticLimits;
        if (!limits || diagnostics.length >= limits.maxAttempts) return false;
        const used = diagnostics.reduce((sum, reservation) => sum + (reservation.estimatedUsageUnits ?? 0), 0);
        if (used + (request.reservation.estimatedUsageUnits ?? 0) > limits.maxEstimatedUnits) return false;
      }

      await appendDurable(this.eventLog, request.event);
      return true;
    });
  }
}

export class FileResetJournal implements ResetJournal {
  private readonly mutex: FileMutex;
  private readonly journalPath: string;

  constructor(private readonly directory: string, lockTimeoutMs = 10_000) {
    this.mutex = new FileMutex(join(directory, '.reset-journal-lock'), lockTimeoutMs);
    this.journalPath = join(directory, 'reset-journal.jsonl');
  }

  async get(idempotencyKey: string): Promise<ResetJournalEntry | null> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readLines<ResetJournalEntry>(this.journalPath);
    return entries.filter((entry) => entry.idempotencyKey === idempotencyKey).at(-1) ?? null;
  }

  async create(entry: ResetJournalEntry): Promise<void> {
    if (entry.state !== 'prepared' || entry.result) throw new Error('Reset journal entries must begin prepared');
    await this.mutex.run(async () => {
      const entries = await readLines<ResetJournalEntry>(this.journalPath);
      if (entries.some((prior) => prior.idempotencyKey === entry.idempotencyKey)) {
        throw new Error(`Reset journal key already exists: ${entry.idempotencyKey}`);
      }
      await appendDurable(this.journalPath, entry);
    });
  }

  async complete(idempotencyKey: string, result: ResetCreditConsumeResult): Promise<void> {
    await this.mutex.run(async () => {
      const entries = await readLines<ResetJournalEntry>(this.journalPath);
      const prior = entries.filter((entry) => entry.idempotencyKey === idempotencyKey).at(-1);
      if (!prior || prior.state !== 'prepared') throw new Error(`No prepared reset journal entry for ${idempotencyKey}`);
      if (result.resetType !== prior.resetType || (prior.creditId !== undefined && result.creditId !== prior.creditId)) {
        throw new Error('Reset result does not match its prepared journal request');
      }
      await appendDurable(this.journalPath, { ...prior, state: 'completed', result });
    });
  }
}
