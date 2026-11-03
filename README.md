# purse-strings

Hold the purse strings on your LLM spend.

A denial-of-wallet guard for TypeScript apps that call LLM APIs: per-user,
per-session and global token, cost and request budgets, plus step, tool-call
and time limits for agent loops. Zero runtime dependencies. It runs in your
process and keeps its counters in memory, Firestore or Cloudflare (Durable
Objects or Workers KV).

## The problem

An LLM endpoint turns one HTTP request into real money. Two things make that
dangerous:

- **One abusive user.** A stolen key, a scripted loop, a free tier someone
  decided to mine. Rate limiting by request count does not help when one
  request can cost a hundred times another.
- **One stuck agent.** A correct program, authenticated as a legitimate user,
  calling the same tool with the same arguments until the daily budget is
  gone. Nothing about it looks like abuse until the invoice arrives.

A budget is the control that bounds both, and it has to be enforced *before*
the call, not measured after it.

## Install

```sh
npm install purse-strings
```

Node 20 or newer, or any runtime with `AbortController` — Cloudflare Workers,
Deno and Bun included.

## Quick start

```ts
import { createGuard, MemoryStore } from 'purse-strings';

const guard = createGuard({
  store: new MemoryStore(),
  rules: [
    { id: 'user-daily', scope: 'user', window: 'day', limits: { costUsd: 1 } },
    { id: 'user-minute', scope: 'user', window: 'minute', limits: { requests: 20 } },
    { id: 'fleet-daily', scope: 'global', window: 'day', limits: { costUsd: 200 } },
  ],
  pricing: { 'gpt-4.1': { input: 2, output: 8 } },
});

const lease = await guard.reserve({
  subjects: { user: userId },
  model: 'gpt-4.1',
  inputTokens: 1_200,
  maxOutputTokens: 800,
});

try {
  const completion = await callTheModel();
  await lease.commit(usageFromOpenAI(completion.usage));
} catch (error) {
  await lease.release();
  throw error;
}
```

`MemoryStore` is strongly consistent *within one process*, which makes it
right for a single instance and wrong for anything that scales out: N
replicas each enforce the limit, so the effective limit is N times what you
configured. Pick a shared store below.

## Reserve, commit, release

The pattern exists because the cost of a call is not known until it is over,
and a limit that is checked afterwards is not a limit.

1. **Reserve** books the *worst case*: your input tokens plus the most output
   you allow. It is one atomic store operation across every applicable rule.
   If any rule cannot absorb it, nothing is booked and `BudgetExceededError`
   is thrown.
2. **Commit** books the difference between the real usage and the
   reservation. A call that used less than it reserved refunds the rest.
3. **Release** refunds the reservation when the call failed. The request
   itself stays counted: it was made.

Settle every lease exactly once. A second `commit()` or `release()` throws
`LeaseSettledError`.

Cost is tracked in integer **micro-dollars** — one millionth of a US dollar —
never floating-point dollars: a limit is compared against a value built by
repeated addition, and accumulated representation error in that comparison is
not acceptable in a spending control. `pricing` is in US dollars per million
tokens, the way providers publish it, and `usage()` reports `costMicros`.

## Run limits

Budget rules bound spending per subject per window. They do not bound one
agent run, and a stuck agent is the expensive failure.

```ts
const run = guard.startRun({
  subjects: { user: userId },
  maxSteps: 20,
  maxToolCalls: 40,
  maxIdenticalToolCalls: 3,
  maxDurationMs: 120_000,
  limits: { tokens: 100_000, costUsd: 0.5 },
});

const lease = await run.reserve({ model: 'gpt-4.1', inputTokens: 1_200 });
await lease.commit({ inputTokens: 1_200, outputTokens: 640 });

run.recordToolCall('search', { query: 'pricing' });
await fetch(url, { signal: run.signal });

run.end();
```

A run counts steps and tool calls, stops the same tool being called with the
same arguments too many times (compared independently of key order), enforces
a wall-clock deadline and keeps its own token and cost budget on top of the
guard's rules. `run.signal` aborts at the deadline and on `end()`, so
in-flight calls can be cancelled, and its deadline timer never keeps a Node.js
process alive. A run lives in one process.

