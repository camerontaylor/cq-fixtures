import { describe, expect, it } from 'vitest';
import { catalog } from '../src/catalog.ts';

describe('catalog', () => {
  it('lists three stocked or unstocked rows', () => {
    expect(catalog()).toHaveLength(3);
  });
});
