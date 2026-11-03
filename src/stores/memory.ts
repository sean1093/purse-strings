import type { BudgetStore, ConsumeResult, Counter, CounterUpdate } from '../types.js';
import { assertFiniteUpdates } from './updates.js';

interface Entry {
  tokens: number;
  costMicros: number;
  requests: number;
  expiresAt: number | null;
}

export interface MemoryStoreOptions {
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * How many counters may accumulate before expired ones are swept. The
   * default is fine unless you have more than a few thousand live subjects.
   */
  readonly sweepAt?: number;
}

const DEFAULT_SWEEP_AT = 1024;

/**
 * Counters in one process.
 *
 * Strongly consistent *within that process*, which is what makes it safe for
 * a single-instance service and useless as a shared limit: N replicas each
 * enforce the configured limit, so the effective limit is N times what you
 * configured. For anything that scales horizontally, use a shared store.
 *
 * The strength comes for free from the runtime: `consume()` checks and
 * increments in one synchronous pass, and JavaScript does not interleave
 * synchronous code, so two concurrent reservations cannot both observe the
 * same pre-increment value.
 */
export class MemoryStore implements BudgetStore {
  readonly consistency = 'strong';

  readonly #counters = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #sweepAt: number;
  #sweepThreshold: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#sweepAt = options.sweepAt ?? DEFAULT_SWEEP_AT;
    this.#sweepThreshold = this.#sweepAt;
  }

  /** Entries held, including any that have expired but not yet been swept. */
  get size(): number {
    return this.#counters.size;
  }

  // `async`, so a rejected batch rejects rather than throwing synchronously
  // from a method typed `Promise`. The body has no `await`, so the
  // check-and-increment pass is still one uninterrupted run.
  async consume(updates: readonly CounterUpdate[]): Promise<ConsumeResult> {
    assertFiniteUpdates(updates);
    const now = this.#now();

    // Checked against the stored value plus the deltas earlier in this same
    // call, so a list that names one key twice cannot slip past its limit.
    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index] as CounterUpdate;
      const { limits } = update;
      if (limits === undefined) continue;

      const base = this.#entry(update.key, now);
      let tokens = base === undefined ? 0 : base.tokens;
      let costMicros = base === undefined ? 0 : base.costMicros;
      let requests = base === undefined ? 0 : base.requests;

      for (let earlier = 0; earlier < index; earlier += 1) {
        const other = updates[earlier] as CounterUpdate;
        if (other.key !== update.key) continue;
        tokens += other.delta.tokens;
        costMicros += other.delta.costMicros;
        requests += other.delta.requests;
      }

      if (
        (limits.tokens !== undefined && tokens + update.delta.tokens > limits.tokens) ||
        (limits.costMicros !== undefined &&
          costMicros + update.delta.costMicros > limits.costMicros) ||
        (limits.requests !== undefined && requests + update.delta.requests > limits.requests)
      ) {
        return Promise.resolve({
          ok: false,
          key: update.key,
          current: { tokens, costMicros, requests },
        });
      }
    }

    for (const update of updates) {
      this.#apply(update, now, false);
    }

    return { ok: true };
  }

  async add(updates: readonly CounterUpdate[]): Promise<void> {
    assertFiniteUpdates(updates);
    const now = this.#now();
    for (const update of updates) {
      this.#apply(update, now, true);
    }
  }

  async read(keys: readonly string[]): Promise<Counter[]> {
    const now = this.#now();
    const out: Counter[] = new Array(keys.length);

    for (let index = 0; index < keys.length; index += 1) {
      const entry = this.#entry(keys[index] as string, now);
      out[index] =
        entry === undefined
          ? { tokens: 0, costMicros: 0, requests: 0 }
          : { tokens: entry.tokens, costMicros: entry.costMicros, requests: entry.requests };
    }

    return out;
  }

  /** Drops every counter. Useful between tests. */
  clear(): void {
    this.#counters.clear();
    this.#sweepThreshold = this.#sweepAt;
  }

  /** The stored entry if it is still live; an expired one is deleted on the way. */
  #entry(key: string, now: number): Entry | undefined {
    const entry = this.#counters.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      this.#counters.delete(key);
      return undefined;
    }
    return entry;
  }

  #apply(update: CounterUpdate, now: number, clamp: boolean): void {
    const existing = this.#entry(update.key, now);
    const { delta } = update;

    if (existing === undefined) {
      const tokens = clamp ? Math.max(0, delta.tokens) : delta.tokens;
      const costMicros = clamp ? Math.max(0, delta.costMicros) : delta.costMicros;
      const requests = clamp ? Math.max(0, delta.requests) : delta.requests;
      if (tokens === 0 && costMicros === 0 && requests === 0) return;

      this.#sweepIfCrowded(now);
      this.#counters.set(update.key, { tokens, costMicros, requests, expiresAt: update.expiresAt });
      return;
    }

    existing.tokens = clamp
      ? Math.max(0, existing.tokens + delta.tokens)
      : existing.tokens + delta.tokens;
    existing.costMicros = clamp
      ? Math.max(0, existing.costMicros + delta.costMicros)
      : existing.costMicros + delta.costMicros;
    existing.requests = clamp
      ? Math.max(0, existing.requests + delta.requests)
      : existing.requests + delta.requests;
  }

  /**
   * Subjects are attacker-influenced, so a counter per subject per window is
   * growth an attacker controls. Expired entries are dropped lazily on
   * access, which never reaches the keys nobody touches again; this sweep is
   * what bounds the map. The threshold doubles after each sweep, so the cost
   * stays amortised constant as the live set genuinely grows.
   */
  #sweepIfCrowded(now: number): void {
    if (this.#counters.size < this.#sweepThreshold) return;

    for (const [key, entry] of this.#counters) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.#counters.delete(key);
    }

    this.#sweepThreshold = Math.max(this.#sweepAt, this.#counters.size * 2);
  }
}
