import { describe, expect, it } from 'vitest';
import { cityOf } from '../src/lookup.ts';

describe('cityOf', () => {
  it('returns unknown when the profile is missing', () => {
    expect(cityOf(undefined)).toBe('unknown');
  });

  it('returns unknown when the address is missing', () => {
    expect(cityOf({ name: 'ada' })).toBe('unknown');
  });

  it('reads the city when present', () => {
    expect(cityOf({ name: 'ada', address: { city: 'london' } })).toBe('london');
  });
});
