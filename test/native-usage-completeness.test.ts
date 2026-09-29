import { describe, expect, it } from 'vitest';
import { applyUsageObservation, parseJsonEventLines } from '../runner/native/events.ts';
import { aggregate, type ResultRow } from '../runner/aggregate.ts';
import { campaignUsage, unavailableObservation } from '../runner/native/observation.ts';

const counters = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokenTotal'] as const;
type Counter = typeof counters[number];
type Usage = Partial<Record<Counter, number>>;
const full: Usage = { input: 10, output: 3, cacheRead: 7, cacheWrite: 0, reasoning: 1, tokenTotal: 13 };
const codexFields = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cached_input_tokens', cacheWrite: 'cache_write_input_tokens', reasoning: 'reasoning_output_tokens', tokenTotal: 'total_tokens' };
const piFields = { input: 'input', output: 'output', cacheRead: 'cacheRead', cacheWrite: 'cacheWrite', reasoning: 'reasoning', tokenTotal: 'totalTokens' };
function wire(usage: Usage, transport: 'codex' | 'pi'): Record<string, number> {
  return Object.fromEntries(Object.entries(usage).map(([name, value]) => [(transport === 'codex' ? codexFields : piFields)[name as Counter], value]));
}
function turn(id: string, usage?: Record<string, unknown>) { return { type: 'turn.completed', turn_id: id, ...(usage ? { usage } : {}) }; }
function message(id: string, usage?: Record<string, unknown>) {
  return { id, role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: id }], ...(usage ? { usage } : {}) };
}
function frame(transport: 'codex' | 'pi', id: string, usage?: Usage) {
  return transport === 'codex' ? turn(id, usage && wire(usage, transport)) : { type: 'message_end', message: message(id, usage && wire(usage, transport)) };
}
function parse(events: unknown[], transport: 'codex' | 'pi') { return parseJsonEventLines(events.map((event) => JSON.stringify(event)).join('\n'), transport); }

for (const transport of ['codex', 'pi'] as const) {
  describe(`${transport} complete usage`, () => {
    it.each(counters)('requires complete %s coverage in the authoritative usage scope', (counter) => {
      const partial = { ...full }; delete partial[counter];
      const usage = parse([frame(transport, 'a', full), frame(transport, 'b', partial)], transport).usage;
      expect(usage[counter]).toBeUndefined();
      for (const other of counters.filter((name) => name !== counter)) expect(usage[other]).toBe(full[other]! * (transport === 'pi' ? 2 : 1));
      const missingFirst = parse([frame(transport, 'a', partial), frame(transport, 'b', full)], transport).usage;
      expect(missingFirst[counter]).toBe(transport === 'codex' ? full[counter] : undefined);
    });
    it('counts frames without usage and never reports a partial aggregate as complete', () => {
      expect(parse([frame(transport, 'a', full), frame(transport, 'b')], transport).usage).toEqual({});
      expect(parse([], transport).usage).toEqual({});
    });
    it('preserves explicit zero, overlapping counters and explicit total without summing them', () => {
      const zeros = Object.fromEntries(counters.map((name) => [name, 0])) as Usage;
      expect(parse([frame(transport, 'zero', zeros)], transport).usage).toEqual(zeros);
      expect(parse([frame(transport, 'a', full), frame(transport, 'b', full)], transport).usage).toEqual(transport === 'codex' ? full : { input: 20, output: 6, cacheRead: 14, cacheWrite: 0, reasoning: 2, tokenTotal: 26 });
      const noTotal = { ...full }; delete noTotal.tokenTotal;
      expect(parse([frame(transport, 'a', noTotal)], transport).usage.tokenTotal).toBeUndefined();
    });
    it('deduplicates exact replayed frames including reordered JSON keys', () => {
      const a = frame(transport, 'a', full); const b = frame(transport, 'b', full);
      expect(parse([a, b, a, b], transport).usage).toEqual(parse([a, b], transport).usage);
      const withoutId = transport === 'codex' ? { type: 'turn.completed', usage: wire(full, transport) } : { type: 'message_end', message: { role: 'assistant', usage: wire(full, transport), timestamp: 1 } };
      const reordered = Object.fromEntries(Object.entries(withoutId).reverse());
      expect(parse([withoutId, reordered], transport).usage).toEqual(full);
    });
    it('keeps conflicting duplicate measurements unknown rather than choosing a convenient frame', () => {
      const changed = { ...full, input: 9 };
      expect(parse([frame(transport, 'a', full), frame(transport, 'a', changed)], transport).usage.input).toBeUndefined();
      const partial = { ...full }; delete partial.tokenTotal;
      expect(parse([frame(transport, 'a', full), frame(transport, 'a', partial)], transport).usage.tokenTotal).toBeUndefined();
    });
    it('rejects invalid measurements and overflowing aggregates', () => {
      expect(parse([frame(transport, 'a', full), frame(transport, 'b', { ...full, input: -1 })], transport).usage.input).toBeUndefined();
      expect(parse([frame(transport, 'a', { ...full, input: Number.MAX_VALUE }), frame(transport, 'b', { ...full, input: Number.MAX_VALUE })], transport).usage.input).toBe(transport === 'codex' ? Number.MAX_VALUE : undefined);
    });
  });
}

