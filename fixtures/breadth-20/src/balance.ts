export function isOverdrawn(balance: number): boolean {
  return balance <= 0;
}
