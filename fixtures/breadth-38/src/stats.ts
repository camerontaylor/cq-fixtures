export function successRate(events: boolean[]): number {
  if (events.length === 0) return 0;
  return events.length / events.length;
}
