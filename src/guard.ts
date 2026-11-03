import { costMicrosOf, usdToMicros } from './cost.js';
import {
  type BudgetDimension,
  BudgetExceededError,
  InvalidConfigError,
  InvalidUsageError,
  LeaseSettledError,
  MissingSubjectError,
  UnknownModelError,
} from './errors.js';
import { counterKey, GLOBAL_SUBJECT, validateRuleId } from './keys.js';
import type {
  BudgetRule,
  BudgetStore,
  Counter,
  CounterUpdate,
  ModelPricing,
  PricingTable,
  TokenUsage,
} from './types.js';
import { retryAfterSeconds, validateWindow, type WindowBounds, windowAt } from './windows.js';

/**
 * Worst case for one call when the caller does not say. Generous enough not
 * to under-reserve a normal answer, small enough that one request cannot
 * exhaust a day's budget by accident.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** The widest instant a `Date` can represent, so a month window stays finite. */
const MAX_TIME = 8_640_000_000_000_000;

export interface GuardOptions {
  readonly store: BudgetStore;
  readonly rules: readonly BudgetRule[];
  /** US dollars per million tokens, keyed by model id. Required for any rule that limits cost. */
  readonly pricing?: PricingTable;
  /** Used when `reserve()` omits `maxOutputTokens`. Defaults to 4096. */
  readonly defaultMaxOutputTokens?: number;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface ReserveOptions {
  /** Subject per scope, from authenticated server-side state. Never from the request body. */
  readonly subjects?: Readonly<Record<string, string>>;
  readonly model?: string;
  /** The prompt's token count, or an estimate. Defaults to 0. */
  readonly inputTokens?: number;
  /** The worst case this call can generate. Defaults to `defaultMaxOutputTokens`. */
  readonly maxOutputTokens?: number;
  /** Part of `inputTokens` that will be read from the provider's cache. */
  readonly cachedInputTokens?: number;
  /** Part of `inputTokens` that will be written to the provider's cache. */
  readonly cacheWriteTokens?: number;
  /** Books this cost instead of pricing the reservation. */
  readonly costUsd?: number;
}

export interface CommitUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Overrides the model given to `reserve()`, for a provider that fell back to another one. */
  readonly model?: string;
  /** The real cost. Overrides pricing entirely. */
  readonly costUsd?: number;
}

export interface Lease {
  /** What this lease booked. `requests` is always 1. */
  readonly reserved: Readonly<Counter>;
  /**
   * Book the difference between the real usage and the reservation. A call
   * that used less than it reserved refunds the rest.
   */
  commit(usage?: CommitUsage): Promise<void>;
  /** Refund the reservation. The request stays counted: it was made. */
  release(): Promise<void>;
}

export interface UsageDimension {
  readonly used: number;
  /** `null` when the rule does not limit this dimension. */
  readonly limit: number | null;
  readonly remaining: number | null;
}

export interface RuleUsage {
  readonly rule: string;
  readonly scope: string;
  readonly subject: string;
  readonly windowStart: number;
  /** Epoch milliseconds when the window ends, or `null` for a `total` window. */
  readonly resetAt: number | null;
  readonly tokens: UsageDimension;
  /** Micro-dollars. Divide by 1,000,000 for US dollars. */
  readonly costMicros: UsageDimension;
  readonly requests: UsageDimension;
}

export interface UsageOptions {
  readonly subjects?: Readonly<Record<string, string>>;
}

export interface Guard {
  /**
   * Book the worst case for one model call across every applicable rule, in
   * one atomic store operation. Throws `BudgetExceededError` if any rule
   * cannot absorb it, and nothing is booked.
   */
  reserve(options?: ReserveOptions): Promise<Lease>;
  /** Used, limit, remaining and reset time for every applicable rule. */
  usage(options?: UsageOptions): Promise<RuleUsage[]>;
  /** The rules as configured, in order. */
  readonly rules: readonly BudgetRule[];
}

