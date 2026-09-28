import type { NativeObservation } from './observation.ts';

export interface ParsedEvents {
  text: string;
  model: string | null;
  usage: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning', number>>;
}

/** Tolerant parsers preserve unknown frames while extracting documented event fields. */
export function parseJsonEventLines(raw: string, transport: 'codex' | 'pi'): ParsedEvents {
  const events: unknown[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed) as unknown); } catch { /* non-event diagnostic line */ }
  }
  const texts: string[] = [];
  let model: string | null = null;
  const usage: ParsedEvents['usage'] = {};
  for (const value of events) {
    if (!record(value)) continue;
    const event = value;
    if (transport === 'codex') parseCodexEvent(event, texts, (x) => { model = x; }, usage);
    else parsePiEvent(event, texts, (x) => { model = x; }, usage);
  }
  return { text: texts.join('\n').trim(), model, usage };
}

export function applyUsageObservation(observation: NativeObservation, parsed: ParsedEvents, source: string): void {
  for (const name of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
    const value = parsed.usage[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      observation.usage.counters[name] = { value, availability: 'observed', source, semantics: name };
    }
  }
  const { input, output, cacheRead, cacheWrite } = parsed.usage;
  if ([input, output, cacheRead, cacheWrite].every((x) => typeof x === 'number')) {
    observation.usage.tokenTotal = {
      value: input! + output! + cacheRead! + cacheWrite!,
      availability: 'observed', source,
    };
  }
  if (parsed.model) observation.model.observed = { value: parsed.model, source, status: 'observed' };
}

export function toStructuredOutput(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function parseCodexEvent(
  event: Record<string, unknown>, texts: string[], setModel: (model: string) => void,
  usage: ParsedEvents['usage'],
): void {
  if (typeof event.model === 'string' && event.model) setModel(event.model);
  const item = record(event.item) ? event.item : null;
  if (item && (item.type === 'agent_message' || item.type === 'assistant_message') && typeof item.text === 'string') texts.push(item.text);
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'turn.completed' || type === 'turn_complete') {
    const stats = record(event.usage) ? event.usage : record(event.info) && record(event.info.usage) ? event.info.usage : null;
    if (stats) {
      assign(usage, 'input', stats.input_tokens ?? stats.input);
      assign(usage, 'output', stats.output_tokens ?? stats.output);
      assign(usage, 'cacheRead', stats.cached_input_tokens ?? stats.cache_read_input_tokens ?? stats.cacheRead);
      assign(usage, 'cacheWrite', stats.cache_creation_input_tokens ?? stats.cacheWrite);
      assign(usage, 'reasoning', stats.reasoning_tokens ?? stats.reasoning);
    }
  }
}

function parsePiEvent(
  event: Record<string, unknown>, texts: string[], setModel: (model: string) => void,
  usage: ParsedEvents['usage'],
): void {
  const message = record(event.message) ? event.message : null;
  const eventModel = event.model ?? message?.model;
  if (typeof eventModel === 'string' && eventModel) setModel(eventModel);
  if (message && message.role === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) if (record(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    const messageUsage = record(message.usage) ? message.usage : null;
    if (messageUsage) readPiUsage(messageUsage, usage);
  }
  const data = record(event.data) ? event.data : event;
  if (record(data.usage)) readPiUsage(data.usage, usage);
  if (typeof data.text === 'string' && (event.type === 'message_end' || event.type === 'text')) texts.push(data.text);
}

function readPiUsage(stats: Record<string, unknown>, usage: ParsedEvents['usage']): void {
  assign(usage, 'input', stats.input ?? stats.inputTokens);
  assign(usage, 'output', stats.output ?? stats.outputTokens);
  assign(usage, 'cacheRead', stats.cacheRead ?? stats.cacheReadTokens);
  assign(usage, 'cacheWrite', stats.cacheWrite ?? stats.cacheWriteTokens);
  assign(usage, 'reasoning', stats.reasoning ?? stats.reasoningTokens);
}

function assign(target: ParsedEvents['usage'], key: keyof ParsedEvents['usage'], value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target[key] = value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
