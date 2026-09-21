export function toKebabCase(text: string): string {
  return text.trim().toLowerCase().split(/\s+/).join('-');
}
