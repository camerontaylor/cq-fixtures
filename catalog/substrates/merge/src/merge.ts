// Recursive merge of plain-object configuration trees.
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
