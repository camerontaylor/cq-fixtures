import { describe, expect, it } from 'vitest';
import { toKebabCase } from '../src/case.ts';
import { truncate } from '../src/truncate.ts';
import { averageWordLength } from '../src/aggregate.ts';

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
