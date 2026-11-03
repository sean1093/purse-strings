import type { ModelPricing, TokenUsage } from './types.js';

/**
 * Cost in integer micro-dollars.
 *
 * A price is US dollars per million tokens, so micro-dollars per token is the
 * same number: `tokens x usdPerMillion` is already micro-dollars.
 */

const MICROS_PER_USD = 1_000_000;

/**
 * Round up to a whole micro-dollar, after removing the floating-point
 * artefact in the product.
 *
 * Both steps matter. 100 tokens at $0.07 per million is exactly 7
 * micro-dollars, but `100 * 0.07` is `7.000000000000001` in IEEE 754, and a
 * bare `Math.ceil` would charge 8 — a 14% overcharge on every call at that
 * price. Scaling by a million, rounding to the nearest integer and scaling
 * removes an error of that size while leaving a genuinely fractional result
 * fractional, so it still rounds up. Above the safe-integer range the scaling
 * would itself be lossy, so it is skipped; at that magnitude the artefact is
 * far below the value's own precision.
 */
export function ceilMicros(value: number): number {
  const scaled = value * MICROS_PER_USD;
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
    return Math.ceil(value);
  }
  return Math.ceil(Math.round(scaled) / MICROS_PER_USD);
}

/** US dollars to whole micro-dollars, rounded up. */
export function usdToMicros(usd: number): number {
  return ceilMicros(usd * MICROS_PER_USD);
}

/**
 * What this usage costs, in micro-dollars.
 *
 * `cachedInputTokens` and `cacheWriteTokens` are subsets of `inputTokens`, so
 * the remainder is what is billed at the full input price. A provider that
 * does not discount cached tokens leaves `cachedInput` unset and they are
 * billed at `input`, which is the conservative reading.
 *
 * The sum is rounded once, at the end: rounding each term up would overcharge
 * by up to one micro-dollar per dimension.
 */
export function costMicrosOf(usage: TokenUsage, pricing: ModelPricing): number {
  const cached = usage.cachedInputTokens;
  const written = usage.cacheWriteTokens;
  const plain = Math.max(0, usage.inputTokens - cached - written);

  const total =
    plain * pricing.input +
    cached * (pricing.cachedInput ?? pricing.input) +
    written * (pricing.cacheWrite ?? pricing.input) +
    usage.outputTokens * pricing.output;

  return ceilMicros(total);
}
