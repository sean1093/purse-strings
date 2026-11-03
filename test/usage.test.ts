import { describe, expect, it } from 'vitest';
import { InvalidUsageError } from '../src/errors.js';
import {
  estimateTokens,
  usageFromAnthropic,
  usageFromGemini,
  usageFromOpenAI,
} from '../src/usage.js';

/**
 * Every payload below is the shape the provider documents, extra fields and
 * all, declared the way one arrives from an SDK or `JSON.parse`. The point of
 * these functions is that the totals are read the way each provider bills
 * them, so a payload that has been trimmed to the fields under test would not
 * test much.
 */

describe('usageFromOpenAI', () => {
  it('reads Chat Completions totals as inclusive of cached and reasoning tokens', () => {
    const usage = {
      prompt_tokens: 2006,
      completion_tokens: 300,
      total_tokens: 2306,
      prompt_tokens_details: { cached_tokens: 1920, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 200,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    };

    // `prompt_tokens` already contains the 1920 cached tokens and
    // `completion_tokens` already contains the 200 reasoning tokens, so
    // neither is added again.
    expect(usageFromOpenAI(usage)).toEqual({
      inputTokens: 2006,
      outputTokens: 300,
      cachedInputTokens: 1920,
      cacheWriteTokens: 0,
    });
  });

  it('reads the Responses API totals and its own details object', () => {
    const usage = {
      input_tokens: 328,
      input_tokens_details: { cached_tokens: 256, cache_write_tokens: 64 },
      output_tokens: 1186,
      output_tokens_details: { reasoning_tokens: 1024 },
      total_tokens: 1514,
    };

    expect(usageFromOpenAI(usage)).toEqual({
      inputTokens: 328,
      outputTokens: 1186,
      cachedInputTokens: 256,
      cacheWriteTokens: 64,
    });
  });

  it('prefers the Responses fields when a payload carries both namings', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 5 },
      prompt_tokens: 999,
      completion_tokens: 999,
      prompt_tokens_details: { cached_tokens: 999 },
    };

    expect(usageFromOpenAI(usage)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 5,
      cacheWriteTokens: 0,
    });
  });

  it('reads a zero total as zero rather than falling through to the other naming', () => {
    expect(usageFromOpenAI({ input_tokens: 0, output_tokens: 0, prompt_tokens: 50 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe('usageFromAnthropic', () => {
  it('adds the cache counters to input_tokens, which excludes them', () => {
    const usage = {
      input_tokens: 21,
      cache_creation_input_tokens: 188_086,
      cache_read_input_tokens: 4_000,
      output_tokens: 393,
    };

    expect(usageFromAnthropic(usage)).toEqual({
      inputTokens: 192_107,
      outputTokens: 393,
      cachedInputTokens: 4_000,
      cacheWriteTokens: 188_086,
    });
  });

  it('reads an uncached request as its two plain totals', () => {
    const usage = {
      input_tokens: 2095,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 503,
    };

    expect(usageFromAnthropic(usage)).toEqual({
      inputTokens: 2095,
      outputTokens: 503,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('takes output_tokens as the billed total, thinking included', () => {
    // An extended-thinking response bills the thinking tokens inside
    // `output_tokens`; there is no separate field to add.
    const usage = { input_tokens: 100, output_tokens: 3_500 };

    expect(usageFromAnthropic(usage).outputTokens).toBe(3_500);
  });
});

describe('usageFromGemini', () => {
  it('counts tool-use prompt tokens as input and thoughts as output', () => {
    const metadata = {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      toolUsePromptTokenCount: 30,
      thoughtsTokenCount: 500,
      totalTokenCount: 560,
    };

    const usage = usageFromGemini(metadata);

    expect(usage).toEqual({
      inputTokens: 40,
      outputTokens: 520,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    // The four counters Gemini reports are disjoint and sum to its own total.
    expect(usage.inputTokens + usage.outputTokens).toBe(metadata.totalTokenCount);
  });

  it('treats cachedContentTokenCount as part of promptTokenCount, not beside it', () => {
    const metadata = {
      promptTokenCount: 1_033,
      candidatesTokenCount: 150,
      totalTokenCount: 1_183,
      cachedContentTokenCount: 1_000,
    };

    expect(usageFromGemini(metadata)).toEqual({
      inputTokens: 1_033,
      outputTokens: 150,
      cachedInputTokens: 1_000,
      cacheWriteTokens: 0,
    });
  });
});

describe('normalisation', () => {
  it('reads a missing, null or nonsense counter as zero', () => {
    const broken = {
      prompt_tokens: Number.NaN,
      completion_tokens: -40,
      prompt_tokens_details: { cached_tokens: null, cache_write_tokens: Number.POSITIVE_INFINITY },
    };

    expect(usageFromOpenAI(broken)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(usageFromAnthropic({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(usageFromGemini({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('keeps the cache subsets inside the input total', () => {
    // `cachedInputTokens` and `cacheWriteTokens` are subsets of `inputTokens`,
    // and the guard prices the remainder at the full input rate. Subsets that
    // overflowed the whole would price a negative remainder.
    const usage = usageFromOpenAI({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 90 },
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 90,
      cacheWriteTokens: 10,
    });
  });

  it('floors a fractional count rather than carrying it into a counter', () => {
    expect(usageFromGemini({ promptTokenCount: 10.7, candidatesTokenCount: 2.9 })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe('estimateTokens', () => {
  const encoder = new TextEncoder();

  it('counts UTF-8 bytes and divides by three, rounding up', () => {
    const samples = [
      '',
      'a',
      'hello',
      'The quick brown fox jumps over the lazy dog.',
      'héllo wörld',
      '日本語のテキスト',
      '😀 emoji and 👨‍👩‍👧‍👦 a family',
      'mixed: ascii, naïve, 漢字, 🧮',
      'x'.repeat(10_000),
    ];

    for (const sample of samples) {
      expect(estimateTokens(sample)).toBe(Math.ceil(encoder.encode(sample).length / 3));
    }
  });

  it('counts a lone surrogate as the replacement character does', () => {
    // '\ud83d' without its low surrogate encodes as U+FFFD: three bytes.
    for (const broken of ['\ud83d', 'a\ud83d', '\udc00', '\ud83da']) {
      expect(estimateTokens(broken)).toBe(Math.ceil(encoder.encode(broken).length / 3));
    }
  });

  it('rejects an argument that is not a string', () => {
    expect(() => estimateTokens(undefined as unknown as string)).toThrow(InvalidUsageError);
    expect(() => estimateTokens(1_000 as unknown as string)).toThrow(InvalidUsageError);
  });
});
