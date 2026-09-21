// Wall-clock seam so callers can be tested without freezing time.
export function nowMs(): number {
  return Date.now();
}
