import { describe, expect, it } from 'vitest';
import type { BudgetStore, Counter, CounterUpdate } from '../../src/types.js';

/**
 * The contract every `BudgetStore` has to satisfy, run against a real
 * instance rather than a mock. A store is the only part of the library that
 * touches the outside world, and the guarantee in the threat model is only as
 * strong as the store beneath it, so this suite is what an adapter is trusted
 * on.
 *
 * Expiry is driven by `setNow`, not by waiting: a store must treat a counter
 * at or past its `expiresAt` as zeros whether or not the platform has deleted
 * it yet. Platform TTL is garbage collection and is allowed to lag.
 */
export interface StoreContext {
  readonly store: BudgetStore;
  /** Move the store's view of the clock to this epoch-millisecond value. */
  setNow(ms: number): void;
  dispose?(): void | Promise<void>;
}

export type StoreFactory = (startedAt: number) => StoreContext | Promise<StoreContext>;

/** Backends are shared across tests, so every test works on keys nobody else uses. */
let sequence = 0;

function freshKeys(howMany: number): string[] {
  sequence += 1;
  const prefix = `contract-${sequence}-${Math.random().toString(36).slice(2, 10)}`;
  return Array.from({ length: howMany }, (_, index) => `${prefix}-${index}`);
}

function counter(tokens: number, costMicros: number, requests: number): Counter {
  return { tokens, costMicros, requests };
}

const ZERO: Counter = counter(0, 0, 0);

/** 2026-03-01T00:00:00Z: an arbitrary but fixed start, so failures are reproducible. */
const START = Date.UTC(2026, 2, 1);

