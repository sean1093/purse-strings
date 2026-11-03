/**
 * The public vocabulary: counters and the store interface beneath them, rules
 * and windows above them, and the usage and pricing shapes that turn tokens
 * into money.
 */

/**
 * What one counter holds. Cost is integer micro-dollars (one millionth of a
 * US dollar), never floating-point dollars: the value is compared against a
 * limit after repeated addition, and accumulated representation error in that
 * comparison is not acceptable in a spending control.
 */
export interface Counter {
  tokens: number;
  costMicros: number;
  requests: number;
}

/** One counter's part of a store operation. */
export interface CounterUpdate {
  /** `<ruleId>:<encodeURIComponent(subject)>:<windowStart>`. */
  key: string;
  /** Signed. `consume()` is only ever called with non-negative deltas. */
  delta: Counter;
  /**
   * The ceiling each dimension is checked against by `consume()`. A dimension
   * that is absent is unlimited. Ignored by `add()`.
   */
  limits?: Partial<Counter>;
  /**
   * Epoch milliseconds when this counter stops counting, or `null` for a
   * counter that never expires. A store must treat a counter at or past this
   * time as zeros even if the platform has not deleted it yet.
   */
  expiresAt: number | null;
}

/**
 * `ok: false` names the first counter that would exceed a limit and its
 * current value, so the caller can say which dimension ran out and by how
 * much. Nothing is written when a `consume()` fails.
 */
export type ConsumeResult = { ok: true } | { ok: false; key: string; current: Counter };

/**
 * The adapter interface. Implementations live in their own entry points;
 * `MemoryStore` is the only one in the main entry point.
 *
 * `'strong'` means `consume()` really is atomic across concurrent callers:
 * two reservations that together exceed a limit cannot both succeed. A store
 * that cannot promise that must report `'eventual'`, which downgrades every
 * rule on it to a soft limit.
 */
export interface BudgetStore {
  readonly consistency: 'strong' | 'eventual';
  /** All or nothing: every counter is checked against its limits, then all are incremented. */
  consume(updates: readonly CounterUpdate[]): Promise<ConsumeResult>;
  /** Unconditional, and never leaves a dimension below zero. Used to settle leases. */
  add(updates: readonly CounterUpdate[]): Promise<void>;
  /** Missing and expired keys read as zeros, in the order the keys were given. */
  read(keys: readonly string[]): Promise<Counter[]>;
}

/**
 * A fixed window, aligned to UTC. `week` is the ISO week, starting Monday.
 * `total` never resets. `{ seconds }` is aligned to the Unix epoch.
 *
 * Windows are fixed rather than sliding because a sliding window needs the
 * timestamp of every event, which turns one integer per subject into a list
 * whose length an attacker controls.
 */
export type WindowSpec =
  | 'minute'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'total'
  | { readonly seconds: number };

/** Limits for one rule. Cost is in US dollars here; it is stored as micro-dollars. */
export interface RuleLimits {
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly requests?: number;
}

export interface BudgetRule {
  /** Part of every counter key, so it is restricted to `/^[A-Za-z0-9_-]{1,64}$/`. */
  readonly id: string;
  /** `'global'`, or the name of a subject passed to `reserve()`. */
  readonly scope: 'global' | (string & {});
  readonly window: WindowSpec;
  readonly limits: RuleLimits;
  /** When true, calls that do not carry this scope's subject skip the rule instead of throwing. */
  readonly optional?: boolean;
}

/** US dollars per million tokens, as the providers publish them. */
export interface ModelPricing {
  readonly input: number;
  readonly output: number;
  /** Defaults to `input`: no discount is assumed for a provider that gives one. */
  readonly cachedInput?: number;
  /** Defaults to `input`. */
  readonly cacheWrite?: number;
}

export type PricingTable = Readonly<Record<string, ModelPricing>>;

/**
 * Normalised token usage. `cachedInputTokens` and `cacheWriteTokens` are
 * subsets of `inputTokens`, which is the provider's total input; reasoning and
 * thinking tokens are already inside `outputTokens`, because that is how they
 * are billed.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}
