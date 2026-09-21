export function isEmail(text: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text);
}

export function requireFields(obj: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => obj[field] !== undefined);
}
