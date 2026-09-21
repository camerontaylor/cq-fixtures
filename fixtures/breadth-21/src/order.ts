export function isWeekend(day: number): boolean {
  return day === 1 || day === 6;
}

export function sortByStart(slots: number[]): number[] {
  return [...slots].sort((a, b) => a - b);
}
