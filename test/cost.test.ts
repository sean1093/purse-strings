import { describe, expect, it } from 'vitest';
import { ceilMicros, costMicrosOf, usdToMicros } from '../src/cost.js';
import type { TokenUsage } from '../src/types.js';

function usage(parts: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    ...parts,
  };
}

describe('ceilMicros', () => {
  it('does not round up a value that only looks fractional in binary', () => {
    // 100 tokens at $0.07 per million is exactly 7 micro-dollars, but the
    // product is 7.000000000000001. Charging 8 is a 14% overcharge on every
    // call at that price, forever.
    expect(100 * 0.07).not.toBe(7);
    expect(Math.ceil(100 * 0.07)).toBe(8);
    expect(ceilMicros(100 * 0.07)).toBe(7);

    expect(50 * 1.1).not.toBe(55);
    expect(ceilMicros(50 * 1.1)).toBe(55);
  });

  it('still rounds a genuinely fractional value up', () => {
    expect(ceilMicros(0.000001)).toBe(1);
    expect(ceilMicros(149.5)).toBe(150);
    expect(ceilMicros(150.000002)).toBe(151);
  });

  it('leaves whole values alone', () => {
    expect(ceilMicros(0)).toBe(0);
    expect(ceilMicros(150)).toBe(150);
  });

  it('falls back to a plain ceiling beyond the safe-integer range', () => {
    const huge = 2 ** 53;
    expect(ceilMicros(huge)).toBe(huge);
  });
});

describe('usdToMicros', () => {
  it('converts dollars to whole micro-dollars without a binary artefact', () => {
    expect(usdToMicros(1)).toBe(1_000_000);
    expect(usdToMicros(0.5)).toBe(500_000);
    // 0.07 * 1e6 is 70000.00000000001.
    expect(usdToMicros(0.07)).toBe(70_000);
    expect(usdToMicros(0.0000001)).toBe(1);
  });
});

describe('costMicrosOf', () => {
  const pricing = { input: 2, output: 8 };

  it('prices a million tokens at exactly the published rate', () => {
    expect(costMicrosOf(usage({ inputTokens: 1_000_000 }), pricing)).toBe(2_000_000);
    expect(costMicrosOf(usage({ outputTokens: 1_000_000 }), pricing)).toBe(8_000_000);
  });

  it('rounds the total up once, not each dimension', () => {
    // 1 * 0.3 + 1 * 0.4 is 0.7 micro-dollars: one, not two.
    expect(
      costMicrosOf(usage({ inputTokens: 1, outputTokens: 1 }), { input: 0.3, output: 0.4 }),
    ).toBe(1);
  });

  it('charges cached and cache-write tokens at their own prices', () => {
    const detailed = { input: 2, output: 8, cachedInput: 0.5, cacheWrite: 2.5 };
    const result = costMicrosOf(
      usage({
        inputTokens: 1000,
        cachedInputTokens: 600,
        cacheWriteTokens: 200,
        outputTokens: 100,
      }),
      detailed,
    );

    // 200 plain * 2 + 600 cached * 0.5 + 200 written * 2.5 + 100 output * 8
    expect(result).toBe(400 + 300 + 500 + 800);
  });

  it('charges cached tokens at the full input price when no discount is configured', () => {
    const withCache = costMicrosOf(usage({ inputTokens: 1000, cachedInputTokens: 900 }), pricing);

    expect(withCache).toBe(2000);
  });

  it('never charges less than nothing when the subsets add up to the whole input', () => {
    const result = costMicrosOf(
      usage({ inputTokens: 100, cachedInputTokens: 100, cacheWriteTokens: 0 }),
      { input: 2, output: 8, cachedInput: 0.25 },
    );

    expect(result).toBe(25);
  });

  it('prices a fractional-rate model without accumulating error', () => {
    // 1,000 calls of 1,000 input tokens at $0.15/M is exactly $0.15.
    let total = 0;
    for (let call = 0; call < 1000; call += 1) {
      total += costMicrosOf(usage({ inputTokens: 1000 }), { input: 0.15, output: 0.6 });
    }

    expect(total).toBe(150_000);
  });
});
