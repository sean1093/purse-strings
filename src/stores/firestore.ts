/**
 * Firestore counters.
 *
 * Firestore is the shared store for Firebase and Google Cloud apps, and its
 * transactions are what make a budget hold across instances: `consume()`
 * reads every counter in the batch and writes them all in one transaction,
 * so two reservations that together exceed a limit cannot both succeed.
 *
 * Nothing from `@google-cloud/firestore` or `firebase-admin` is imported, at
 * build time or at run time. The parameters below are structural types naming
 * only the members this store calls, so a `Firestore` instance from either
 * package fits one without the package being a dependency of this one.
 */

import { InvalidConfigError, InvalidUsageError } from '../errors.js';
import type { BudgetStore, ConsumeResult, Counter, CounterUpdate } from '../types.js';
import { assertFiniteUpdates } from './updates.js';

/** The collection counter documents live in unless another name is given. */
const DEFAULT_COLLECTION = 'budgetCounters';

/**
 * How many times a refused transaction is retried. Firestore's own default is
 * five; a global counter is one document that every request in the fleet
 * writes, which is exactly the shape that runs out of attempts.
 */
const DEFAULT_MAX_ATTEMPTS = 10;

/** Firestore document ids that address something other than a document. */
const RESERVED_ID = /^__.*__$/;

export interface FirestoreDocumentData {
  readonly [field: string]: unknown;
}

export interface FirestoreDocumentSnapshot {
  readonly exists: boolean;
  data(): FirestoreDocumentData | undefined;
}

/**
 * A document handle, opaque on purpose: this store only ever receives one
 * from `doc()` and hands it straight back to `getAll()`, `set()` or
 * `delete()`. Naming a member of it would make the type fail against the
 * real signatures, where `getAll()` takes a union of references and read
 * options and nothing in that union has a member in common with the other.
 */
export type FirestoreDocumentReference = object;

export interface FirestoreCollectionReference {
  doc(documentPath: string): FirestoreDocumentReference;
}

export interface FirestoreTransaction {
  getAll(...refs: FirestoreDocumentReference[]): Promise<FirestoreDocumentSnapshot[]>;
  set(ref: FirestoreDocumentReference, data: FirestoreDocumentData): void;
  delete(ref: FirestoreDocumentReference): void;
}

export interface FirestoreTransactionOptions {
  readonly maxAttempts?: number;
}

/**
 * The part of a `Firestore` instance this store uses. Satisfied by the
 * `Firestore` class of `@google-cloud/firestore` and by the one
 * `firebase-admin/firestore` returns.
 */
export interface FirestoreLike {
  collection(collectionPath: string): FirestoreCollectionReference;
  getAll(...refs: FirestoreDocumentReference[]): Promise<FirestoreDocumentSnapshot[]>;
  runTransaction<T>(
    updateFunction: (transaction: FirestoreTransaction) => Promise<T>,
    options?: FirestoreTransactionOptions,
  ): Promise<T>;
}

export interface FirestoreStoreOptions {
  /** Collection the counter documents live in. Defaults to `budgetCounters`. */
  readonly collection?: string;
  /** How many times a transaction refused for contention is retried. Defaults to 10. */
  readonly maxAttempts?: number;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** One counter document while a batch is being worked out. */
interface Slot {
  readonly ref: FirestoreDocumentReference;
  /** The stored value, or zeros when the document is missing or expired. */
  counter: Counter;
  /** The expiry to store: the live document's, or the first update's. */
  expiresAt: number | null;
  /** Something in this batch changes the document. */
  touched: boolean;
}

/**
 * Counters in Firestore, shared by every instance of a service.
 *
 * Counter documents hold `tokens`, `costMicros`, `requests` and `expiresAt`,
 * a timestamp. Enable a TTL policy on `expiresAt` so Firestore deletes a
 * finished window's counters for you; this store never depends on that
 * having happened, because it reads a document at or past its `expiresAt` as
 * zeros. TTL deletion is garbage collection, and Firestore allows it to lag
 * by up to 24 hours.
 *
 * A global rule is one document that every request writes, and Firestore
 * sustains about one write per second on a single document before latency
 * climbs and transactions start being refused for contention. Scope the rules
 * that run on Firestore to a user, a session or a tenant, and keep a global
 * cap either on a Durable Object or on a sharded counter of your own.
 */
export class FirestoreStore implements BudgetStore {
  readonly consistency = 'strong';

