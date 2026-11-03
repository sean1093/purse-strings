import { InvalidConfigError, InvalidUsageError } from '../../errors.js';
import type { BudgetStore, ConsumeResult, Counter, CounterUpdate } from '../../types.js';
import { assertFiniteUpdates } from '../updates.js';

/**
 * Workers KV refuses an absolute `expiration` under 60 seconds away, and a
 * window shorter than that is a real configuration: a per-minute rule ends
 * within 60 seconds of starting. The expiration is pushed out to that floor
 * rather than the write being refused. It costs nothing: KV's expiry is
 * garbage collection, and the `expiresAt` inside the value is what a read is
 * actually checked against, so the key simply outlives its window and reads
 * as zeros for the rest of its life.
 */
const MIN_EXPIRATION_SECONDS = 60;

/** Workers KV allows 512 bytes per key. */
const MAX_KEY_BYTES = 512;

const utf8 = new TextEncoder();

export interface KVPutOptions {
  /** Absolute expiry, in seconds since the Unix epoch. */
  readonly expiration?: number;
}

/**
 * The part of a `KVNamespace` binding this store uses, typed structurally so
 * the package does not depend on the Workers type definitions. The binding
 * `wrangler types` generates, the one from `@cloudflare/workers-types` and
 * the one Miniflare hands back all fit it.
 */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KVPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface KVStoreOptions {
  /** Prefixed to every counter key, so one namespace can hold other data too. */
  readonly prefix?: string;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** What one key holds. Short field names: KV bills for stored bytes. */
interface Stored {
  /** Tokens. */
  t: number;
  /** Micro-dollars. */
  c: number;
  /** Requests. */
  r: number;
  /** Epoch milliseconds, or `null` for a counter that never expires. */
  e: number | null;
}

interface Slot {
  readonly key: string;
  counter: Counter;
  expiresAt: number | null;
  /** The key exists and has not expired. */
  stored: boolean;
  touched: boolean;
}

/**
 * Counters in Workers KV.
 *
 * KV is the cheapest shared state on Cloudflare and is already bound to many
 * Workers. It is also eventually consistent and has no compare-and-set: a
 * read and a write are two independent operations, and a write takes up to a
 * minute to reach every edge location. Two requests that start at the same
 * time read the same value and both pass.
 *
 * So this store reports `consistency: 'eventual'`, which downgrades every
 * rule on it to a soft limit. It suits a sequential agent loop, where each
 * step reads what the step before it wrote, and a per-user cap where one user
 * is one client making one request at a time. It is not a defence against
 * concurrent abuse — that is what `DurableObjectStore` is for.
 *
 * KV also allows about one write per second to a single key, and a model call
 * is two writes to each counter it touches. A global rule on KV is one key
 * for the whole fleet, which is past that rate as soon as the service is
 * busy.
 */
export class KVStore implements BudgetStore {
  readonly consistency = 'eventual';

  readonly #kv: KVNamespaceLike;
  readonly #prefix: string;
  readonly #now: () => number;

  constructor(namespace: KVNamespaceLike, options: KVStoreOptions = {}) {
    if (
      namespace === null ||
      typeof namespace !== 'object' ||
      typeof namespace.get !== 'function' ||
      typeof namespace.put !== 'function' ||
      typeof namespace.delete !== 'function'
    ) {
      throw new InvalidConfigError(
        'KVStore needs a KV namespace binding with get(), put() and delete()',
      );
    }

    this.#kv = namespace;
    this.#prefix = options.prefix ?? '';
    this.#now = options.now ?? Date.now;
  }

  /**
   * Reads every counter, checks the limits, then writes the ones that
   * changed. None of that is atomic, and on KV none of it can be. What does
   * hold is that a refused batch writes nothing: the limits are all checked
   * before the first write goes out.
   */
  async consume(updates: readonly CounterUpdate[]): Promise<ConsumeResult> {
    assertFiniteUpdates(updates);
    if (updates.length === 0) return { ok: true };

    const slots = await this.#load(updates);

    for (const update of updates) {
      const slot = slots.get(update.key) as Slot;
      const next = apply(slot.counter, update.delta, false);

      if (exceeds(next, update.limits)) {
        return { ok: false, key: update.key, current: slot.counter };
      }

      slot.counter = next;
      slot.touched = true;
    }

    await this.#flush(slots);
    return { ok: true };
  }

  async add(updates: readonly CounterUpdate[]): Promise<void> {
    assertFiniteUpdates(updates);
    if (updates.length === 0) return;

    const slots = await this.#load(updates);

    for (const update of updates) {
      const slot = slots.get(update.key) as Slot;
      slot.counter = apply(slot.counter, update.delta, true);
      slot.touched = true;
    }

    await this.#flush(slots);
  }

  async read(keys: readonly string[]): Promise<Counter[]> {
    const now = this.#now();
    return Promise.all(
      keys.map(async (key) => {
        const stored = live(await this.#kv.get(this.#name(key)), now);
        return stored === null
          ? { tokens: 0, costMicros: 0, requests: 0 }
          : { tokens: stored.t, costMicros: stored.c, requests: stored.r };
      }),
    );
  }

  /** One slot per distinct key, each holding what KV currently has. */
  async #load(updates: readonly CounterUpdate[]): Promise<Map<string, Slot>> {
    const now = this.#now();
    const slots = new Map<string, Slot>();

    for (const update of updates) {
      if (slots.has(update.key)) continue;
      slots.set(update.key, {
        key: update.key,
        counter: { tokens: 0, costMicros: 0, requests: 0 },
        expiresAt: update.expiresAt,
        stored: false,
        touched: false,
      });
    }

    await Promise.all(
      [...slots.values()].map(async (slot) => {
        const stored = live(await this.#kv.get(this.#name(slot.key)), now);
        if (stored === null) return;

        slot.counter = { tokens: stored.t, costMicros: stored.c, requests: stored.r };
        // A live key keeps the window it started in: a later call in the same
        // window does not extend it.
        slot.expiresAt = stored.e;
        slot.stored = true;
      }),
    );

    return slots;
  }

  /**
   * A failed write propagates. A store that swallowed one would leave the
   * guard admitting calls against a counter that never moved, so the request
   * fails and the model is not called: the direction a spending control has
   * to fail in. Writes that had already landed stay, which over-counts rather
   * than under-counts.
   */
  async #flush(slots: Map<string, Slot>): Promise<void> {
    const writes: Promise<void>[] = [];

    for (const slot of slots.values()) {
      if (!slot.touched) continue;
      // A refund whose window has already rolled over clamps to zeros against
      // a key that is gone. Writing it back would be a write, and a stored
      // value, for a counter that is already zero.
      if (!slot.stored && isZero(slot.counter)) continue;

      const value: Stored = {
        t: slot.counter.tokens,
        c: slot.counter.costMicros,
        r: slot.counter.requests,
        e: slot.expiresAt,
      };
      writes.push(
        this.#kv.put(this.#name(slot.key), JSON.stringify(value), expirationFor(slot.expiresAt)),
      );
    }

    await Promise.all(writes);
  }

  #name(key: string): string {
    const name = `${this.#prefix}${key}`;
    const bytes = utf8.encode(name).length;

    if (name === '' || bytes > MAX_KEY_BYTES) {
      throw new InvalidUsageError(
        `counter key ${JSON.stringify(name)} is ${bytes} bytes, outside the 1 to ${MAX_KEY_BYTES} Workers KV allows`,
      );
    }

    return name;
  }
}

