export class Cache<V> {
  private readonly store = new Map<string, V>();

  get(key: string): V | undefined {
    return this.store.get(key);
  }

  set(key: string, value: V): void {
    this.store.set(key, value);
  }
}
