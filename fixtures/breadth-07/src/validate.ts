export function isValidRetries(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
