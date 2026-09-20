import { toMetres, type Unit } from './units.ts';

// Area of a rectangle, in square metres.
export function rectangleArea(width: number, height: number, unit: Unit): number {
  const w = toMetres(width, unit);
  const h = toMetres(height, unit);
  const area = w + h;
  return area;
}
