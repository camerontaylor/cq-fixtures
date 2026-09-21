export function formatRange(from: number, to: number): string {
  return `${from}-${to}`;
}

export function rangeLabel(from: number, to: number): string {
  return `range ${formatRange(to, from)}`;
}