/**
 * KV checks `expiration` against its own wall clock, not against the store's
 * injectable one: this is a platform instruction, where `expiresAt` inside
 * the value is the enforcement. A test that runs on an injected clock still
 * has to hand KV a time KV accepts.
 */
function expirationFor(expiresAt: number | null): KVPutOptions | undefined {
  if (expiresAt === null) return undefined;

  const floor = Math.floor(Date.now() / 1000) + MIN_EXPIRATION_SECONDS;
  return { expiration: Math.max(Math.ceil(expiresAt / 1000), floor) };
}

/** `clamp` is for `add()`, which is unconditional and never goes below zero. */
function apply(counter: Counter, delta: Readonly<Counter>, clamp: boolean): Counter {
  const tokens = counter.tokens + delta.tokens;
  const costMicros = counter.costMicros + delta.costMicros;
  const requests = counter.requests + delta.requests;

  if (!clamp) return { tokens, costMicros, requests };
  return {
    tokens: Math.max(0, tokens),
    costMicros: Math.max(0, costMicros),
    requests: Math.max(0, requests),
  };
}

function exceeds(counter: Counter, limits: Readonly<Partial<Counter>> | undefined): boolean {
  if (limits === undefined) return false;
  return (
    (limits.tokens !== undefined && counter.tokens > limits.tokens) ||
    (limits.costMicros !== undefined && counter.costMicros > limits.costMicros) ||
    (limits.requests !== undefined && counter.requests > limits.requests)
  );
}

function isZero(counter: Counter): boolean {
  return counter.tokens === 0 && counter.costMicros === 0 && counter.requests === 0;
}

/** The stored counter, if the value is one this store wrote and still live. */
function live(raw: string | null, now: number): Stored | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A value this store did not write, or one truncated in flight. Reading
    // it as absent restarts one window from zero, which under-counts once;
    // reading it as a counter would put NaN into every later comparison, and
    // a comparison against NaN is false, so the rule would stop limiting.
    return null;
  }

  if (parsed === null || typeof parsed !== 'object') return null;
  const stored = parsed as Partial<Stored>;

  const expiresAt = typeof stored.e === 'number' && Number.isFinite(stored.e) ? stored.e : null;
  if (expiresAt !== null && expiresAt <= now) return null;

  return { t: numberOf(stored.t), c: numberOf(stored.c), r: numberOf(stored.r), e: expiresAt };
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
