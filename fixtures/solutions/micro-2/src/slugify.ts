// Slug helpers for URL path segments.
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join('-');
}