/** A rule with its limits converted and validated once, at construction. */
interface PreparedRule {
  readonly source: BudgetRule;
  readonly id: string;
  readonly scope: string;
  readonly optional: boolean;
  readonly tokens: number | null;
  readonly costMicros: number | null;
  readonly requests: number | null;
  /** The same object every call, handed to the store as a read-only limit set. */
  readonly limits: Partial<Counter>;
}

interface Applicable {
  readonly rule: PreparedRule;
  readonly subject: string;
  readonly window: WindowBounds;
  readonly key: string;
}

/** Order the dimensions are reported in when a reservation exceeds more than one. */
const DIMENSIONS: readonly BudgetDimension[] = ['costMicros', 'tokens', 'requests'];

export function createGuard(options: GuardOptions): Guard {
  return new BudgetGuard(options);
}

class BudgetGuard implements Guard {
  readonly rules: readonly BudgetRule[];

  readonly #store: BudgetStore;
  readonly #prepared: readonly PreparedRule[];
  readonly #pricing: PricingTable;
  readonly #defaultMaxOutputTokens: number;
  readonly #now: () => number;

  constructor(options: GuardOptions) {
    const store = options.store as BudgetStore | undefined;
    if (
      store === undefined ||
      typeof store.consume !== 'function' ||
      typeof store.add !== 'function' ||
      typeof store.read !== 'function'
    ) {
      throw new InvalidConfigError('store must implement consume(), add() and read()');
    }
    if (!Array.isArray(options.rules)) {
      throw new InvalidConfigError('rules must be an array');
    }

    this.#store = store;
    this.rules = [...options.rules];
    this.#prepared = this.rules.map(prepareRule);
    this.#pricing = validatePricing(options.pricing);
    this.#defaultMaxOutputTokens = validateDefaultMaxOutput(options.defaultMaxOutputTokens);
    this.#now = options.now ?? Date.now;

    const seen = new Set<string>();
    for (const rule of this.#prepared) {
      if (seen.has(rule.id)) {
        throw new InvalidConfigError(`two rules share the id '${rule.id}'; ids must be unique`);
      }
      seen.add(rule.id);
    }
  }

  async reserve(options: ReserveOptions = {}): Promise<Lease> {
    const now = this.#clock();
    const inputTokens = count(options.inputTokens ?? 0, 'inputTokens');
    const outputTokens = count(
      options.maxOutputTokens ?? this.#defaultMaxOutputTokens,
      'maxOutputTokens',
    );
    const usage = tokenUsage(inputTokens, outputTokens, options);
    const applicable = this.#applicable(options.subjects, now);

    const costMicros = this.#priceOf(usage, options.model, options.costUsd, applicable);
    const delta: Counter = { tokens: inputTokens + outputTokens, costMicros, requests: 1 };

    if (applicable.length > 0) {
      const updates = applicable.map(
        (entry): CounterUpdate => ({
          key: entry.key,
          delta,
          limits: entry.rule.limits,
          expiresAt: entry.window.resetAt,
        }),
      );

      const result = await this.#store.consume(updates);
      if (!result.ok) throw refusal(applicable, result.key, result.current, delta, now);
    }

    return new BudgetLease(this, applicable, delta, options.model);
  }

  async usage(options: UsageOptions = {}): Promise<RuleUsage[]> {
    const now = this.#clock();
    const applicable = this.#applicable(options.subjects, now);
    if (applicable.length === 0) return [];

    const counters = await this.#store.read(applicable.map((entry) => entry.key));
    if (counters.length !== applicable.length) {
      // The one place a store could make the library answer confidently and
      // wrongly: a short result would report an unread rule as entirely unused.
      throw new InvalidConfigError(
        `the store returned ${counters.length} counters for ${applicable.length} keys`,
      );
    }

    return applicable.map((entry, index): RuleUsage => {
      const used = counters[index] ?? { tokens: 0, costMicros: 0, requests: 0 };
      return {
        rule: entry.rule.id,
        scope: entry.rule.scope,
        subject: entry.subject,
        windowStart: entry.window.start,
        resetAt: entry.window.resetAt,
        tokens: dimension(used.tokens, entry.rule.tokens),
        costMicros: dimension(used.costMicros, entry.rule.costMicros),
        requests: dimension(used.requests, entry.rule.requests),
      };
    });
  }

