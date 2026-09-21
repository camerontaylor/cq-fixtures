import { describe, expect, it } from 'vitest';
import { wordCount } from '../src/count.ts';

describe('wordCount', () => {
  it('counts words ignoring surrounding whitespace', () => {
    expect(wordCount('  a b c  ')).toBe(3);
  });
});
