export function shouldRetry(attempt: number, max: number): boolean {
  return attempt <= max;
}
