import { describe, expect, it } from 'vitest';
import { slugify } from '../src/slugify.ts';

// Behavioral spec for slugify: words are separated by single hyphens and the
// result is entirely lowercase.
describe('slugify', () => {
  it('hyphen-joins words and lowercases them', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses leading, trailing, and repeated whitespace', () => {
    expect(slugify('  Stand Up  Meetings ')).toBe('stand-up-meetings');
  });

  it('lowercases a single word', () => {
    expect(slugify('Zebra')).toBe('zebra');
  });
});
