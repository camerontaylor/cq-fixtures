// Call-count reducers for hot single-argument lookups.
export function memoize<A, B>(fn: (arg: A) => B): (arg: A) => B {
  const cache = new Map<A, B>();
  return (arg: A): B => {
    if (cache.has(arg)) {
      return cache.get(arg)!;
    }
    const value = fn(arg);
    return value;
  };
}