  readonly #firestore: FirestoreLike;
  readonly #collection: FirestoreCollectionReference;
  readonly #transactionOptions: FirestoreTransactionOptions;
  readonly #now: () => number;

  constructor(firestore: FirestoreLike, options: FirestoreStoreOptions = {}) {
    if (
      firestore === null ||
      typeof firestore !== 'object' ||
      typeof firestore.collection !== 'function' ||
      typeof firestore.getAll !== 'function' ||
      typeof firestore.runTransaction !== 'function'
    ) {
      throw new InvalidConfigError(
        'FirestoreStore needs a Firestore instance with collection(), getAll() and runTransaction()',
      );
    }

    const collection = options.collection ?? DEFAULT_COLLECTION;
    if (collection === '' || collection.includes('/')) {
      throw new InvalidConfigError(
        `collection ${JSON.stringify(collection)} is not a Firestore collection id`,
      );
    }

    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new InvalidConfigError(
        `maxAttempts must be a positive integer, got ${String(maxAttempts)}`,
      );
    }

    this.#firestore = firestore;
    this.#collection = firestore.collection(collection);
    this.#transactionOptions = { maxAttempts };
    this.#now = options.now ?? Date.now;
  }

  async consume(updates: readonly CounterUpdate[]): Promise<ConsumeResult> {
    assertFiniteUpdates(updates);
    if (updates.length === 0) return { ok: true };

    const now = this.#now();
    const refs = this.#refs(updates);

    return this.#firestore.runTransaction(async (transaction): Promise<ConsumeResult> => {
      const slots = await load(refs, updates, now, (handles) => transaction.getAll(...handles));

      for (const update of updates) {
        const slot = slots.get(update.key) as Slot;
        const next = apply(slot.counter, update.delta, false);

        if (exceeds(next, update.limits)) {
          // Nothing has been written yet: a Firestore transaction holds its
          // writes until the function returns, so returning here leaves every
          // counter in the batch untouched.
          return { ok: false, key: update.key, current: slot.counter };
        }

        slot.counter = next;
        slot.touched = true;
      }

      write(transaction, slots);
      return { ok: true };
    }, this.#transactionOptions);
  }

  async add(updates: readonly CounterUpdate[]): Promise<void> {
    assertFiniteUpdates(updates);
    if (updates.length === 0) return;

    const now = this.#now();
    const refs = this.#refs(updates);

    await this.#firestore.runTransaction(async (transaction): Promise<void> => {
      const slots = await load(refs, updates, now, (handles) => transaction.getAll(...handles));

      for (const update of updates) {
        const slot = slots.get(update.key) as Slot;
        slot.counter = apply(slot.counter, update.delta, true);
        slot.touched = true;
      }

      write(transaction, slots);
    }, this.#transactionOptions);
  }

  async read(keys: readonly string[]): Promise<Counter[]> {
    if (keys.length === 0) return [];

    const now = this.#now();
    const snapshots = await this.#firestore.getAll(...keys.map((key) => this.#doc(key)));

    return keys.map((_key, index) => counterOf(snapshots[index], now));
  }

  /**
   * One document handle per distinct key, in the order the keys first appear,
   * built once. A handle is immutable, and resolving it here means an
   * unusable key is refused before a transaction is opened rather than from
   * inside one.
   */
  #refs(updates: readonly CounterUpdate[]): Map<string, FirestoreDocumentReference> {
    const refs = new Map<string, FirestoreDocumentReference>();

    for (const update of updates) {
      if (refs.has(update.key)) continue;
      refs.set(update.key, this.#doc(update.key));
    }

    return refs;
  }

  #doc(key: string): FirestoreDocumentReference {
    if (key === '' || key.includes('/') || key === '.' || key === '..' || RESERVED_ID.test(key)) {
      throw new InvalidUsageError(
        `counter key ${JSON.stringify(key)} is not usable as a Firestore document id`,
      );
    }
    return this.#collection.doc(key);
  }
}

