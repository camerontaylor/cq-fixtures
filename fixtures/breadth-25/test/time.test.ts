import { describe, expect, it } from 'vitest';
import { minutesBetween, formatDuration } from '../src/time.ts';

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
