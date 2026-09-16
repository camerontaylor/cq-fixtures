import { describe, expect, it, vi } from 'vitest';
import { memoize } from '../src/memoize.ts';

// Behavioral spec for memoize: repeated calls with the same argument reuse
// the first result — the underlying function must run once per distinct
// argument, and a repeat call returns that same result.
describe('memoize', () => {
  it('invokes the underlying function once for a repeated argument', () => {
    const underlying = vi.fn((n: number) => n * 2);
    const memoized = memoize(underlying);
    expect(memoized(4)).toBe(8);
    expect(memoized(4)).toBe(8);
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('still calls through for arguments not seen before', () => {
    const underlying = vi.fn((s: string) => s.length);
    const memoized = memoize(underlying);
    expect(memoized('ab')).toBe(2);
    expect(memoized('ab')).toBe(2);
    expect(memoized('abc')).toBe(3);
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it('returns the identical result object on a repeat call', () => {
    const underlying = vi.fn(() => ({ loaded: true }));
    const memoized = memoize(underlying);
    const first = memoized('k');
    const second = memoized('k');
    expect(second).toBe(first);
    expect(underlying).toHaveBeenCalledTimes(1);
  });
});
