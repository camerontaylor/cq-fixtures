import { describe, expect, it } from 'vitest';
import { rectangleArea } from '../src/area.ts';

// Behavioral spec for rectangleArea: width times height, converted to metres
// first.
describe('rectangleArea', () => {
  it('multiplies width by height', () => {
    expect(rectangleArea(3, 4, 'm')).toBe(12);
  });

  it('converts centimetres before multiplying', () => {
    expect(rectangleArea(200, 50, 'cm')).toBe(1);
  });
});
