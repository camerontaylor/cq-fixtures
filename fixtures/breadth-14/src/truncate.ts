export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}
