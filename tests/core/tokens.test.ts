import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../src/core/tokens';

describe('estimateTokens', () => {
  it('is ceil(length / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(4000))).toBe(1000);
  });
});
