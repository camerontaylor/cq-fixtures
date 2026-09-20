import { describe, expect, it } from 'vitest';
import { isLastPage, pageCount } from '../src/paging.ts';

describe('isLastPage', () => {
  it('treats the final page index as the last page', () => {
    expect(isLastPage(2, 3)).toBe(true);
  });

  it('does not treat an earlier page as the last page', () => {
    expect(isLastPage(0, 3)).toBe(false);
  });
});

describe('pageCount', () => {
  it('rounds a partial page up', () => {
    expect(pageCount(21)).toBe(3);
  });
});