## Choosing a store

| Store | Entry point | Consistency | Use it for |
|---|---|---|---|
| `MemoryStore` | `purse-strings` | `strong` within one process | A single instance, a test, a local script. |
| `FirestoreStore` | `purse-strings/firestore` | `strong` | Firebase and Google Cloud apps. Transactions across every counter in a batch. |
| `DurableObjectStore` | `purse-strings/cloudflare` | `strong` | Cloudflare Workers that need a hard cap, including under concurrency. |
| `KVStore` | `purse-strings/cloudflare` | `eventual` | Cloudflare Workers that need a soft cap: a sequential agent loop, or one user with one client. |

`strong` means `consume()` really is atomic across concurrent callers: two
reservations that together exceed a limit cannot both succeed. A store that
cannot promise that reports `eventual`, which downgrades every rule on it to
a soft limit — an attacker issuing a hundred requests at once gets a hundred
model calls, not the one the limit allowed.

Every adapter is tested against the real backend with the same store contract
suite, including a concurrency case that the eventual ones skip by design.

## Handling a refusal

```ts
import { BudgetExceededError } from 'purse-strings';

try {
  const lease = await guard.reserve({ subjects: { user: userId }, model });
} catch (error) {
  if (error instanceof BudgetExceededError) {
    response.status(429);
    if (error.retryAfterSeconds !== null) {
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
    }
    return response.json({ error: error.code, rule: error.rule, resetAt: error.resetAt });
  }
  throw error;
}
```

`retryAfterSeconds` is the time to the end of the window, ready for the
header, and `null` for a `total` window, which never resets. Branch on
`error.code`, not on the class name or the message: the class is lost across a
structured clone or a JSON boundary, and the message is prose that may be
improved.

## Limitations

- **A run lives in one process.** Repetition and wall-clock limits are only
  meaningful inside one logical execution.
- **Windows are fixed, not sliding.** A sliding window needs the timestamp of
  every event, which turns one integer per subject into a list whose length
  an attacker controls.
- **A reservation is a worst case, not a prediction.** Set
  `maxOutputTokens`; the default of 4096 is a guess.
- **Pricing is yours to keep current.** An unpriced model is an unbounded
  one, so a cost limit on a model with no price fails closed with
  `UnknownModelError`.
- **`estimateTokens()` is a heuristic, not a tokenizer.** It is for
  reservations; `commit()` replaces it with the provider's real count.
- **The guarantee is the store's.** On an eventual store every rule is a soft
  limit, and the library says so rather than pretending otherwise.

## Examples

- [An HTTP handler on Cloud Run with the Firestore store](https://github.com/sean1093/purse-strings/blob/main/examples/cloud-run-firestore.ts)
- [A Cloudflare Worker with the Durable Objects store](https://github.com/sean1093/purse-strings/blob/main/examples/cloudflare-worker.ts)

Both are type-checked in CI against the built package.

## Documentation

- [API reference](https://github.com/sean1093/purse-strings/blob/main/docs/api.md)
  — every exported function, option with its default, type and error code.
- [Threat model and design](https://github.com/sean1093/purse-strings/blob/main/docs/threat-model.md)
  — what the guard defends, what it guarantees under concurrency and failure,
  and where it stops.
- [The Firestore store](https://github.com/sean1093/purse-strings/blob/main/docs/firestore.md)
  — setup for Firebase and Google Cloud, the TTL policy on `expiresAt`, and
  the write rate a single counter document sustains.
- [The Cloudflare stores](https://github.com/sean1093/purse-strings/blob/main/docs/cloudflare.md)
  — the KV and Durable Objects bindings, and which of the two a hard limit
  needs.
- [Contributing](https://github.com/sean1093/purse-strings/blob/main/CONTRIBUTING.md)
  — scripts, project layout, how to add a store adapter, the quality gates and
  the release process.
- [Security policy](https://github.com/sean1093/purse-strings/blob/main/SECURITY.md)
  — what counts as a vulnerability here, and how to report one privately.
- [Code of conduct](https://github.com/sean1093/purse-strings/blob/main/CODE_OF_CONDUCT.md)

## License

[MIT](https://github.com/sean1093/purse-strings/blob/main/LICENSE)