describe('usage scope and observation projection', () => {
  it('keeps numeric compatibility tokens separate from nullable authoritative table usage', () => {
    const observation = unavailableObservation({ invocationId: 'i', assignmentId: 'a', stageId: 's', attemptId: 't' }, 'test', null);
    applyUsageObservation(observation, parse([frame('pi', 'a', full), frame('pi', 'missing')], 'pi'), 'pi-message-end');
    const row: ResultRow = { role: 'fixer-worker', suite: 'usage', model: 'fixture', driver: 'fixture',
      outcome: { score: 0, passed: 0, total: 1 }, costUSD: null, wallTimeMs: 1,
      tokens: { input: 123, output: 456, cacheRead: 7 }, observedUsage: campaignUsage(observation),
      runId: 'usage', timestamp: '2026-09-29T00:00:00Z' };
    const cell = aggregate([row])[0]!.cells[0]!;
    expect(cell.tokens.input).toBe(123);
    expect(cell.observedUsage).toEqual(row.observedUsage);
  });
  it('uses the latest Codex cumulative snapshot once and does not add last-request subsets', () => {
    const first = turn('a', { total_token_usage: wire(full, 'codex'), last_token_usage: wire({ input: 2, output: 1, tokenTotal: 3 }, 'codex') });
    const total = { input: 30, output: 6, cacheRead: 20, cacheWrite: 0, reasoning: 2, tokenTotal: 36 };
    const second = turn('b', { total_token_usage: wire(total, 'codex'), last_token_usage: wire(full, 'codex') });
    expect(parse([first, second, first], 'codex').usage).toEqual(total);
    expect(parse([first, second, frame('codex', 'tail', { input: 40, output: 9, cacheRead: 27, cacheWrite: 0, reasoning: 3, tokenTotal: 49 })], 'codex').usage).toEqual({ input: 40, output: 9, cacheRead: 27, cacheWrite: 0, reasoning: 3, tokenTotal: 49 });
  });
  it('does not retain a stale cumulative total or substitute last-request usage for absent aggregate counters', () => {
    const partial = { ...full }; delete partial.tokenTotal; delete partial.input;
    expect(parse([turn('a', { total_token_usage: wire(full, 'codex') }), turn('b', { total_token_usage: wire(partial, 'codex'), last_token_usage: wire(full, 'codex') })], 'codex').usage).toEqual(partial);
    expect(parse([turn('last-only', { last_token_usage: wire(full, 'codex') })], 'codex').usage).toEqual({});
  });
  it('allows explicit cumulative coverage of an earlier missing frame but keeps subsequent missing counters unknown', () => {
    const cumulative = turn('b', { total_token_usage: wire(full, 'codex') });
    expect(parse([turn('a'), cumulative], 'codex').usage).toEqual(full);
    expect(parse([cumulative, turn('c')], 'codex').usage).toEqual({});
  });
  it('reconciles Pi agent_end message lists with assistant events without double counting', () => {
    const a = message('a', wire(full, 'pi')); const b = message('b', wire(full, 'pi'));
    const usage = parse([{ type: 'message_end', message: a }, { type: 'agent_end', messages: [a, b, { role: 'toolResult' }, { role: 'user' }] }, { type: 'message_end', message: b }], 'pi').usage;
    expect(usage).toEqual({ input: 20, output: 6, cacheRead: 14, cacheWrite: 0, reasoning: 2, tokenTotal: 26 });
    expect(parse([{ type: 'agent_end', messages: [a, message('missing')] }], 'pi').usage).toEqual({});
  });
  it('keeps an unfinished or failed Codex turn unknown after an earlier measured turn', () => {
    expect(parse([frame('codex', 'a', full), { type: 'turn.started' }], 'codex').usage).toEqual({});
    expect(parse([frame('codex', 'a', full), { type: 'turn.started' }, frame('codex', 'a', full)], 'codex').usage).toEqual({});
    expect(parse([frame('codex', 'a', full), { type: 'turn.failed', turn_id: 'b' }], 'codex').usage).toEqual({});
  });
  it('deduplicates no-ID Pi message lists without merging distinct equal-usage responses', () => {
    const a = { role: 'assistant', timestamp: 1, usage: wire(full, 'pi') };
    const b = { ...a, timestamp: 2 };
    expect(parse([{ type: 'message_end', message: a }, { type: 'message_end', message: b }, { type: 'agent_end', messages: [a, b] }], 'pi').usage).toEqual({ input: 20, output: 6, cacheRead: 14, cacheWrite: 0, reasoning: 2, tokenTotal: 26 });
  });
  it('ignores Pi top-level usage without a defined scope and excludes non-assistant messages', () => {
    expect(parse([{ type: 'agent_end', usage: wire(full, 'pi'), messages: [{ role: 'user', usage: wire(full, 'pi') }, { role: 'toolResult', usage: wire(full, 'pi') }] }], 'pi').usage).toEqual({});
  });
  it('projects unknown counters as null, clears stale values, and preserves inclusion/source semantics', () => {
    const observation = unavailableObservation({ invocationId: 'i', assignmentId: 'a', stageId: 's', attemptId: 't' }, 'test', null);
    observation.usage.inclusion.cache = 'included in input';
    observation.usage.inclusion.reasoning = 'included in output';
    applyUsageObservation(observation, parse([frame('pi', 'a', full)], 'pi'), 'pi-message-end');
    expect(observation.usage.tokenTotal).toMatchObject({ value: 13, source: 'pi-message-end', semantics: 'authoritative-total' });
    applyUsageObservation(observation, parse([frame('pi', 'a', full), frame('pi', 'missing')], 'pi'), 'pi-message-end');
    expect(campaignUsage(observation)).toEqual({ input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, tokenTotal: null, complete: false });
    expect(observation.usage.inclusion).toMatchObject({ cache: 'included in input', reasoning: 'included in output' });
  });
});
