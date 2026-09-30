/** Validate the committed pin shape before any task factory reads dependency bytes. */
export function validateOraclePinManifest(
  value: unknown,
  expected: { readonly kind: 'operation' | 'integration'; readonly ids: readonly string[]; readonly paths: readonly string[] },
): { readonly dependencies: readonly { readonly path: string; readonly sha256: string }[] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`pinned ${expected.kind} oracle manifest is malformed`);
  }
  const record = value as Record<string, unknown>;
  const idKey = expected.kind === 'operation' ? 'taskOracleIds' : 'oracleIds';
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['dependencies', idKey, 'manifestVersion'].sort())
      || record.manifestVersion !== 1
      || !Array.isArray(record[idKey])
      || JSON.stringify(record[idKey]) !== JSON.stringify(expected.ids)
      || !Array.isArray(record.dependencies)
      || record.dependencies.length !== expected.paths.length) {
    throw new Error(`pinned ${expected.kind} oracle manifest contract changed`);
  }
  for (const [index, dependency] of record.dependencies.entries()) {
    if (dependency === null || typeof dependency !== 'object' || Array.isArray(dependency)) {
      throw new Error(`pinned ${expected.kind} oracle dependency is malformed at ${index}`);
    }
    const entry = dependency as Record<string, unknown>;
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['path', 'sha256'])
        || entry.path !== expected.paths[index]
        || typeof entry.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`pinned ${expected.kind} oracle dependency inventory changed at ${index}`);
    }
  }
  return record as { readonly dependencies: readonly { readonly path: string; readonly sha256: string }[] };
}
