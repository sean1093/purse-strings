import { Firestore } from '@google-cloud/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { InvalidConfigError, InvalidUsageError } from '../../src/errors.js';
import { FirestoreStore } from '../../src/stores/firestore.js';
import { runStoreContract } from '../contract/store-contract.js';

/**
 * The Firestore adapter against the real thing.
 *
 * This suite fails rather than skips when the emulator is not configured. A
 * store adapter that silently stopped being tested would keep reporting
 * `consistency: 'strong'` on a guarantee nobody had checked, and the whole
 * point of the contract suite is that it runs against a real backend.
 *
 * Run it with:
 *   npx firebase-tools emulators:exec --only firestore \
 *     --project demo-purse-strings "npm run test:firestore"
 */
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (host === undefined || host === '') {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST is not set. Run this suite through ' +
      '`firebase emulators:exec --only firestore --project demo-purse-strings "npm run test:firestore"`.',
  );
}

const firestore = new Firestore({ projectId: 'demo-purse-strings' });

afterAll(async () => {
  await firestore.terminate();
});

runStoreContract('FirestoreStore', (startedAt) => {
  let now = startedAt;
  return {
    store: new FirestoreStore(firestore, { collection: 'contractCounters', now: () => now }),
    setNow(ms: number) {
      now = ms;
    },
  };
});

describe('FirestoreStore', () => {
  const store = new FirestoreStore(firestore, { collection: 'behaviourCounters' });

  it('stores expiresAt as a timestamp a TTL policy can read', async () => {
    const key = `ttl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = Date.UTC(2031, 0, 1);

    await store.consume([{ key, delta: { tokens: 5, costMicros: 5, requests: 1 }, expiresAt }]);

    const snapshot = await firestore.collection('behaviourCounters').doc(key).get();
    const stored = snapshot.data();

    // A Firestore TTL policy only acts on a field that holds a timestamp.
    expect(stored?.expiresAt?.constructor?.name).toBe('Timestamp');
    expect(stored?.expiresAt?.toMillis()).toBe(expiresAt);
  });

  it('keeps the window a counter started in when a later call carries a different expiry', async () => {
    const key = `window-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = Date.now() + 3_600_000;

    await store.consume([{ key, delta: { tokens: 1, costMicros: 0, requests: 1 }, expiresAt }]);
    await store.consume([
      {
        key,
        delta: { tokens: 1, costMicros: 0, requests: 1 },
        expiresAt: expiresAt + 86_400_000,
      },
    ]);

    const stored = (await firestore.collection('behaviourCounters').doc(key).get()).data();
    expect(stored?.expiresAt?.toMillis()).toBe(expiresAt);
  });

  it('refuses a counter key that would address something other than a document', async () => {
    for (const key of ['', 'a/b', '.', '..', '__name__']) {
      await expect(
        store.consume([{ key, delta: { tokens: 1, costMicros: 0, requests: 1 }, expiresAt: null }]),
      ).rejects.toBeInstanceOf(InvalidUsageError);
    }
  });

  it('rejects options that could not address a collection', () => {
    expect(() => new FirestoreStore(firestore, { collection: 'a/b' })).toThrow(InvalidConfigError);
    expect(() => new FirestoreStore(firestore, { maxAttempts: 0 })).toThrow(InvalidConfigError);
    expect(() => new FirestoreStore({} as unknown as Firestore)).toThrow(InvalidConfigError);
  });
});
