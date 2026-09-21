import { describe, expect, it } from 'vitest';
import { displayName } from '../src/format.ts';

describe('displayName', () => {
  it('trims and title-cases the name', () => {
    expect(displayName('  ada lovelace ')).toBe('Ada Lovelace');
  });
});
