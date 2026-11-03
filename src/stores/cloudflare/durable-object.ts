import { InvalidConfigError, InvalidUsageError } from '../../errors.js';
import type { BudgetStore, ConsumeResult, Counter, CounterUpdate } from '../../types.js';
import { assertFiniteUpdates } from '../updates.js';

/** The storage key the counter lives under. One object holds one counter. */
const RECORD = 'counter';

/**
 * The origin of the request the store sends to an object. A Durable Object
 * stub is addressed by name, not by URL, so this is only a well-formed URL
 * the handler ignores.
 */
const ENDPOINT = 'https://purse-strings.invalid/counter';

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DurableObjectStateLike {
  readonly storage: DurableObjectStorageLike;
}

/** A handle to one object. Opaque: the store gets one and hands it back. */
export type DurableObjectIdLike = object;

export interface DurableObjectResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface DurableObjectStubLike {
  fetch(
    input: string,
    init?: { method?: string; body?: string },
  ): Promise<DurableObjectResponseLike>;
}

/**
 * The part of a Durable Object namespace binding this store uses, typed
 * structurally so the package does not depend on the Workers type
 * definitions.
 */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface DurableObjectStoreOptions {
  /** Prefixed to every object name, so one namespace can hold other counters. */
  readonly prefix?: string;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** What one object stores. Short field names: it is written on every call. */
interface Record_ {
  t: number;
  c: number;
  r: number;
  /** Epoch milliseconds, or `null` for a counter that never expires. */
  e: number | null;
}

type Request_ =
  | {
      readonly op: 'consume';
      readonly now: number;
      readonly delta: Counter;
      readonly limits?: Partial<Counter>;
      readonly expiresAt: number | null;
    }
  | {
      readonly op: 'add';
      readonly now: number;
      readonly delta: Counter;
      readonly expiresAt: number | null;
    }
  | { readonly op: 'read'; readonly now: number };

type Reply =
  | { readonly ok: true; readonly counter: Counter }
  | { readonly ok: false; readonly counter: Counter };

const ZERO: Counter = { tokens: 0, costMicros: 0, requests: 0 };

/**
 * One counter, in a Durable Object.
 *
 * Export this from your Worker and bind it; `DurableObjectStore` talks to it.
 * Cloudflare routes every request for one object name to one instance and
 * runs them one at a time, so the read-check-write that KV cannot make atomic
 * is atomic here. That is what makes a Cloudflare budget a hard limit.
 *
 * The object sets an alarm for the end of the counter's window and deletes
 * its storage when the alarm fires, so a finished window costs nothing. The
 * handler never relies on that having happened: a counter at or past its
 * `expiresAt` reads as zeros.
 *
 * It uses the fetch-handler form of the Durable Objects API —
 * `constructor(state, env)`, `fetch(request)`, `alarm()` — and imports
 * nothing from `cloudflare:workers`, so it works on any compatibility date
 * that supports Durable Objects.
 */
export class BudgetCounterObject {
  readonly #storage: DurableObjectStorageLike;

  constructor(state: DurableObjectStateLike, _env: unknown) {
    this.#storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const message = (await request.json()) as Request_;
    const stored = await this.#live(message.now);

    if (message.op === 'read') {
      return reply({ ok: true, counter: counterOf(stored) });
    }

    const clamp = message.op === 'add';
    const base = counterOf(stored);
    const next = apply(base, message.delta, clamp);

    if (message.op === 'consume' && exceeds(next, message.limits)) {
      return reply({ ok: false, counter: base });
    }

    // A live counter keeps the window it started in: a later call in the same
    // window does not extend it.
    const expiresAt = stored === null ? message.expiresAt : stored.e;

    if (stored === null && isZero(next)) {
      // A refund whose window has already rolled over. Nothing to store, and
      // nothing to set an alarm for.
      return reply({ ok: true, counter: next });
    }

    await this.#storage.put<Record_>(RECORD, {
      t: next.tokens,
      c: next.costMicros,
      r: next.requests,
      e: expiresAt,
    });
    // workerd schedules alarms against its own wall clock, not against the
    // store's injectable one. An expiry already behind the platform clock is
    // left unscheduled rather than fired at once: the alarm is garbage
    // collection, and deleting a counter that is still inside its window
    // would restart it at zero and admit a whole limit's worth of extra
    // traffic. On the default clock the condition always holds.
    if (stored === null && expiresAt !== null && expiresAt > Date.now()) {
      await this.#storage.setAlarm(expiresAt);
    }

    return reply({ ok: true, counter: next });
  }

  /** The window ended: the counter is dead weight, so the object drops it. */
  async alarm(): Promise<void> {
    await this.#storage.deleteAll();
  }

  async #live(now: number): Promise<Record_ | null> {
    const stored = await this.#storage.get<Record_>(RECORD);
    if (stored === undefined || stored === null) return null;

    const expiresAt = typeof stored.e === 'number' && Number.isFinite(stored.e) ? stored.e : null;
    if (expiresAt !== null && expiresAt <= now) return null;

    return { t: numberOf(stored.t), c: numberOf(stored.c), r: numberOf(stored.r), e: expiresAt };
  }
}

