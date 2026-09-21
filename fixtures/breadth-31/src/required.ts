export function requireFields(obj: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => obj[field] === undefined);
}