export function runStoreContract(name: string, create: StoreFactory): void {
  describe(`BudgetStore contract: ${name}`, () => {
    async function withStore<T>(body: (context: StoreContext) => Promise<T>): Promise<T> {
      const context = await create(START);
      try {
        return await body(context);
      } finally {
        await context.dispose?.();
      }
    }

    it('reads missing keys as zeros, in the order they were given', async () => {
      await withStore(async ({ store }) => {
        const [a, b, c] = freshKeys(3) as [string, string, string];
        await store.consume([
          { key: b, delta: counter(7, 11, 1), limits: { tokens: 100 }, expiresAt: null },
        ]);

        expect(await store.read([a, b, c])).toEqual([ZERO, counter(7, 11, 1), ZERO]);
      });
    });

    it('books every counter of a successful consume', async () => {
      await withStore(async ({ store }) => {
        const [a, b] = freshKeys(2) as [string, string];
        const updates: CounterUpdate[] = [
          { key: a, delta: counter(10, 20, 1), limits: { tokens: 100 }, expiresAt: null },
          { key: b, delta: counter(10, 20, 1), limits: { costMicros: 100 }, expiresAt: null },
        ];

        expect(await store.consume(updates)).toEqual({ ok: true });
        expect(await store.consume(updates)).toEqual({ ok: true });
        expect(await store.read([a, b])).toEqual([counter(20, 40, 2), counter(20, 40, 2)]);
      });
    });

    it('writes nothing when any counter in the batch would exceed its limit', async () => {
      await withStore(async ({ store }) => {
        const [a, b] = freshKeys(2) as [string, string];
        await store.consume([
          { key: a, delta: counter(5, 0, 1), limits: { tokens: 100 }, expiresAt: null },
        ]);

        const result = await store.consume([
          { key: a, delta: counter(5, 0, 1), limits: { tokens: 100 }, expiresAt: null },
          { key: b, delta: counter(5, 0, 1), limits: { tokens: 4 }, expiresAt: null },
        ]);

        expect(result).toEqual({ ok: false, key: b, current: ZERO });
        // The first counter kept its earlier value: the batch is all or nothing.
        expect(await store.read([a, b])).toEqual([counter(5, 0, 1), ZERO]);
      });
    });

    it('reports the current counter of the key that refused', async () => {
      await withStore(async ({ store }) => {
        const [a] = freshKeys(1) as [string];
        await store.consume([
          { key: a, delta: counter(8, 3, 1), limits: { tokens: 10 }, expiresAt: null },
        ]);

        const result = await store.consume([
          { key: a, delta: counter(8, 3, 1), limits: { tokens: 10 }, expiresAt: null },
        ]);

        expect(result).toEqual({ ok: false, key: a, current: counter(8, 3, 1) });
      });
    });

    it('checks each dimension against its own limit and leaves unlimited ones alone', async () => {
      await withStore(async ({ store }) => {
        const [tokensKey, costKey, requestsKey] = freshKeys(3) as [string, string, string];

        // Every dimension moves, but only one of them is limited each time.
        const refusedOnTokens = await store.consume([
          {
            key: tokensKey,
            delta: counter(11, 10_000, 9),
            limits: { tokens: 10 },
            expiresAt: null,
          },
        ]);
        const refusedOnCost = await store.consume([
          {
            key: costKey,
            delta: counter(10_000, 11, 9),
            limits: { costMicros: 10 },
            expiresAt: null,
          },
        ]);
        const refusedOnRequests = await store.consume([
          {
            key: requestsKey,
            delta: counter(10_000, 10_000, 2),
            limits: { requests: 1 },
            expiresAt: null,
          },
        ]);

        expect([refusedOnTokens.ok, refusedOnCost.ok, refusedOnRequests.ok]).toEqual([
          false,
          false,
          false,
        ]);
        expect(await store.read([tokensKey, costKey, requestsKey])).toEqual([ZERO, ZERO, ZERO]);

        // Exactly at the limit is allowed; one past it is not.
        expect(
          await store.consume([
            {
              key: tokensKey,
              delta: counter(10, 10_000, 9),
              limits: { tokens: 10 },
              expiresAt: null,
            },
          ]),
        ).toEqual({ ok: true });
        expect(
          await store.consume([
            { key: tokensKey, delta: counter(1, 0, 0), limits: { tokens: 10 }, expiresAt: null },
          ]),
        ).toEqual({ ok: false, key: tokensKey, current: counter(10, 10_000, 9) });
      });
    });

    it('never refuses a counter that carries no limits', async () => {
      await withStore(async ({ store }) => {
        const [a] = freshKeys(1) as [string];
        const update: CounterUpdate = { key: a, delta: counter(1_000, 1_000, 1), expiresAt: null };

        expect(await store.consume([update])).toEqual({ ok: true });
        expect(await store.consume([update])).toEqual({ ok: true });
        expect(await store.read([a])).toEqual([counter(2_000, 2_000, 2)]);
      });
    });

    it('rejects a non-finite delta instead of writing it', async () => {
      await withStore(async ({ store }) => {
        const [a] = freshKeys(1) as [string];
        const poison: CounterUpdate = {
          key: a,
          delta: { tokens: Number.NaN, costMicros: Number.POSITIVE_INFINITY, requests: 1 },
          limits: { tokens: 10 },
          expiresAt: null,
        };

        // Every limit check is a `>` comparison, and one against NaN is
        // false: a counter that absorbed this would pass every later check
        // too, so the rule it belongs to would stop limiting that dimension.
        await expect(store.consume([poison])).rejects.toThrow();
        await expect(store.add([poison])).rejects.toThrow();
        expect(await store.read([a])).toEqual([ZERO]);
      });
    });

    it('applies add() unconditionally, past any limit', async () => {
      await withStore(async ({ store }) => {
        const [a] = freshKeys(1) as [string];
        await store.consume([
          { key: a, delta: counter(10, 10, 1), limits: { tokens: 10 }, expiresAt: null },
        ]);

        await store.add([{ key: a, delta: counter(90, 90, 0), expiresAt: null }]);

        expect(await store.read([a])).toEqual([counter(100, 100, 1)]);
      });
    });

    it('never lets add() take a dimension below zero', async () => {
      await withStore(async ({ store }) => {
        const [existing, missing] = freshKeys(2) as [string, string];
        await store.add([{ key: existing, delta: counter(5, 5, 1), expiresAt: null }]);

        await store.add([
          { key: existing, delta: counter(-50, -1, -50), expiresAt: null },
          { key: missing, delta: counter(-7, -7, -7), expiresAt: null },
        ]);

        expect(await store.read([existing, missing])).toEqual([counter(0, 4, 0), ZERO]);
      });
    });

    it('reads an expired counter as zeros and starts the next window from zero', async () => {
      await withStore(async ({ store, setNow }) => {
        const [a] = freshKeys(1) as [string];
        const expiresAt = START + 60_000;

        expect(
          await store.consume([
            { key: a, delta: counter(9, 9, 1), limits: { tokens: 10 }, expiresAt },
          ]),
        ).toEqual({ ok: true });
        expect(await store.read([a])).toEqual([counter(9, 9, 1)]);

        setNow(expiresAt);

        expect(await store.read([a])).toEqual([ZERO]);
        expect(
          await store.consume([
            {
              key: a,
              delta: counter(9, 9, 1),
              limits: { tokens: 10 },
              expiresAt: expiresAt + 60_000,
            },
          ]),
        ).toEqual({ ok: true });
        expect(await store.read([a])).toEqual([counter(9, 9, 1)]);
      });
    });

    it('keeps a counter with no expiry', async () => {
      await withStore(async ({ store, setNow }) => {
        const [a] = freshKeys(1) as [string];
        await store.add([{ key: a, delta: counter(3, 3, 1), expiresAt: null }]);

        setNow(START + 400 * 86_400_000);

        expect(await store.read([a])).toEqual([counter(3, 3, 1)]);
      });
    });

    it('admits exactly the reservations that fit when they run concurrently', async function concurrency() {
      const probe = await create(START);
      const strong = probe.store.consistency === 'strong';
      await probe.dispose?.();

      // An eventually consistent store cannot promise this, and says so.
      // Asserting it here would be a claim the store never made.
      if (!strong) return;

      await withStore(async ({ store }) => {
        const [a] = freshKeys(1) as [string];
        const attempts = 24;
        const perAttempt = 10;
        const limit = 100;

        const results = await Promise.all(
          Array.from({ length: attempts }, () =>
            store.consume([
              {
                key: a,
                delta: counter(perAttempt, 0, 1),
                limits: { tokens: limit },
                expiresAt: null,
              },
            ]),
          ),
        );

        const admitted = results.filter((result) => result.ok).length;
        expect(admitted).toBe(limit / perAttempt);
        expect(await store.read([a])).toEqual([counter(limit, 0, limit / perAttempt)]);
      });
    });
  });
}
