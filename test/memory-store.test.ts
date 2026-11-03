import { describe, expect, it } from 'vitest';
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

  it('drops expired counters instead of growing without bound', async () => {
    let now = Date.UTC(2026, 0, 1);
    const store = new MemoryStore({ now: () => now, sweepAt: 64 });

    // One counter per subject per window is growth an attacker controls.
    for (let subject = 0; subject < 500; subject += 1) {
      await store.add([
        {
          key: `rule:user${subject}:0`,
          delta: { tokens: 1, costMicros: 1, requests: 1 },
          expiresAt: now + 60_000,
        },
      ]);
    }
    expect(store.size).toBe(500);

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

    expect(store.size).toBe(100);
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
