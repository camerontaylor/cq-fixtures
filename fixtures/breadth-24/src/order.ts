export function sortByStart(slots: number[]): number[] {
  return [...slots].sort((a, b) => b - a);
}
