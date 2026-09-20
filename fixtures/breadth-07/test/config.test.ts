import { describe, expect, it } from 'vitest';
import { withDefaults } from '../src/defaults.ts';

describe('withDefaults', () => {
  it('supplies three retries when the caller omits them', () => {
    expect(withDefaults({})).toEqual({ verbose: false, retries: 3 });
  });

  it('keeps an explicit retry count', () => {
    expect(withDefaults({}, 5)).toEqual({ verbose: false, retries: 5 });
  });
});
