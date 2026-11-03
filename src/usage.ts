/**
 * Provider usage, normalised.
 *
 * Every provider reports usage in a different shape, and the differences
 * change the bill. OpenAI counts cached tokens inside its prompt total;
 * Anthropic reports them beside it; Gemini counts tool-use prompt tokens and
 * thinking tokens outside the prompt and candidate totals. Reasoning and
 * thinking tokens are billed as output everywhere.
 *
 * The normalised shape is `inputTokens` as the provider's total input, with
 * `cachedInputTokens` and `cacheWriteTokens` as subsets of it, and
 * `outputTokens` already including reasoning.
 *
 * No SDK is imported. Each parameter is a structural type naming only the
 * fields that are read, so the object from any client library fits — and the
 * fields that are not read are the ones already counted inside a total, such
 * as OpenAI's `reasoning_tokens` or Gemini's `cachedContentTokenCount`
 * beyond its own dimension.
 */

import { InvalidUsageError } from './errors.js';
import type { TokenUsage } from './types.js';

/** Non-negative whole tokens. Anything else a provider sends counts as none. */
function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The subsets cannot exceed the whole. A provider is not expected to violate
 * that, but a total that did would make every later `commit()` throw, which
 * would leave the reservation booked for the rest of the window.
 */
function normalise(
  inputTokens: number,
  outputTokens: number,
  cached: number,
  written: number,
): TokenUsage {
  const cachedInputTokens = Math.min(cached, inputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens: Math.min(written, inputTokens - cachedInputTokens),
  };
}

/**
 * OpenAI usage, from either API.
 *
 * Chat Completions reports `prompt_tokens` and `completion_tokens`; Responses
 * reports `input_tokens` and `output_tokens`. Both totals are inclusive:
 * `cached_tokens` is already inside the input total and `reasoning_tokens` is
 * already inside the output total, so neither is added again.
 */
export interface OpenAIUsage {
  readonly prompt_tokens?: number | null;
  readonly completion_tokens?: number | null;
  readonly prompt_tokens_details?: OpenAIInputDetails | null;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly input_tokens_details?: OpenAIInputDetails | null;
}

export interface OpenAIInputDetails {
  readonly cached_tokens?: number | null;
  readonly cache_write_tokens?: number | null;
}

export function usageFromOpenAI(usage: OpenAIUsage): TokenUsage {
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details ?? null;

  return normalise(
    tokens(usage.input_tokens ?? usage.prompt_tokens),
    tokens(usage.output_tokens ?? usage.completion_tokens),
    tokens(details?.cached_tokens),
    tokens(details?.cache_write_tokens),
  );
}

/**
 * Anthropic Messages usage.
 *
 * `input_tokens` counts only the tokens that were neither read from nor
 * written to the cache: the total input of a request is the sum of
 * `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`.
 * `output_tokens` is the authoritative billed total and already includes
 * thinking tokens.
 */
export interface AnthropicUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

export function usageFromAnthropic(usage: AnthropicUsage): TokenUsage {
  const written = tokens(usage.cache_creation_input_tokens);
  const cached = tokens(usage.cache_read_input_tokens);

  return normalise(
    tokens(usage.input_tokens) + written + cached,
    tokens(usage.output_tokens),
    cached,
    written,
  );
}

/**
 * Gemini `usageMetadata`.
 *
 * `promptTokenCount` already includes `cachedContentTokenCount`, but
 * `toolUsePromptTokenCount` and `thoughtsTokenCount` sit outside it and
 * outside `candidatesTokenCount`: the documented total is prompt plus
 * tool-use prompt plus thoughts plus candidates. Tool-use prompt tokens are
 * input; thinking tokens are output.
 *
 * Gemini reports no cache-write count here, so `cacheWriteTokens` is zero;
 * explicit context caching is billed separately from a generate call.
 */
export interface GeminiUsageMetadata {
  readonly promptTokenCount?: number | null;
  readonly candidatesTokenCount?: number | null;
  readonly cachedContentTokenCount?: number | null;
  readonly toolUsePromptTokenCount?: number | null;
  readonly thoughtsTokenCount?: number | null;
}

export function usageFromGemini(metadata: GeminiUsageMetadata): TokenUsage {
  return normalise(
    tokens(metadata.promptTokenCount) + tokens(metadata.toolUsePromptTokenCount),
    tokens(metadata.candidatesTokenCount) + tokens(metadata.thoughtsTokenCount),
    tokens(metadata.cachedContentTokenCount),
    0,
  );
}

/**
 * A token estimate for a reservation: UTF-8 bytes divided by three, rounded
 * up.
 *
 * This is a heuristic, not a tokenizer. It is deliberately rough and
 * deliberately dependency-free: a reservation only needs a number that is not
 * wildly low, and `commit()` replaces it with the provider's real count
 * moments later. English prose runs near four bytes per token, so three
 * over-estimates slightly, which is the safe direction for a spending
 * control. Scripts outside Latin-1 and base64 payloads both run closer to
 * one token per three bytes.
 *
 * Counting bytes directly rather than encoding the string first keeps a large
 * prompt from being copied just to measure it.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string') {
    throw new InvalidUsageError(`estimateTokens() needs a string, got ${typeof text}`);
  }

  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        // One astral character: four bytes, two UTF-16 code units.
        bytes += 4;
        index += 1;
      } else {
        // A lone surrogate encodes as the three-byte replacement character.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return Math.ceil(bytes / 3);
}
