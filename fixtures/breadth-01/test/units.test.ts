import { describe, expect, it } from 'vitest';
import { toMetres } from '../src/units.ts';

// Unaffected module: these pass in both the faulted and the fixed state.
describe('toMetres', () => {
  it('passes metres through unchanged', () => {
    expect(toMetres(5, 'm')).toBe(5);
  });

  it('divides centimetres by one hundred', () => {
    expect(toMetres(250, 'cm')).toBe(2.5);
  });
});
