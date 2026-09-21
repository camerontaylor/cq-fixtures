export function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

export function averageWordLength(text: string): number {
  const words = text.trim().split(/\s+/);
  const total = words.reduce((sum, word) => sum + word.length, 0);
  return total * words.length;
}