  /** @internal Used by the lease to settle. */
  settle(applicable: readonly Applicable[], delta: Counter): Promise<void> {
    if (applicable.length === 0) return Promise.resolve();

    return this.#store.add(
      applicable.map(
        (entry): CounterUpdate => ({
          key: entry.key,
          delta,
          expiresAt: entry.window.resetAt,
        }),
      ),
    );
  }

  /** @internal Used by the lease to price the real usage. */
  priceOf(
    usage: TokenUsage,
    model: string | undefined,
    costUsd: number | undefined,
    applicable: readonly Applicable[],
  ): number {
    return this.#priceOf(usage, model, costUsd, applicable);
  }

  #priceOf(
    usage: TokenUsage,
    model: string | undefined,
    costUsd: number | undefined,
    applicable: readonly Applicable[],
  ): number {
    if (costUsd !== undefined) {
      return usdToMicros(count(costUsd, 'costUsd', false));
    }

    const required = applicable.some((entry) => entry.rule.costMicros !== null);
    const pricing = this.#priceFor(model, required);
    return pricing === null ? 0 : costMicrosOf(usage, pricing);
  }

  /**
   * An unpriced model is an unbounded one, so a missing price throws when a
   * cost limit applies. When none does, cost is still tracked where a price
   * happens to be configured, and is simply zero where it is not.
   *
   * The table has a null prototype, built once in `validatePricing()`. A model
   * id is client-influenced data, and against an ordinary object a request
   * naming `constructor` or `toString` would resolve to an inherited value
   * instead of being reported as unknown.
   */
  #priceFor(model: string | undefined, required: boolean): ModelPricing | null {
    if (model === undefined) {
      if (required) throw new UnknownModelError(null);
      return null;
    }
    const pricing = this.#pricing[model];
    if (pricing === undefined) {
      if (required) throw new UnknownModelError(model);
      return null;
    }
    return pricing;
  }

  /**
   * The clock, checked. A window start outside the `Date` range makes every
   * bound `NaN`, which reads as a corrupt counter key and a counter that
   * never expires rather than as the configuration error it is.
   */
  #clock(): number {
    const now = this.#now();
    if (!Number.isFinite(now) || Math.abs(now) > MAX_TIME) {
      throw new InvalidConfigError(`the clock returned ${String(now)}, which is not a usable time`);
    }
    return now;
  }

  #applicable(
    subjects: Readonly<Record<string, string>> | undefined,
    now: number,
  ): readonly Applicable[] {
    const out: Applicable[] = [];

    for (const rule of this.#prepared) {
      let subject: string;

      if (rule.scope === 'global') {
        subject = GLOBAL_SUBJECT;
      } else {
        const given = subjects?.[rule.scope];
        if (given === undefined || given === '') {
          if (rule.optional) continue;
          throw new MissingSubjectError(rule.id, rule.scope);
        }
        if (typeof given !== 'string') {
          throw new InvalidUsageError(`subject '${rule.scope}' must be a string`);
        }
        subject = given;
      }

      const window = windowAt(rule.source.window, now);
      out.push({ rule, subject, window, key: counterKey(rule.id, subject, window.start) });
    }

    return out;
  }
}

class BudgetLease implements Lease {
  readonly reserved: Readonly<Counter>;

  readonly #guard: BudgetGuard;
  readonly #applicable: readonly Applicable[];
  readonly #model: string | undefined;
  #settled: 'commit' | 'release' | null = null;

  constructor(
    guard: BudgetGuard,
    applicable: readonly Applicable[],
    reserved: Counter,
    model: string | undefined,
  ) {
    this.#guard = guard;
    this.#applicable = applicable;
    this.#model = model;
    this.reserved = reserved;
  }

