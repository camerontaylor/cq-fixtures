import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/parseConfig.ts';

// Behavioral spec for parseConfig: malformed input is a loud, named failure —
// the caller must see an Error whose message mentions "invalid config" —
// never a silently emptied config object.
describe('parseConfig', () => {
  it('throws an "invalid config" error on non-JSON input', () => {
    expect(() => parseConfig('not json')).toThrow(/invalid config/);
  });

  it('throws on an empty payload', () => {
    expect(() => parseConfig('')).toThrow(/invalid config/);
  });

  it('throws on truncated JSON', () => {
    expect(() => parseConfig('{"retries":')).toThrow(/invalid config/);
  });
});
