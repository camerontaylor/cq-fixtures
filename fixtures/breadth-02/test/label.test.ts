import { describe, expect, it } from 'vitest';
import { pageLabel } from '../src/label.ts';

describe('pageLabel', () => {
  it('renders a one-based page label', () => {
    expect(pageLabel(0)).toBe('page 1');
  });
});
