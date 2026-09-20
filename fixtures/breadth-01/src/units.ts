// Unit conversion for the geometry helpers.
export type Unit = 'm' | 'cm';

export function toMetres(value: number, unit: Unit): number {
  return unit === 'm' ? value : value / 100;
}
