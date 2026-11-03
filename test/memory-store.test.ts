import { describe, expect, it } from 'vitest';
import { InvalidUsageError } from '../src/errors.js';
import { MemoryStore } from '../src/stores/memory.js';
import { runStoreContract } from './contract/store-contract.js';

runStoreContract('MemoryStore', (startedAt) => {
  let now = startedAt;
  return {
    store: new MemoryStore({ now: () => now }),
    setNow(ms) {
      now = ms;
    },
  };
});

describe('MemoryStore', () => {
  it('reports itself as strongly consistent', () => {
    expect(new MemoryStore().consistency).toBe('strong');
  });

  it('checks a key named twice in one batch against the running total', () => {
    const store = new MemoryStore();

    return store
      .consume([
        {
          key: 'k',
          delta: { tokens: 6, costMicros: 0, requests: 1 },
          limits: { tokens: 10 },
          expiresAt: null,
        },
        {
          key: 'k',
          delta: { tokens: 6, costMicros: 0, requests: 1 },
          limits: { tokens: 10 },
          expiresAt: null,
        },
      ])
      .then(async (result) => {
        expect(result).toEqual({
          ok: false,
          key: 'k',
          current: { tokens: 6, costMicros: 0, requests: 1 },
        });
        expect(await store.read(['k'])).toEqual([{ tokens: 0, costMicros: 0, requests: 0 }]);
      });
  });

  it('stays bounded as expired subjects accumulate', async () => {
    let now = Date.UTC(2026, 0, 1);
    const store = new MemoryStore({ now: () => now, sweepAt: 64 });

    // One counter per subject per window is growth an attacker controls, and
    // dropping expired entries only when they are touched never reaches the
    // keys nobody asks about again.
    for (let subject = 0; subject < 500; subject += 1) {
      await store.add([
        {
          key: `rule:user${subject}:0`,
          delta: { tokens: 1, costMicros: 1, requests: 1 },
          expiresAt: now + 60_000,
        },
      ]);
    }

    now += 60_000;
    for (let subject = 0; subject < 100; subject += 1) {
      await store.add([
        {
          key: `rule:later${subject}:1`,
          delta: { tokens: 1, costMicros: 1, requests: 1 },
          expiresAt: now + 60_000,
        },
      ]);
    }

    // The 500 expired counters are gone; the 100 live ones are intact.
    expect(store.size).toBeLessThanOrEqual(150);
    expect(await store.read(['rule:user0:0', 'rule:user499:0'])).toEqual([
      { tokens: 0, costMicros: 0, requests: 0 },
      { tokens: 0, costMicros: 0, requests: 0 },
    ]);
    expect(await store.read(['rule:later0:1', 'rule:later99:1'])).toEqual([
      { tokens: 1, costMicros: 1, requests: 1 },
      { tokens: 1, costMicros: 1, requests: 1 },
    ]);
  });

  it('refuses a batch carrying a non-finite delta rather than poisoning a counter', async () => {
    const store = new MemoryStore();
    const poison = {
      key: 'k',
      delta: { tokens: Number.NaN, costMicros: 0, requests: 1 },
      limits: { tokens: 10 },
      expiresAt: null,
    };

    // Every limit check is a `>` comparison, and NaN > n is false: admitting
    // this would leave a counter that passes every later check as well.
    await expect(store.consume([poison])).rejects.toThrow(InvalidUsageError);
    await expect(store.add([poison])).rejects.toThrow(/not finite/);
    expect(await store.read(['k'])).toEqual([{ tokens: 0, costMicros: 0, requests: 0 }]);
  });

  it('keeps counters that never expire', async () => {
    let now = Date.UTC(2026, 0, 1);
    const store = new MemoryStore({ now: () => now, sweepAt: 4 });

    for (let subject = 0; subject < 20; subject += 1) {
      await store.add([
        {
          key: `total:u${subject}:0`,
          delta: { tokens: 1, costMicros: 0, requests: 1 },
          expiresAt: null,
        },
      ]);
    }

    now += 10 * 365 * 86_400_000;
    await store.add([
      { key: 'total:late:0', delta: { tokens: 1, costMicros: 0, requests: 1 }, expiresAt: null },
    ]);

    expect(store.size).toBe(21);
  });

  it('forgets everything on clear()', async () => {
    const store = new MemoryStore();
    await store.add([
      { key: 'k', delta: { tokens: 5, costMicros: 5, requests: 1 }, expiresAt: null },
    ]);

    store.clear();

    expect(store.size).toBe(0);
    expect(await store.read(['k'])).toEqual([{ tokens: 0, costMicros: 0, requests: 0 }]);
  });
});
