import { describe, expect, it } from 'vitest';
import { overlaps } from '../src/slots.ts';
import { isWeekend } from '../src/calendar.ts';
import { sortByStart } from '../src/order.ts';

describe('overlaps', () => {
  it('does not overlap when one slot ends as the other starts', () => {
    expect(overlaps(0, 10, 10, 20)).toBe(false);
  });
});

describe('isWeekend', () => {
  it('treats Sunday as a weekend day', () => {
    expect(isWeekend(0)).toBe(true);
  });
});

describe('sortByStart', () => {
  it('orders slots by start time', () => {
    expect(sortByStart([30, 10, 20])).toEqual([10, 20, 30]);
  });
});
