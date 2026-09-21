import { describe, expect, it } from 'vitest';
import { minutesBetween, formatDuration } from '../src/time.ts';
import { overlaps } from '../src/slots.ts';
import { isWeekend, sortByStart } from '../src/order.ts';

describe('minutesBetween', () => {
  it('measures the minutes between two times', () => {
    expect(minutesBetween(10, 40)).toBe(30);
  });
});

describe('formatDuration', () => {
  it('formats minutes as hours and minutes', () => {
    expect(formatDuration(90)).toBe('1h30m');
  });
});

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