/**
 * Reads every counter in the batch and returns the slots a single attempt
 * works in.
 *
 * Built fresh on every call, because Firestore re-runs the whole transaction
 * function after a contention abort. State carried over from the previous
 * attempt would be added to the stored value a second time, and on a document
 * that does not exist yet — where there is no stored value to overwrite it —
 * that is a counter booked twice and a limit that admits one caller too many.
 *
 * A live document keeps its own expiry, so a window that has already started
 * is not extended by a later call in it; a missing or expired one takes the
 * expiry of the update that is about to create it.
 */
async function load(
  refs: ReadonlyMap<string, FirestoreDocumentReference>,
  updates: readonly CounterUpdate[],
  now: number,
  read: (handles: FirestoreDocumentReference[]) => Promise<FirestoreDocumentSnapshot[]>,
): Promise<Map<string, Slot>> {
  const slots = new Map<string, Slot>();

  for (const update of updates) {
    if (slots.has(update.key)) continue;
    slots.set(update.key, {
      ref: refs.get(update.key) as FirestoreDocumentReference,
      counter: { tokens: 0, costMicros: 0, requests: 0 },
      expiresAt: update.expiresAt,
      touched: false,
    });
  }

  const entries = [...slots.values()];
  const snapshots = await read(entries.map((slot) => slot.ref));

  for (let index = 0; index < entries.length; index += 1) {
    const slot = entries[index] as Slot;
    const stored = liveData(snapshots[index], now);
    if (stored === null) continue;

    slot.counter = {
      tokens: numberOf(stored.tokens),
      costMicros: numberOf(stored.costMicros),
      requests: numberOf(stored.requests),
    };
    slot.expiresAt = millisOf(stored.expiresAt);
  }

  return slots;
}

function write(transaction: FirestoreTransaction, slots: Map<string, Slot>): void {
  for (const slot of slots.values()) {
    if (!slot.touched) continue;
    transaction.set(slot.ref, {
      tokens: slot.counter.tokens,
      costMicros: slot.counter.costMicros,
      requests: slot.counter.requests,
      // A Date, not a number: Firestore stores it as a timestamp, which is
      // what a TTL policy on this field needs it to be.
      expiresAt: slot.expiresAt === null ? null : new Date(slot.expiresAt),
    });
  }
}

/** `clamp` is for `add()`, which is unconditional and never goes below zero. */
function apply(counter: Counter, delta: Readonly<Counter>, clamp: boolean): Counter {
  const tokens = counter.tokens + delta.tokens;
  const costMicros = counter.costMicros + delta.costMicros;
  const requests = counter.requests + delta.requests;

  return clamp
    ? {
        tokens: Math.max(0, tokens),
        costMicros: Math.max(0, costMicros),
        requests: Math.max(0, requests),
      }
    : { tokens, costMicros, requests };
}

function exceeds(counter: Counter, limits: Readonly<Partial<Counter>> | undefined): boolean {
  if (limits === undefined) return false;
  return (
    (limits.tokens !== undefined && counter.tokens > limits.tokens) ||
    (limits.costMicros !== undefined && counter.costMicros > limits.costMicros) ||
    (limits.requests !== undefined && counter.requests > limits.requests)
  );
}

/** The document's fields if it exists and has not expired, otherwise `null`. */
function liveData(
  snapshot: FirestoreDocumentSnapshot | undefined,
  now: number,
): FirestoreDocumentData | null {
  if (snapshot === undefined || !snapshot.exists) return null;

  const data = snapshot.data();
  if (data === undefined) return null;

  const expiresAt = millisOf(data.expiresAt);
  return expiresAt !== null && expiresAt <= now ? null : data;
}

function counterOf(snapshot: FirestoreDocumentSnapshot | undefined, now: number): Counter {
  const data = liveData(snapshot, now);
  if (data === null) return { tokens: 0, costMicros: 0, requests: 0 };

  return {
    tokens: numberOf(data.tokens),
    costMicros: numberOf(data.costMicros),
    requests: numberOf(data.requests),
  };
}

/**
 * Epoch milliseconds from whatever the driver handed back: a `Timestamp` from
 * Firestore itself, a `Date` from a store that was just written through the
 * same process, or nothing.
 */
function millisOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();

  const timestamp = value as { toMillis?: () => number };
  if (typeof timestamp.toMillis !== 'function') return null;

  const millis = timestamp.toMillis();
  return Number.isFinite(millis) ? millis : null;
}

/** A corrupt field reads as zero rather than poisoning every later comparison. */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
