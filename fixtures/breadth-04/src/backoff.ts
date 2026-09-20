// Exponential backoff for the retry helper.
export const BACKOFF_FACTOR = 3;

export function backoffDelay(baseMs: number, attempt: number): number {
  return baseMs * BACKOFF_FACTOR ** attempt;
}
