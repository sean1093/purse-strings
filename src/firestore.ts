/**
 * `purse-strings/firestore` — counters in Firestore, shared by every instance
 * of a service.
 *
 * ```ts
 * import { Firestore } from '@google-cloud/firestore';
 * import { createGuard } from 'purse-strings';
 * import { FirestoreStore } from 'purse-strings/firestore';
 *
 * const guard = createGuard({
 *   store: new FirestoreStore(new Firestore()),
 *   rules: [{ id: 'user-daily', scope: 'user', window: 'day', limits: { costUsd: 1 } }],
 *   pricing: { 'gpt-4.1': { input: 2, output: 8 } },
 * });
 * ```
 *
 * Neither `@google-cloud/firestore` nor `firebase-admin` is imported here.
 * Both are optional peer dependencies: the parameter types name only the
 * members the store calls, so the instance from either package fits.
 *
 * @packageDocumentation
 */

export {
  type FirestoreCollectionReference,
  type FirestoreDocumentData,
  type FirestoreDocumentReference,
  type FirestoreDocumentSnapshot,
  type FirestoreLike,
  FirestoreStore,
  type FirestoreStoreOptions,
  type FirestoreTransaction,
  type FirestoreTransactionOptions,
} from './stores/firestore.js';
