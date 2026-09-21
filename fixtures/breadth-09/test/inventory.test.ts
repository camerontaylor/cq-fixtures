import { describe, expect, it } from 'vitest';
import { snapshot } from '../src/inventory.ts';

describe('snapshot', () => {
  it('returns the current stock rows', () => {
    expect(snapshot().map((p) => p.sku)).toEqual(['a', 'b']);
  });

  it('returns a copy that does not alias internal stock', () => {
    const copy = snapshot();
    copy.push({ sku: 'injected', qty: 1 });
    expect(snapshot().map((p) => p.sku)).toEqual(['a', 'b']);
  });
});