/**
 * Counters in Durable Objects: one object per counter, strongly consistent.
 *
 * A multi-counter `consume()` books each counter in turn and compensates the
 * ones it already booked when a later one refuses, so no counter is ever left
 * over its limit. The window where a compensation is still in flight is
 * visible: a concurrent request may be refused against a counter that is
 * about to be given back. Refusing a call that would have fit is the safe
 * side of that trade, and it is the only side a per-object lock can offer
 * without a distributed transaction.
 */
export class DurableObjectStore implements BudgetStore {
  readonly consistency = 'strong';

  readonly #namespace: DurableObjectNamespaceLike;
  readonly #prefix: string;
  readonly #now: () => number;

  constructor(namespace: DurableObjectNamespaceLike, options: DurableObjectStoreOptions = {}) {
    if (
      namespace === null ||
      typeof namespace !== 'object' ||
      typeof namespace.idFromName !== 'function' ||
      typeof namespace.get !== 'function'
    ) {
      throw new InvalidConfigError(
        'DurableObjectStore needs a Durable Object namespace binding with idFromName() and get()',
      );
    }

    this.#namespace = namespace;
    this.#prefix = options.prefix ?? '';
    this.#now = options.now ?? Date.now;
  }

  async consume(updates: readonly CounterUpdate[]): Promise<ConsumeResult> {
    assertFiniteUpdates(updates);
    if (updates.length === 0) return { ok: true };

    const now = this.#now();
    const booked: CounterUpdate[] = [];

    try {
      for (const update of updates) {
        const reply = await this.#call(update.key, {
          op: 'consume',
          now,
          delta: update.delta,
          ...(update.limits === undefined ? {} : { limits: update.limits }),
          expiresAt: update.expiresAt,
        });

        if (!reply.ok) {
          await this.#compensate(booked, now);
          return { ok: false, key: update.key, current: reply.counter };
        }

        booked.push(update);
      }
    } catch (error) {
      await this.#compensate(booked, now);
      throw error;
    }

    return { ok: true };
  }

  async add(updates: readonly CounterUpdate[]): Promise<void> {
    assertFiniteUpdates(updates);
    if (updates.length === 0) return;

    const now = this.#now();
    await Promise.all(
      updates.map((update) =>
        this.#call(update.key, {
          op: 'add',
          now,
          delta: update.delta,
          expiresAt: update.expiresAt,
        }),
      ),
    );
  }

  async read(keys: readonly string[]): Promise<Counter[]> {
    const now = this.#now();
    return Promise.all(
      keys.map(async (key) => (await this.#call(key, { op: 'read', now })).counter),
    );
  }

  /**
   * Gives back every counter this batch had already booked. Run in reverse,
   * so the counter booked last is freed first and the window in which a
   * concurrent caller sees a counter it should not is as short as possible.
   */
  async #compensate(booked: readonly CounterUpdate[], now: number): Promise<void> {
    for (let index = booked.length - 1; index >= 0; index -= 1) {
      const update = booked[index] as CounterUpdate;
      try {
        await this.#call(update.key, {
          op: 'add',
          now,
          delta: {
            tokens: -update.delta.tokens,
            costMicros: -update.delta.costMicros,
            requests: -update.delta.requests,
          },
          expiresAt: update.expiresAt,
        });
      } catch {
        // One object refusing its refund must not strand the rest. Leaving
        // the whole batch booked because the newest give-back failed would
        // over-count every counter instead of one, and it would turn a plain
        // refusal into a store error the caller cannot act on.
      }
    }
  }

  async #call(key: string, message: Request_): Promise<Reply> {
    const name = `${this.#prefix}${key}`;
    if (name === '') {
      throw new InvalidUsageError('a counter key cannot be empty');
    }

    const stub = this.#namespace.get(this.#namespace.idFromName(name));
    const response = await stub.fetch(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new InvalidUsageError(
        `the budget counter object for '${name}' answered ${response.status}`,
      );
    }

    return JSON.parse(await response.text()) as Reply;
  }
}

function reply(body: Reply): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function counterOf(stored: Record_ | null): Counter {
  return stored === null
    ? { ...ZERO }
    : { tokens: stored.t, costMicros: stored.c, requests: stored.r };
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

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
