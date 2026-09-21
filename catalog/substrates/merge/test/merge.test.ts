import { afterEach, describe, expect, it } from 'vitest';
import { merge } from '../src/merge.ts';

// A red run must not leak a polluted prototype into a sibling test.
afterEach(() => {
  Reflect.deleteProperty(Object.prototype, 'polluted');
});

describe('merge', () => {
  it('does not pollute Object.prototype', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    merge({}, payload);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('merges nested plain objects', () => {
    expect(merge({ a: { b: 1 } }, { a: { c: 2 } })).toEqual({ a: { b: 1, c: 2 } });
  });
});
