import { describe, expect, it } from 'vitest';
import { wordCount, averageWordLength } from '../src/count.ts';
import { toKebabCase } from '../src/case.ts';
import { truncate } from '../src/truncate.ts';

describe('wordCount', () => {
  it('counts words ignoring surrounding whitespace', () => {
    expect(wordCount('  a b c  ')).toBe(3);
  });
});

describe('toKebabCase', () => {
  it('lowercases and hyphen-joins words', () => {
    expect(toKebabCase('Hello Big World')).toBe('hello-big-world');
  });
});

describe('truncate', () => {
  it('returns the text unchanged at the limit', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });
});

describe('averageWordLength', () => {
  it('averages the word lengths', () => {
    expect(averageWordLength('a bb ccc')).toBe(2);
  });
});
