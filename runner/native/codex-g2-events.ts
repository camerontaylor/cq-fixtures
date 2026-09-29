/** Decode Codex JSONL command_execution items without interpreting model text. */
import { Buffer } from 'node:buffer';
import type { G2ControlProof, G2ToolErrorCode, G2ToolKind, NativeToolTraceEvent } from './g2-harness.ts';

export interface CodexCollectedEventFrame {
  /** Parsed Codex JSON event, or one exact JSON line from stdout. */
  frame: unknown;
  /** Timestamp recorded by the trusted native stdout collector when this line arrived. */
  collectedAt: string;
}

export interface CodexShellControlEvidence {
  invocationId: string;
  itemId: string;
  /** Supplied only by independent native instrumentation; never parsed from aggregated_output. */
  toolErrorCode?: G2ToolErrorCode;
  controlProof?: G2ControlProof;
}

export interface CodexShellEventDecode {
  toolPhase: { state: 'complete' | 'unavailable'; itemCount: number };
  toolTrace: NativeToolTraceEvent[];
  /** No other tool family is inferred from shell use or from CLI help. */
  channelCoverage: Record<G2ToolKind, 'observed' | 'unobserved'>;
  failures: string[];
}

interface ItemFrame {
  itemId: string;
  phase: 'start' | 'result';
  command: string;
  at: string;
  order: number;
  status?: string;
  exitCode?: number | null;
  aggregatedOutput?: string;
}

/**
 * Pure decoder for the installed Codex exec JSONL shell event shape. It requires
 * caller-supplied collector times and preserves invocation timeout elsewhere;
 * no timestamp or tool status is synthesized here.
 */
