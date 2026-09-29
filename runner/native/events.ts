import type { NativeObservation } from './observation.ts';

export interface ParsedEvents {
  text: string;
  finalText: string;
  model: string | null;
  usage: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'tokenTotal', number>>;
}

/** Tolerant parsers preserve unknown frames while extracting documented event fields. */
export function parseJsonEventLines(raw: string, transport: 'codex' | 'pi'): ParsedEvents {
  const events: unknown[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed) as unknown); } catch { /* non-event diagnostic line */ }
  }
  const transcript: string[] = [];
  let finalText = '';
  let model: string | null = null;
  const frames = new Map<string, UsageFrame>();
  let codexTurn = 0;
  let codexTurnPending = false;
  const retainPiMessage = (message: Record<string, unknown>): void => {
    if (message.role !== 'assistant') return;
    const key = stableId(message.id ?? message.responseId, message);
    const first = !frames.has(key);
    retainFrame(frames, key, { scope: 'response', values: record(message.usage) ? parsePiUsage(message.usage) : {} });
    if (!first) return;
    const content = Array.isArray(message.content) ? message.content : [];
    const messageText = content.filter((block) => record(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => (block as Record<string, unknown>).text as string).join('');
    if (messageText) transcript.push(messageText);
    if (message.stopReason === 'stop' && messageText) finalText = messageText;
    if (typeof message.model === 'string' && message.model) model = message.model;
  };
  for (const value of events) {
    if (!record(value)) continue;
    const event = value;
    if (transport === 'codex') {
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === 'turn.started' || type === 'turn_start') {
        codexTurn += 1;
        codexTurnPending = true;
      }
      if (type === 'turn.completed' || type === 'turn_complete' || type === 'turn.failed' || type === 'turn_failed') {
        const stats = record(event.usage) ? event.usage : record(event.info) && record(event.info.usage) ? event.info.usage : null;
        const key = stableId(event.turn_id ?? event.turnId ?? event.id, { turn: codexTurn, event });
        // Codex exec emits cumulative thread totals at turn.completed, not
        // per-response deltas. Nested total_token_usage has the same scope;
        // last_token_usage alone covers only the last request, not the turn.
        const cumulative = stats && ('total_token_usage' in stats
          ? record(stats.total_token_usage) ? stats.total_token_usage : null
          : 'last_token_usage' in stats ? null : stats);
        const replay = frames.has(key);
        retainFrame(frames, key, { scope: 'cumulative', values: cumulative ? parseCodexUsage(cumulative) : {} });
        if (!replay) codexTurnPending = false;
      }
      if ((type === 'item.completed' || type === 'item_complete') && record(event.item) &&
          ['agent_message', 'assistant_message'].includes(String(event.item.type)) && typeof event.item.text === 'string') {
        transcript.push(event.item.text);
        finalText = event.item.text;
      }
      if (typeof event.model === 'string' && event.model) model = event.model;
    } else {
      const message = record(event.message) ? event.message : null;
      const eventModel = event.model ?? message?.model;
      if (typeof eventModel === 'string' && eventModel) model = eventModel;
      if (event.type === 'message_end' && message) retainPiMessage(message);
      // agent_end repeats the current run's messages. Reconcile its assistant
      // list with message_end, filling capture gaps without counting replays.
      // Top-level usage has no established aggregate scope and is not consumed.
      if (event.type === 'agent_end' && Array.isArray(event.messages)) {
        for (const item of event.messages) if (record(item)) retainPiMessage(item);
      }
    }
  }
  const usage = codexTurnPending ? {} : aggregateUsage([...frames.values()], transport);
  return { text: transcript.join('\n').trim(), finalText: finalText.trim(), model, usage };
}