  /**
   * `async`, so a settled lease rejects rather than throwing synchronously:
   * a method typed `Promise<void>` that can throw before it returns one is a
   * trap for `.catch()`.
   *
   * The arguments are checked before the lease is claimed, so a bad usage
   * report -- a provider field that came back undefined, a mistyped model --
   * leaves the lease settleable and the caller's `catch { release() }` can
   * still refund the reservation. Everything up to the claim is synchronous,
   * so two settles that start in the same tick still cannot both proceed.
   */
  async commit(usage: CommitUsage = {}): Promise<void> {
    const inputTokens = count(usage.inputTokens ?? 0, 'inputTokens');
    const outputTokens = count(usage.outputTokens ?? 0, 'outputTokens');
    const actual = tokenUsage(inputTokens, outputTokens, usage);
    const costMicros = this.#guard.priceOf(
      actual,
      usage.model ?? this.#model,
      usage.costUsd,
      this.#applicable,
    );

    this.#claim('commit');

    const tokenDelta = inputTokens + outputTokens - this.reserved.tokens;
    const costDelta = costMicros - this.reserved.costMicros;
    if (tokenDelta === 0 && costDelta === 0) return;

    await this.#guard.settle(this.#applicable, {
      tokens: tokenDelta,
      costMicros: costDelta,
      requests: 0,
    });
  }

  async release(): Promise<void> {
    this.#claim('release');

    if (this.reserved.tokens === 0 && this.reserved.costMicros === 0) return;

    await this.#guard.settle(this.#applicable, {
      tokens: -this.reserved.tokens,
      costMicros: -this.reserved.costMicros,
      requests: 0,
    });
  }

  #claim(as: 'commit' | 'release'): void {
    if (this.#settled !== null) throw new LeaseSettledError(this.#settled);
    this.#settled = as;
  }
}

function prepareRule(rule: BudgetRule): PreparedRule {
  if (rule === null || typeof rule !== 'object') {
    throw new InvalidConfigError('every rule must be an object');
  }
  validateRuleId(rule.id);
  validateWindow(rule.window, rule.id);

  if (typeof rule.scope !== 'string' || rule.scope === '') {
    throw new InvalidConfigError(`rule '${rule.id}' needs a non-empty scope`);
  }
  if (rule.limits === null || typeof rule.limits !== 'object') {
    throw new InvalidConfigError(`rule '${rule.id}' needs a limits object`);
  }

  const tokens = limit(rule.limits.tokens, rule.id, 'tokens', true);
  const requests = limit(rule.limits.requests, rule.id, 'requests', true);
  const costUsd = limit(rule.limits.costUsd, rule.id, 'costUsd', false);

  if (tokens === null && requests === null && costUsd === null) {
    throw new InvalidConfigError(
      `rule '${rule.id}' limits nothing. Set at least one of tokens, costUsd or requests.`,
    );
  }

  const costMicros = costUsd === null ? null : usdToMicros(costUsd);
  const limits: Partial<Counter> = {};
  if (tokens !== null) limits.tokens = tokens;
  if (costMicros !== null) limits.costMicros = costMicros;
  if (requests !== null) limits.requests = requests;

  return {
    source: rule,
    id: rule.id,
    scope: rule.scope,
    optional: rule.optional === true,
    tokens,
    costMicros,
    requests,
    limits,
  };
}

function limit(
  value: number | undefined,
  ruleId: string,
  name: string,
  integer: boolean,
): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidConfigError(
      `rule '${ruleId}' has limits.${name} = ${String(value)}; it must be a positive finite number`,
    );
  }
  if (integer && !Number.isInteger(value)) {
    throw new InvalidConfigError(`rule '${ruleId}' has a non-integer limits.${name}`);
  }
  return value;
}

