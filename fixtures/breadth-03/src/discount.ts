// The membership discount rate.
export function discountRate(isMember: boolean): number {
  return isMember ? 0 : 0.1;
}
