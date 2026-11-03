# The Cloudflare stores

Cloudflare offers two places to keep a counter, and they are not
interchangeable.

| Store | Consistency | Use it for |
|---|---|---|
| `KVStore` | `eventual` | A soft cap: a sequential agent loop, or a per-user limit where one user is one client making one request at a time. |
| `DurableObjectStore` | `strong` | A hard cap, including one that has to hold under concurrent requests. |

`KVStore` is in this entry point today. A Durable Objects store follows.

## `KVStore`

```ts
import { createGuard } from 'purse-strings';
import { KVStore } from 'purse-strings/cloudflare';

interface Env {
  BUDGETS: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const guard = createGuard({
      store: new KVStore(env.BUDGETS),
      rules: [{ id: 'user-daily', scope: 'user', window: 'day', limits: { costUsd: 1 } }],
      pricing: { 'gpt-4.1': { input: 2, output: 8 } },
    });

    const lease = await guard.reserve({ subjects: { user: userId }, model: 'gpt-4.1' });
    // ...
  },
};
```

With the binding declared in `wrangler.jsonc`:

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "kv_namespaces": [{ "binding": "BUDGETS", "id": "<your namespace id>" }]
}
```

Nothing from `@cloudflare/workers-types` is imported. The binding is typed
structurally, naming only `get`, `put` and `delete`, so the types
`wrangler types` generates fit without this package depending on them.

### Options

| Option | Default | What it does |
|---|---|---|
| `prefix` | `''` | Prefixed to every counter key, so one namespace can hold other data too. |
| `now` | `Date.now` | Injectable clock, in epoch milliseconds. Tests pass their own. |

### What eventual consistency costs you

Say it plainly: **a rule on `KVStore` is a soft limit.** KV propagates writes
asynchronously, takes up to a minute to reach every edge location, and has no
compare-and-set. `consume()` reads the counters, checks the limits, then
writes — three steps with no lock around them. Two requests that start at the
same time read the same value, and both pass.

That is fine for the two cases KV is good at:

- **A sequential agent loop.** Each step waits for the one before it, so each
  read sees the previous write, and the loop is capped step by step.
- **A per-user cap where one user is one client.** A browser or a mobile app
  making one request at a time is sequential for the same reason.

It is not a defence against concurrent abuse. An attacker who issues a hundred
requests at once against a KV-backed limit gets a hundred model calls, not the
one the limit allowed. For that, use `DurableObjectStore`, which handles the
requests for one counter one at a time.

`KVStore` reports `consistency: 'eventual'`, so the store contract suite skips
its concurrency case by design, and nothing in the library claims a guarantee
KV cannot keep.

### Write rate

KV allows about **one write per second to a single key**, and a model call is
two writes to each counter it touches: `reserve()` books the worst case and
`commit()` books the difference. A global rule on KV is one key for the whole
fleet and is past that rate as soon as the service is busy; scope the rules you
put on KV to a user, a session or a tenant.

### Expiry

Each counter is written with KV's absolute `expiration`, so the platform
deletes it after its window. KV refuses an expiration less than 60 seconds
away, and a short window ends sooner than that, so the expiration is pushed
out to that floor. It costs nothing: the `expiresAt` stored inside the value
is what a read is checked against, so a key that outlives its window reads as
zeros for the rest of its life, and the next window starts from zero.

### Failure mode

A failed KV write propagates out of `consume()`, so `guard.reserve()` rejects
and the request fails before the model is called. A store that swallowed a
write would leave the guard admitting calls against a counter that never
moved. Writes in the same batch that had already landed stay, which
over-counts rather than under-counts.

## Running the tests

The adapters are tested against [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare),
which runs the same workerd Cloudflare runs, with the real KV implementation
behind it.

```sh
npm run test:cloudflare
```

No account and no network are needed: Miniflare runs locally.