/**
 * Validates the price list and copies it into a table with no prototype.
 *
 * A model id reaches this library from the same place the prompt does, and a
 * lookup against an ordinary object answers `constructor`, `toString`,
 * `valueOf` and `__proto__` with inherited values. That would skip
 * `UnknownModelError` under a cost limit and price the call at `NaN`, which
 * compares false against every limit -- one request disabling a rule for the
 * rest of its window. A null prototype has nothing to inherit.
 *
 * The copy also detaches the table from the object the caller passed, so a
 * later mutation of theirs cannot change what a running guard charges.
 */
function validatePricing(pricing: PricingTable | undefined): PricingTable {
  const table: Record<string, ModelPricing> = Object.create(null) as Record<string, ModelPricing>;
  if (pricing === undefined) return table;
  if (pricing === null || typeof pricing !== 'object') {
    throw new InvalidConfigError('pricing must be an object keyed by model id');
  }

  for (const [model, prices] of Object.entries(pricing)) {
    if (prices === null || typeof prices !== 'object') {
      throw new InvalidConfigError(`pricing for '${model}' must be an object`);
    }
    for (const field of ['input', 'output', 'cachedInput', 'cacheWrite'] as const) {
      const value = prices[field];
      if ((field === 'cachedInput' || field === 'cacheWrite') && value === undefined) continue;

      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new InvalidConfigError(
          `pricing for '${model}' has ${field} = ${String(value)}; it must be a non-negative finite number`,
        );
      }
    }
    table[model] = prices;
  }

  return table;
}

function validateDefaultMaxOutput(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidConfigError(
      `defaultMaxOutputTokens must be a non-negative integer, got ${String(value)}`,
    );
  }
  return value;
}

/** A finite, non-negative count. Integers unless `integer` is false. */
function count(value: number, name: string, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InvalidUsageError(
      `${name} must be a non-negative finite number, got ${String(value)}`,
    );
  }
  if (integer && !Number.isInteger(value)) {
    throw new InvalidUsageError(`${name} must be an integer, got ${String(value)}`);
  }
  return value;
}

function tokenUsage(
  inputTokens: number,
  outputTokens: number,
  parts: { readonly cachedInputTokens?: number; readonly cacheWriteTokens?: number },
): TokenUsage {
  const cachedInputTokens = count(parts.cachedInputTokens ?? 0, 'cachedInputTokens');
  const cacheWriteTokens = count(parts.cacheWriteTokens ?? 0, 'cacheWriteTokens');

  if (cachedInputTokens + cacheWriteTokens > inputTokens) {
    throw new InvalidUsageError(
      'cachedInputTokens and cacheWriteTokens are parts of inputTokens, so together they cannot exceed it',
    );
  }

  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens };
}

function dimension(used: number, limitValue: number | null): UsageDimension {
  return {
    used,
    limit: limitValue,
    remaining: limitValue === null ? null : Math.max(0, limitValue - used),
  };
}

/** Turn a refused `consume()` into the error the caller can act on. */
function refusal(
  applicable: readonly Applicable[],
  key: string,
  current: Counter,
  requested: Counter,
  now: number,
): BudgetExceededError {
  const entry = applicable.find((candidate) => candidate.key === key);
  if (entry === undefined) {
    // Attributing the refusal to another rule would name the wrong limit and
    // the wrong numbers. Say what went wrong instead, and still refuse.
    throw new InvalidConfigError(
      `the store refused an unknown counter key '${key}', which this call never asked about`,
    );
  }

  const dimensionName =
    DIMENSIONS.find((name) => {
      const ruleLimit = entry.rule[name];
      return ruleLimit !== null && current[name] + requested[name] > ruleLimit;
    }) ?? 'tokens';

  return new BudgetExceededError({
    rule: entry.rule.id,
    scope: entry.rule.scope,
    subject: entry.subject,
    dimension: dimensionName,
    limit: entry.rule[dimensionName] ?? 0,
    used: current[dimensionName],
    requested: requested[dimensionName],
    resetAt: entry.window.resetAt,
    retryAfterSeconds: retryAfterSeconds(entry.window.resetAt, now),
  });
}
