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
  const usage: ParsedEvents['usage'] = {};
  const seenTurns = new Set<string>();
  const seenMessages = new Set<string>();
  for (const value of events) {
    if (!record(value)) continue;
    const event = value;
    if (transport === 'codex') {
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === 'turn.completed' || type === 'turn_complete') {
        const stats = record(event.usage) ? event.usage : record(event.info) && record(event.info.usage) ? event.info.usage : null;
        if (stats) {
          const id = stableId(event.turn_id ?? event.turnId ?? event.id, stats);
          if (!seenTurns.has(id)) {
            seenTurns.add(id);
            const last = record(stats.last_token_usage) ? stats.last_token_usage : stats;
            addUsage(usage, parseCodexUsage(last));
            const totalStats = record(stats.total_token_usage) ? stats.total_token_usage : null;
            if (totalStats) setReportedTotal(usage, totalStats.total_tokens ?? totalStats.totalTokens);
            else {
              const turnTotal = last.total_tokens ?? last.totalTokens;
              if (typeof turnTotal === 'number' && Number.isFinite(turnTotal) && turnTotal >= 0) {
                usage.tokenTotal = (usage.tokenTotal ?? 0) + turnTotal;
              }
            }
          }
        }
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
      // Pi's installed print-mode serializer emits authoritative assistant
      // messages at message_end; agent_end repeats its message list and is
      // intentionally ignored. Each AssistantMessage.usage is per response,
      // including tool-call and retry responses, so sum distinct messages.
      if (event.type === 'message_end' && message?.role === 'assistant') {
        const key = stableId(message.id ?? message.responseId, message);
        if (!seenMessages.has(key)) {
          seenMessages.add(key);
          const content = Array.isArray(message.content) ? message.content : [];
          const messageText = content.filter((block) => record(block) && block.type === 'text' && typeof block.text === 'string')
            .map((block) => (block as Record<string, unknown>).text as string).join('');
          if (messageText) transcript.push(messageText);
          if (message.stopReason === 'stop' && messageText) finalText = messageText;
          if (record(message.usage)) {
            const parsedUsage = parsePiUsage(message.usage);
            addUsage(usage, parsedUsage);
            setReportedTotal(usage, usage.tokenTotal === undefined ? parsedUsage.tokenTotal : usage.tokenTotal + (parsedUsage.tokenTotal ?? 0));
          }
        }
      }
    }
  }
  return { text: transcript.join('\n').trim(), finalText: finalText.trim(), model, usage };
}

export function applyUsageObservation(observation: NativeObservation, parsed: ParsedEvents, source: string): void {
  for (const name of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
    const value = parsed.usage[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      observation.usage.counters[name] = { value, availability: 'observed', source, semantics: name };
    }
  }
  if (typeof parsed.usage.tokenTotal === 'number') {
    observation.usage.tokenTotal = { value: parsed.usage.tokenTotal, availability: 'observed', source };
  }
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
  assign(usage, 'cacheWrite', stats.cache_creation_input_tokens ?? stats.cacheWrite);
  assign(usage, 'reasoning', stats.reasoning_tokens ?? stats.reasoning);
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

function addUsage(target: ParsedEvents['usage'], next: ParsedEvents['usage']): void {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
    if (typeof next[key] === 'number') target[key] = (target[key] ?? 0) + next[key]!;
  }
}

function setReportedTotal(target: ParsedEvents['usage'], value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target.tokenTotal = value;
}

function stableId(value: unknown, fallback: unknown): string {
  if (typeof value === 'string' && value) return value;
  return JSON.stringify(fallback);
}

function assign(target: ParsedEvents['usage'], key: keyof ParsedEvents['usage'], value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target[key] = value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