export function decodeCodexShellEventFrames(input: {
  invocationId: string;
  frames: readonly CodexCollectedEventFrame[];
  controls?: readonly CodexShellControlEvidence[];
}): CodexShellEventDecode {
  const failures: string[] = [];
  const starts = new Map<string, ItemFrame>();
  const results = new Map<string, ItemFrame>();
  const controls = new Map<string, CodexShellControlEvidence>();
  const toolTrace: NativeToolTraceEvent[] = [];
  let previousCollectedAt = Number.NEGATIVE_INFINITY;
  let sawCommandExecution = false;

  if (!input.invocationId.trim()) failures.push('invocation-id-missing');
  for (const evidence of input.controls ?? []) {
    if (evidence.invocationId !== input.invocationId || !evidence.itemId || controls.has(evidence.itemId)) {
      failures.push('control-evidence-identity-or-duplicate');
      continue;
    }
    if (evidence.toolErrorCode && !['EACCES', 'EPERM', 'ENOENT'].includes(evidence.toolErrorCode)) {
      failures.push('control-error-code-unrecognized');
      continue;
    }
    if (evidence.controlProof && (!['guardian-namespace-absent', 'native-inventory-verified', 'namespace-egress-denied'].includes(evidence.controlProof.kind) || evidence.controlProof.verified !== true)) {
      failures.push('control-proof-unverified');
      continue;
    }
    if (!evidence.toolErrorCode && !evidence.controlProof) {
      failures.push('empty-control-evidence');
      continue;
    }
    controls.set(evidence.itemId, evidence);
  }

  for (const [order, collected] of input.frames.entries()) {
    const collectedTime = Date.parse(collected.collectedAt);
    if (!Number.isFinite(collectedTime)) {
      failures.push('collector-time-invalid');
      continue;
    }
    if (collectedTime < previousCollectedAt) failures.push('collector-frame-order-invalid');
    previousCollectedAt = collectedTime;

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
    if (destination.has(item.id)) {
      failures.push(phase === 'start' ? 'duplicate-command-start' : 'duplicate-command-result');
      continue;
    }
    const record: ItemFrame = { itemId: item.id, phase, command: item.command, at: collected.collectedAt, order };
    if (typeof item.status === 'string' && item.status.trim()) record.status = item.status;
    else failures.push(phase === 'start' ? 'command-start-status-missing' : 'command-result-status-missing');
    if (phase === 'start') {
      if (!Object.hasOwn(item, 'exit_code')) failures.push('command-start-exit-code-missing');
      else if (item.exit_code !== null) failures.push('command-start-exit-code-not-null');
      if (typeof item.aggregated_output !== 'string') failures.push('command-start-output-missing');
    }
    if (phase === 'result') {
      if (!Object.hasOwn(item, 'exit_code')) failures.push('command-result-exit-code-missing');
      else if (item.exit_code !== null && (typeof item.exit_code !== 'number' || !Number.isInteger(item.exit_code) || item.exit_code < 0 || item.exit_code > 255)) {
        failures.push('command-result-exit-code-invalid');
      } else record.exitCode = item.exit_code as number | null;
      if (typeof item.aggregated_output !== 'string') failures.push('command-result-output-missing');
      else record.aggregatedOutput = item.aggregated_output;
    }
    destination.set(item.id, record);
  }

  for (const itemId of controls.keys()) if (!starts.has(itemId) || !results.has(itemId)) failures.push('orphan-control-evidence');
  if (starts.size === 0 && results.size === 0) failures.push('native-shell-channel-unobserved');
  if (starts.size !== results.size || [...starts.keys()].some((itemId) => !results.has(itemId)) || [...results.keys()].some((itemId) => !starts.has(itemId))) {
    failures.push('unmatched-command-start-result');
  }

  for (const [itemId, start] of starts) {
    const result = results.get(itemId);
    if (!result) continue;
    if (result.order <= start.order || Date.parse(result.at) < Date.parse(start.at)) failures.push('command-result-before-start');
    if (result.command !== start.command) failures.push('command-item-command-mismatch');
    if (result.exitCode === undefined || result.exitCode === null || !result.status || !['completed', 'failed'].includes(result.status)) {
      failures.push('command-result-terminal-unavailable');
    }
    const evidence = controls.get(itemId);
    const outcome = deriveOutcome(result, evidence);
    toolTrace.push({
      eventId: `${itemId}:start`, invocationId: input.invocationId, phase: 'start', kind: 'shell',
      targetOrCommand: start.command, correlationId: itemId, at: start.at, toolStatus: start.status,
    });
    toolTrace.push({
      eventId: `${itemId}:result`, invocationId: input.invocationId, phase: 'result', kind: 'shell',
      targetOrCommand: result.command, correlationId: itemId, at: result.at,
      toolStatus: result.status, toolExitCode: result.exitCode,
      outputSource: result.aggregatedOutput === undefined ? undefined : 'aggregated_output',
      ...(result.aggregatedOutput === undefined ? {} : { stdout: Buffer.from(result.aggregatedOutput, 'utf8') }),
      outcome,
    });
  }

  const count = toolTrace.filter((event) => event.phase === 'result' && event.toolExitCode !== null &&
    event.toolExitCode !== undefined && (event.toolStatus === 'completed' || event.toolStatus === 'failed')).length;
  const state = sawCommandExecution && failures.length === 0 && count === starts.size ? 'complete' : 'unavailable';
  return {
    toolPhase: { state, itemCount: count }, toolTrace,
    channelCoverage: { read: 'unobserved', search: 'unobserved', shell: sawCommandExecution ? 'observed' : 'unobserved', http: 'unobserved', config: 'unobserved' },
    failures: [...new Set(failures)],
  };
}

function deriveOutcome(result: ItemFrame, evidence: CodexShellControlEvidence | undefined): NonNullable<NativeToolTraceEvent['outcome']> {
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : undefined;
  if (result.status === 'completed' && exitCode === 0) return { disposition: 'success', exitCode: 0 };
  if (result.status === 'failed' && exitCode !== undefined && exitCode > 0 && evidence?.toolErrorCode) {
    if (evidence.toolErrorCode === 'ENOENT') return { disposition: 'denied', denialKind: 'not-found', exitCode, toolErrorCode: 'ENOENT' };
    return { disposition: 'denied', denialKind: 'filesystem-denied', exitCode, toolErrorCode: evidence.toolErrorCode };
  }
  if (result.status === 'failed' && exitCode !== undefined && exitCode > 0 && evidence?.controlProof?.kind === 'namespace-egress-denied' && evidence.controlProof.verified === true) {
    return { disposition: 'denied', denialKind: 'namespace-denied', exitCode, controlProof: evidence.controlProof };
  }
  if (exitCode === undefined) return { disposition: 'unavailable' };
  return { disposition: 'unknown', exitCode };
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
