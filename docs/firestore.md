# The Firestore store

`FirestoreStore` keeps the counters in Firestore, so every instance of a
service shares them. It is the store to reach for in a Firebase or Google
Cloud app that already has Firestore: no extra infrastructure, and the
transaction is what makes a budget hold under concurrency.

```ts
import { Firestore } from '@google-cloud/firestore';
import { createGuard } from 'purse-strings';
import { FirestoreStore } from 'purse-strings/firestore';

const guard = createGuard({
  store: new FirestoreStore(new Firestore()),
  rules: [{ id: 'user-daily', scope: 'user', window: 'day', limits: { costUsd: 1 } }],
  pricing: { 'gpt-4.1': { input: 2, output: 8 } },
});
```

`firebase-admin` works the same way:

```ts
import { getFirestore } from 'firebase-admin/firestore';
import { FirestoreStore } from 'purse-strings/firestore';

const store = new FirestoreStore(getFirestore());
```

Neither package is a dependency of purse-strings, and neither is imported at
build time or at run time. Both are declared as optional peer dependencies:
`FirestoreStore` takes a structural type that names only the members it calls,
so the instance from either package fits.

## Options

| Option | Default | What it does |
|---|---|---|
| `collection` | `'budgetCounters'` | The collection the counter documents live in. A collection id, so it cannot contain `/`. |
| `maxAttempts` | `10` | How many times a transaction refused for contention is retried. Firestore's own default is 5. |
| `now` | `Date.now` | Injectable clock, in epoch milliseconds. Tests pass their own. |

## What a counter document looks like

One document per rule, per subject, per window, with the counter key as its
document id:

```json
{
  "tokens": 15200,
  "costMicros": 48300,
  "requests": 12,
  "expiresAt": "2026-03-11T00:00:00.000Z"
}
```

`expiresAt` is a Firestore timestamp, the instant the window ends, or `null`
for a rule whose window is `total`. `costMicros` is integer micro-dollars, one
millionth of a US dollar.

## Enable a TTL policy on `expiresAt`

Without one, a counter document per subject per window accumulates forever,
and the subject is attacker-influenced: anyone who can start a session can
create documents. A TTL policy makes Firestore delete each one once its window
has ended.

```sh
gcloud firestore fields ttls update expiresAt \
  --collection-group=budgetCounters \
  --enable-ttl
```

In the Google Cloud console the same setting is under **Firestore → Time-to-live
(TTL)** → **Create policy**, with collection group `budgetCounters` and
timestamp field `expiresAt`.

Two things are worth knowing about it:

- Deletion is garbage collection, not enforcement. Firestore deletes expired
  documents within 24 hours of their expiry, sometimes later under load. The
  store never relies on it: a document at or past its `expiresAt` reads as
  zeros, so the next window always starts from zero whether or not the old
  document is gone.
- Add a single-field index exemption for `expiresAt`. Firestore does not add
  one with the policy: every field is indexed by default, and an indexed
  timestamp on the one field every counter write touches is exactly the
  hotspot the next section is about. Nothing here ever queries `expiresAt`,
  so disabling its index costs nothing. In the console it is
  **Firestore → Indexes → Single field → Add exemption**, with both ascending
  and descending set to disabled; in an index definition file it is a
  `fieldOverrides` entry for `expiresAt` with an empty `indexes` array.
  Expired documents are billed as deletes.

## The write rate of one document

Firestore sustains roughly **one write per second to a single document**.
Beyond that, latency climbs and transactions start being refused for
contention; `maxAttempts` retries them, and when the retries run out the
reservation fails rather than silently passing.

A model call is two writes to each counter it touches: `reserve()` books the
worst case and `commit()` books the difference. So one write per second is
**one model call every two seconds** per counter document — a commit that
matches its reservation exactly writes nothing, but that is not the case to
plan for.

A counter document is as hot as its rule is broad:

| Rule scope | Document | Safe on Firestore |
|---|---|---|
| `user`, `session`, `tenant` | One per subject per window | Yes, unless a single subject exceeds about one model call every two seconds |
| `global` | One document for the whole fleet | Only below about one model call every two seconds across every instance |

So a global cap on Firestore is a cap on a service that makes fewer than one
model call every two seconds. Above that, put the global rule somewhere built
for a hot counter — a Cloudflare Durable Object, or a sharded counter of your
own — and keep the per-user and per-session rules on Firestore, where each
subject writes its own document.

## Security rules

Counter documents are written by your server, never by a client. Deny client
access to the collection outright:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /budgetCounters/{counter} {
      allow read, write: if false;
    }
  }
}
```

The Admin SDK bypasses security rules, so your server keeps working. A client
that could write these documents could raise its own limit.

## Running the tests

The adapter is tested against the Firestore emulator, not a mock, with the same
store contract suite every other adapter runs — including the concurrency case,
which issues two dozen reservations against one counter and expects exactly the
ones that fit to be admitted.

```sh
npx firebase-tools emulators:exec --only firestore \
  --project demo-purse-strings "npm run test:firestore"
```

The emulator is a Java program, so a JDK has to be on the path. The suite fails
rather than skips when `FIRESTORE_EMULATOR_HOST` is unset: a store adapter that
quietly stopped being tested would keep claiming `consistency: 'strong'` on a
guarantee nobody had checked.
