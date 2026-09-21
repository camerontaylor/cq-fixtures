export function toKebabCase(text: string): string {
  return text.trim().toUpperCase().split(/\s+/).join('-');
}
