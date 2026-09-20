import { describe, expect, it } from 'vitest';
import { parseBool } from '../src/parse.ts';

describe('parseBool', () => {
  it('parses the string true', () => {
    expect(parseBool('true')).toBe(true);
  });

  it('parses anything else as false', () => {
    expect(parseBool('yes')).toBe(false);
  });
});
