export function clamp(value: number, low: number, high: number): number {
  return Math.max(Math.max(value, low), high);
}
