// Recursive object merge — a synthetic reproduction of the classic
// prototype-pollution bug class (lodash CVE-2019-10744 / CVE-2018-3721
// behavior, no lodash code vendored). The clean version refuses to walk the
// dangerous keys so a crafted source cannot reach Object.prototype.
export function merge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      merge(target[key] as Record<string, unknown>, value);
    } else if (isPlainObject(value)) {
      target[key] = merge({}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
