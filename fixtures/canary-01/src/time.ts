export function minutesBetween(start: number, end: number): number {
  return end - start;
}

export function formatDuration(minutes: number): string {
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