export function applyUsageObservation(observation: NativeObservation, parsed: ParsedEvents, source: string): void {
  for (const name of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
    const value = parsed.usage[name];
    observation.usage.counters[name] = validCounter(value)
      ? { value, availability: 'observed', source, semantics: name }
      : { value: null, availability: observation.usage.counters[name].availability === 'observed' ? 'not-reported' : observation.usage.counters[name].availability, source: null, semantics: name };
  }
  const total = parsed.usage.tokenTotal;
  observation.usage.tokenTotal = validCounter(total)
    ? { value: total, availability: 'observed', source, semantics: 'authoritative-total' }
    : { value: null, availability: observation.usage.tokenTotal.availability === 'observed' ? 'not-reported' : observation.usage.tokenTotal.availability, source: null, semantics: 'unknown' };
  if (parsed.model) observation.model.observed = { value: parsed.model, source, status: 'observed' };
}

export function toStructuredOutput(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function parseCodexUsage(stats: Record<string, unknown>): ParsedEvents['usage'] {
  const usage: ParsedEvents['usage'] = {};
  assign(usage, 'input', stats.input_tokens ?? stats.input);
  assign(usage, 'output', stats.output_tokens ?? stats.output);
  assign(usage, 'cacheRead', stats.cached_input_tokens ?? stats.cache_read_input_tokens ?? stats.cacheRead);
  assign(usage, 'cacheWrite', stats.cache_write_input_tokens ?? stats.cache_creation_input_tokens ?? stats.cacheWrite);
  assign(usage, 'reasoning', stats.reasoning_output_tokens ?? stats.reasoning_tokens ?? stats.reasoning);
  assign(usage, 'tokenTotal', stats.total_tokens ?? stats.totalTokens);
  return usage;
}

function parsePiUsage(stats: Record<string, unknown>): ParsedEvents['usage'] {
  const usage: ParsedEvents['usage'] = {};
  assign(usage, 'input', stats.input ?? stats.inputTokens);
  assign(usage, 'output', stats.output ?? stats.outputTokens);
  assign(usage, 'cacheRead', stats.cacheRead ?? stats.cacheReadTokens);
  assign(usage, 'cacheWrite', stats.cacheWrite ?? stats.cacheWriteTokens);
  assign(usage, 'reasoning', stats.reasoning ?? stats.reasoningTokens);
  assign(usage, 'tokenTotal', stats.totalTokens ?? stats.total_tokens);
  return usage;
}

const counters = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const;
interface UsageFrame {
  scope: 'cumulative' | 'response';
  values: ParsedEvents['usage'];
}

function retainFrame(frames: Map<string, UsageFrame>, key: string, frame: UsageFrame): void {
  const previous = frames.get(key);
  if (!previous) { frames.set(key, frame); return; }
  // A conflicting replay is not a second invocation or permission to select
  // a more convenient measurement. Only counters agreed by both remain known.
  for (const name of counters) {
    if (previous.scope !== frame.scope || previous.values[name] !== frame.values[name]) delete previous.values[name];
  }
}

function aggregateUsage(frames: UsageFrame[], transport: 'codex' | 'pi'): ParsedEvents['usage'] {
  if (frames.length === 0) return {};
  if (transport === 'codex') {
    // Latest unique snapshot covers prior turns. A replay of an older frame
    // never moves it to the end; missing latest fields cannot reuse old totals.
    return { ...frames[frames.length - 1]!.values };
  }
  const usage: ParsedEvents['usage'] = {};
  for (const name of counters) {
    let total = 0;
    let complete = true;
    for (const frame of frames) {
      const value = frame.values[name];
      if (!validCounter(value)) { complete = false; break; }
      total += value;
    }
    if (complete && validCounter(total)) usage[name] = total;
  }
  return usage;
}

function stableId(value: unknown, fallback: unknown): string {
  if (typeof value === 'string' && value.trim()) return `id:${value}`;
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (record(item)) return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    return item;
  };
  return `frame:${JSON.stringify(canonical(fallback))}`;
}

function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assign(target: ParsedEvents['usage'], key: keyof ParsedEvents['usage'], value: unknown): void {
  if (validCounter(value)) target[key] = value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
