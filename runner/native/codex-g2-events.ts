/** Decode Codex JSONL command_execution items without interpreting model text. */
import { Buffer } from 'node:buffer';
import type { G2ToolKind, NativeToolTraceEvent } from './g2-harness.ts';

export interface CodexCollectedEventFrame {
  /** Parsed Codex JSON event, or one exact JSON line from stdout. */
  frame: unknown;
  /** Monotonic ordinal assigned by the trusted native stdout collector. Gaps are allowed. */
  collectorSequence: number;
  /** Timestamp recorded by the trusted native stdout collector when this line arrived. */
  collectedAt: string;
}

export interface CodexShellEventDecode {
  toolPhase: { state: 'complete' | 'unavailable'; itemCount: number };
  decoderFailures: readonly string[];
  toolTrace: NativeToolTraceEvent[];
  /** No other tool family is inferred from shell use or from CLI help. */
  channelCoverage: Record<G2ToolKind, 'observed' | 'unobserved'>;
}

interface CommandItem {
  itemId: string;
  phase: 'start' | 'result';
  command: string;
  at: string;
  collectorSequence: number;
  status?: string;
  exitCode?: number | null;
  aggregatedOutput?: string;
}

/**
 * Pure decoder for the observed Codex exec JSONL shell event shape. Collector
 * order and time are supplied by the caller; invocation terminal state is not
 * accepted here, so a completed tool can coexist with a later invocation timeout.
 */
export function decodeCodexShellEventFrames(input: {
  invocationId: string;
  frames: readonly CodexCollectedEventFrame[];
}): CodexShellEventDecode {
  const failures: string[] = [];
  const starts = new Map<string, CommandItem>();
  const results = new Map<string, CommandItem>();
  const toolTrace: NativeToolTraceEvent[] = [];
  let previousSequence = -1;
  let previousTime = Number.NEGATIVE_INFINITY;
  let sawCommandExecution = false;

  if (!input.invocationId.trim()) failures.push('invocation-id-missing');
  for (const collected of input.frames) {
    const collectedTime = Date.parse(collected.collectedAt);
    if (!Number.isInteger(collected.collectorSequence) || collected.collectorSequence < 0 || collected.collectorSequence <= previousSequence) {
      failures.push('collector-sequence-invalid');
    }
    if (!Number.isFinite(collectedTime)) failures.push('collector-time-invalid');
    else if (collectedTime < previousTime) failures.push('collector-time-order-invalid');
    previousSequence = collected.collectorSequence;
    previousTime = collectedTime;

    const event = parseEvent(collected.frame);
    if (!event) {
      failures.push('event-json-invalid');
      continue;
    }
    if (event.type !== 'item.started' && event.type !== 'item.completed') continue;
    if (!isRecord(event.item) || event.item.type !== 'command_execution') continue;
    sawCommandExecution = true;
    const item = event.item;
    if (typeof item.id !== 'string' || !item.id.trim() || typeof item.command !== 'string' || !item.command.trim()) {
      failures.push('command-item-id-or-command-missing');
      continue;
    }
    const phase = event.type === 'item.started' ? 'start' : 'result';
    const destination = phase === 'start' ? starts : results;
    if (destination.has(item.id)) failures.push(phase === 'start' ? 'duplicate-command-start' : 'duplicate-command-result');
    const record: CommandItem = {
      itemId: item.id, phase, command: item.command, at: collected.collectedAt,
      collectorSequence: collected.collectorSequence,
    };
    if (typeof item.status === 'string') record.status = item.status;
    else failures.push(phase === 'start' ? 'command-start-status-missing' : 'command-result-status-missing');
    if (phase === 'start') {
      if (!Object.hasOwn(item, 'exit_code')) failures.push('command-start-exit-code-missing');
      else if (item.exit_code !== null) failures.push('command-start-exit-code-not-null');
      else record.exitCode = null;
      if (typeof item.aggregated_output !== 'string') failures.push('command-start-output-missing');
    } else {
      if (!Object.hasOwn(item, 'exit_code')) {
        failures.push('command-result-exit-code-invalid');
      } else if (item.exit_code === null) {
        record.exitCode = null;
        failures.push('command-result-exit-code-invalid');
      } else if (typeof item.exit_code !== 'number' || !Number.isInteger(item.exit_code) || item.exit_code < 0 || item.exit_code > 255) {
        failures.push('command-result-exit-code-invalid');
      } else record.exitCode = item.exit_code;
      if (typeof item.aggregated_output !== 'string') failures.push('command-result-output-missing');
      else record.aggregatedOutput = item.aggregated_output;
    }
    destination.set(item.id, record);
    toolTrace.push(toTraceEvent(input.invocationId, record));
  }

  if (!sawCommandExecution) failures.push('native-shell-channel-unobserved');
  if (starts.size !== results.size || [...starts.keys()].some((itemId) => !results.has(itemId)) || [...results.keys()].some((itemId) => !starts.has(itemId))) {
    failures.push('unmatched-command-start-result');
  }
  for (const [itemId, start] of starts) {
    const result = results.get(itemId);
    if (!result) continue;
    if (result.collectorSequence <= start.collectorSequence) failures.push('command-result-before-start');
    if (Date.parse(result.at) < Date.parse(start.at)) failures.push('command-result-before-start');
    if (result.command !== start.command) failures.push('command-item-command-mismatch');
    if (start.status !== 'in_progress' || start.exitCode !== null) failures.push('command-start-state-invalid');
    if (!['completed', 'failed'].includes(result.status ?? '') || result.exitCode === undefined) failures.push('command-result-terminal-unavailable');
  }

  const count = results.size;
  const decoderFailures = [...new Set(failures)];
  return {
    toolPhase: { state: sawCommandExecution && decoderFailures.length === 0 && count > 0 ? 'complete' : 'unavailable', itemCount: count },
    decoderFailures,
    toolTrace,
    channelCoverage: { read: 'unobserved', search: 'unobserved', shell: sawCommandExecution ? 'observed' : 'unobserved', http: 'unobserved', config: 'unobserved' },
  };
}

function toTraceEvent(invocationId: string, item: CommandItem): NativeToolTraceEvent {
  const common = {
    eventId: `${item.itemId}:${item.phase}`, invocationId, collectorSequence: item.collectorSequence,
    phase: item.phase, kind: 'shell' as const, targetOrCommand: item.command, correlationId: item.itemId, at: item.at,
    ...(item.status === undefined ? {} : { toolStatus: item.status }),
    ...(item.exitCode === undefined ? {} : { toolExitCode: item.exitCode }),
  };
  if (item.phase === 'start') return common;
  const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
  const successful = item.status === 'completed' && exitCode === 0;
  return {
    ...common,
    outputSource: item.aggregatedOutput === undefined ? undefined : 'aggregated_output',
    ...(item.aggregatedOutput === undefined ? {} : { stdout: Buffer.from(item.aggregatedOutput, 'utf8') }),
    outcome: successful ? { disposition: 'success', exitCode: 0 } :
      exitCode === undefined ? { disposition: 'unavailable' } : { disposition: 'unknown', exitCode },
  };
}

function parseEvent(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return null; }
  }
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
