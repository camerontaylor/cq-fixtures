// The membership discount rate: members get ten percent off.
export function discountRate(isMember: boolean): number {
  return isMember ? 0 : 0.1;
}
