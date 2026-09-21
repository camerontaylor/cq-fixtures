import { describe, expect, it } from 'vitest';
import { perSuiteTokenCap } from '../runner/budget.ts';

// WB-1.6: the per-suite token cap must scale with suite size. The 2026-09-18
// matrix's flat 200000 per INVOCATION left a 40-case suite ~5k tokens/case
// before the governor gated its tail into honest "no row" absences.
describe('perSuiteTokenCap (WB-1.6)', () => {
  it('multiplies the per-case budget by the dispatched case count', () => {
    expect(perSuiteTokenCap(60_000, 40)).toBe(2_400_000);
    expect(perSuiteTokenCap(60_000, 5)).toBe(300_000);
    expect(perSuiteTokenCap(60_000, 10)).toBe(600_000);
  });

  it('scales monotonically with suite size (the back half no longer vanishes)', () => {
    const micro = perSuiteTokenCap(60_000, 5);
    const breadth = perSuiteTokenCap(60_000, 40);
    expect(breadth).toBeGreaterThan(micro);
    // 40 cases × 60000 is ~60k tokens/case — the retired flat cap gave 5k.
    expect(breadth / 40).toBe(60_000);
  });

  it('adds a non-case reservation on top (the ACP probe never eats case budget)', () => {
    expect(perSuiteTokenCap(60_000, 10, 2_000)).toBe(602_000);
    expect(perSuiteTokenCap(60_000, 10, 0)).toBe(600_000);
    expect(perSuiteTokenCap(60_000, 10)).toBe(600_000);
  });

  it('throws on non-integer, negative, or non-finite inputs (never fails open, I9)', () => {
    expect(() => perSuiteTokenCap(1.5, 10)).toThrow(RangeError);
    expect(() => perSuiteTokenCap(60_000, -1)).toThrow(RangeError);
    expect(() => perSuiteTokenCap(60_000, 1.5)).toThrow(RangeError);
    expect(() => perSuiteTokenCap(60_000, 10, 1.5)).toThrow(RangeError);
    expect(() => perSuiteTokenCap(Number.POSITIVE_INFINITY, 1)).toThrow(RangeError);
    expect(() => perSuiteTokenCap(Number.NaN, 1)).toThrow(RangeError);
  });

  it('saturates an overflowing product/sum at Number.MAX_SAFE_INTEGER (fail closed, not unbounded)', () => {
    // 1e308 would make the governor's cap Infinity and silently unbind the
    // run; the CLI rejects unsafe integers, and this saturates as the
    // second line of defence.
    expect(perSuiteTokenCap(Number.MAX_SAFE_INTEGER, 2)).toBe(Number.MAX_SAFE_INTEGER);
    expect(perSuiteTokenCap(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
