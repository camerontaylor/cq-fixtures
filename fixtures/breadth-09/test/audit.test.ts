import { describe, expect, it } from 'vitest';
import { auditLine } from '../src/audit.ts';

describe('auditLine', () => {
  it('marks a paid order', () => {
    expect(auditLine({ id: '1', paid: true, shipped: false })).toBe('1:paid');
  });
});
