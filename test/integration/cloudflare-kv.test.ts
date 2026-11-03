import { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import { InvalidConfigError, InvalidUsageError } from '../../src/errors.js';
import { type KVNamespaceLike, KVStore } from '../../src/stores/cloudflare/kv.js';
import { runStoreContract } from '../contract/store-contract.js';

/**
 * The KV adapter against Miniflare, which runs the same workerd that
 * Cloudflare runs, with the real KV implementation behind it — including its
 * refusal of an `expiration` under 60 seconds away, which is the rule the
 * store clamps for.
 *
 * What Miniflare cannot reproduce is KV's propagation delay: locally a write
 * is visible to the next read. That is exactly why the store reports
 * `consistency: 'eventual'` and why the contract suite's concurrency case
 * skips it. Passing that case here would prove nothing about the real thing.
 */
const miniflare = new Miniflare({
  modules: true,
  compatibilityDate: '2026-01-01',
  script: 'export default { fetch: () => new Response(null, { status: 404 }) };',
  kvNamespaces: ['BUDGETS'],
});

const namespace = (await miniflare.getKVNamespace('BUDGETS')) as unknown as KVNamespaceLike;

afterAll(async () => {
  await miniflare.dispose();
});

runStoreContract('KVStore', (startedAt) => {
  let now = startedAt;
  return {
    store: new KVStore(namespace, { prefix: 'contract:', now: () => now }),
    setNow(ms: number) {
      now = ms;
    },
  };
});

describe('KVStore', () => {
  it('reports eventual consistency, so every rule on it is a soft limit', () => {
    expect(new KVStore(namespace).consistency).toBe('eventual');
  });
  it('pushes an expiration KV would refuse out to the floor it accepts', async () => {
    // A per-minute window that started in the past ends before KV's 60-second
    // floor, and KV refuses an expiration that close. The write has to land
    // anyway: the stored `expiresAt` is what enforces the window, and KV's
    // own expiry only cleans up after it.
    const key = `soon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const startedAt = Date.UTC(2026, 2, 1);
    let now = startedAt;
    const store = new KVStore(namespace, { now: () => now });

    await expect(
      store.consume([
        { key, delta: { tokens: 1, costMicros: 1, requests: 1 }, expiresAt: startedAt + 1_000 },
      ]),
    ).resolves.toEqual({ ok: true });

    now = startedAt + 1_000;

    // The key outlives its window and reads as zeros for the rest of its life.
    expect(await store.read([key])).toEqual([{ tokens: 0, costMicros: 0, requests: 0 }]);
    expect(await namespace.get(key)).not.toBeNull();
  });

  it('propagates a write failure instead of reporting a booking it did not make', async () => {
    const failing: KVNamespaceLike = {
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('KV put failed')),
      delete: () => Promise.resolve(),
    };
    const store = new KVStore(failing);

    await expect(
      store.consume([
        { key: 'k', delta: { tokens: 1, costMicros: 1, requests: 1 }, expiresAt: null },
      ]),
    ).rejects.toThrow('KV put failed');
  });

  it('reads a value it did not write as zeros rather than as NaN', async () => {
    const key = `junk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const store = new KVStore(namespace);
    await namespace.put(key, 'not json');

    expect(await store.read([key])).toEqual([{ tokens: 0, costMicros: 0, requests: 0 }]);

    // A NaN counter would pass every later limit check, because every check
    // is a `>` comparison and one against NaN is false. Starting the window
    // again from zero is the safe reading.
    await store.consume([
      {
        key,
        delta: { tokens: 10, costMicros: 0, requests: 1 },
        limits: { tokens: 10 },
        expiresAt: null,
      },
    ]);
    expect(
      await store.consume([
        {
          key,
          delta: { tokens: 1, costMicros: 0, requests: 1 },
          limits: { tokens: 10 },
          expiresAt: null,
        },
      ]),
    ).toEqual({ ok: false, key, current: { tokens: 10, costMicros: 0, requests: 1 } });
  });

  it('keeps counters of different prefixes apart', async () => {
    const key = `prefixed-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const mine = new KVStore(namespace, { prefix: 'mine:' });
    const yours = new KVStore(namespace, { prefix: 'yours:' });

    await mine.consume([
      { key, delta: { tokens: 7, costMicros: 0, requests: 1 }, expiresAt: null },
    ]);

    expect(await yours.read([key])).toEqual([{ tokens: 0, costMicros: 0, requests: 0 }]);
    expect(await namespace.get(`mine:${key}`)).not.toBeNull();
  });

  it('refuses a key Workers KV could not hold', async () => {
    const store = new KVStore(namespace);

    await expect(store.read([''])).rejects.toBeInstanceOf(InvalidUsageError);
    await expect(store.read(['k'.repeat(513)])).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it('rejects a binding that is not one', () => {
    expect(() => new KVStore({} as unknown as KVNamespaceLike)).toThrow(InvalidConfigError);
  });
});
