# API reference

Every export of `purse-strings`, `purse-strings/firestore` and
`purse-strings/cloudflare`. For the reasoning behind the design, see
[the threat model](./threat-model.md).

Cost is integer **micro-dollars** everywhere the library stores or reports it;
`costUsd` options are US dollars, and `pricing` is US dollars per million
tokens.

## `createGuard(options)`

Returns a `Guard`. Validates everything it can at construction, before any
traffic, and throws `InvalidConfigError` otherwise.

### `GuardOptions`

| Option | Type | Default | What it does |
|---|---|---|---|
| `store` | `BudgetStore` | required | Where counters live. |
| `rules` | `readonly BudgetRule[]` | required | Evaluated in order. Ids must be unique. |
| `pricing` | `PricingTable` | `{}` | US dollars per million tokens, keyed by model id. Required for any rule that limits cost. |
| `defaultMaxOutputTokens` | `number` | `4096` | Used when `reserve()` omits `maxOutputTokens`. |
| `now` | `() => number` | `Date.now` | Injectable clock, epoch milliseconds. |

### `BudgetRule`

| Field | Type | Default | What it does |
|---|---|---|---|
| `id` | `string` | required | Part of every counter key, so `/^[A-Za-z0-9_-]{1,64}$/`. |
| `scope` | `'global' \| string` | required | `'global'`, or the name of a subject passed to `reserve()`. |
| `window` | `WindowSpec` | required | `'minute'`, `'hour'`, `'day'`, `'week'` (ISO, from Monday), `'month'`, `'total'`, or `{ seconds }`. UTC-aligned. |
| `limits` | `RuleLimits` | required | `{ tokens?, costUsd?, requests? }`. An absent dimension is unlimited. |
| `optional` | `boolean` | `false` | When true, a call without this scope's subject skips the rule instead of throwing. |

## `Guard`

### `guard.reserve(options?): Promise<Lease>`

Books the worst case for one model call across every applicable rule, in one
atomic store operation. Throws `BudgetExceededError` if any rule cannot
absorb it, and nothing is booked.

| `ReserveOptions` | Type | Default | What it does |
|---|---|---|---|
| `subjects` | `Record<string, string>` | `{}` | Subject per scope, from authenticated server-side state. Never from the request body. |
| `model` | `string` | — | Priced against `pricing`. |
| `inputTokens` | `number` | `0` | The prompt's token count, or an estimate. |
| `maxOutputTokens` | `number` | `defaultMaxOutputTokens` | The worst case this call can generate. |
| `cachedInputTokens` | `number` | `0` | Part of `inputTokens` read from the provider's cache. |
| `cacheWriteTokens` | `number` | `0` | Part of `inputTokens` written to the provider's cache. |
| `costUsd` | `number` | — | Books this cost instead of pricing the reservation. |

### `guard.startRun(options?): Run`

Caps one agent loop in this process. See [`Run`](#run).

### `guard.usage(options?): Promise<RuleUsage[]>`

Used, limit, remaining and reset time for every applicable rule.
`options.subjects` is as `reserve()`. Each `RuleUsage` is
`{ rule, scope, subject, windowStart, resetAt, tokens, costMicros, requests }`,
where each of the last three is
`{ used, limit: number | null, remaining: number | null }` and `null` means
the rule does not limit that dimension.

### `guard.rules`

The rules as configured, in order.

## `Lease`

| Member | Type | What it does |
|---|---|---|
| `reserved` | `Readonly<Counter>` | What this lease booked. `requests` is always 1. |
| `commit(usage?)` | `Promise<void>` | Books the difference between the real usage and the reservation. |
| `release()` | `Promise<void>` | Refunds the reservation. The request stays counted. |

`CommitUsage` is `{ inputTokens?, outputTokens?, cachedInputTokens?,
cacheWriteTokens?, model?, costUsd? }`, all defaulting to zero or to the
reservation's model. `costUsd` overrides pricing entirely. Settling a lease
twice throws `LeaseSettledError`.

## `Run`

Created by `guard.startRun(options)`.

| `RunOptions` | Type | Default | What it does |
|---|---|---|---|
| `subjects` | `Record<string, string>` | — | Subjects for every reservation in the run. A call may add to or override them. |
| `model` | `string` | — | Model for every reservation. A call may override it. |
| `maxSteps` | `number` | unlimited | Model calls. |
| `maxToolCalls` | `number` | unlimited | Tool invocations. |
| `maxIdenticalToolCalls` | `number` | unlimited | The same tool with the same arguments, compared independently of key order. |
| `maxDurationMs` | `number` | unlimited | Wall clock from `startRun()`. Also aborts `signal`. |
| `limits` | `{ tokens?, costUsd? }` | unlimited | A budget for this run alone, on top of the guard's rules. |

Every cap must be a positive finite number, and an integer where it counts
things; otherwise `startRun()` throws `InvalidConfigError`.

| Member | Type | What it does |
|---|---|---|
| `signal` | `AbortSignal` | Aborts at the deadline and on `end()`. The deadline timer does not keep a Node.js process alive. |
| `steps` | `number` | Model calls booked so far. |
| `toolCalls` | `number` | Tool calls recorded so far. |
| `tokens` | `number` | Tokens this run has booked, after settlement. |
| `costMicros` | `number` | Micro-dollars this run has booked, after settlement. |
| `startedAt` | `number` | Epoch milliseconds. |
| `endsAt` | `number \| null` | When the deadline falls, or `null` without one. |
| `reserve(options?)` | `Promise<Lease>` | Reserves for one model call. Counts one step. |
| `recordToolCall(tool, args?)` | `void` | Counts one tool invocation and checks the repetition limit. |
| `end()` | `void` | Finishes the run and aborts `signal`. Doing it twice is harmless. |

A refused reservation counts no step and books nothing. Tool arguments are
compared as JSON-shaped data: the walk is bounded in depth, in the number of
values it visits and in the length of its result, and a bounded signature can
only refuse a call, never admit one.

## Provider usage

| Function | Takes | Notes |
|---|---|---|
| `usageFromOpenAI(usage)` | Chat Completions or Responses usage | Both totals are inclusive: cached tokens are already inside the input total, reasoning tokens already inside the output total. |
| `usageFromAnthropic(usage)` | Messages usage | Input total is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. `output_tokens` already includes thinking. |
| `usageFromGemini(metadata)` | `usageMetadata` | Input is `promptTokenCount + toolUsePromptTokenCount`; output is `candidatesTokenCount + thoughtsTokenCount`. `cachedContentTokenCount` is inside the prompt total. |

All three return `TokenUsage`:
`{ inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens }`, where
the two cache counts are subsets of `inputTokens`. A counter that is absent
reads as zero; one that is present and not a token count throws
`InvalidUsageError`, because a silent zero would make the call cost nothing.

`estimateTokens(text): number` is UTF-8 bytes divided by three, rounded up —
a heuristic for reservations, not a tokenizer. It over-estimates English
prose slightly, which is the safe direction.

## Stores

Every adapter implements `BudgetStore`:

```ts
interface BudgetStore {
  readonly consistency: 'strong' | 'eventual';
  consume(updates: readonly CounterUpdate[]): Promise<ConsumeResult>;
  add(updates: readonly CounterUpdate[]): Promise<void>;
  read(keys: readonly string[]): Promise<Counter[]>;
}
```

| Store | Entry point | Constructor | Options |
|---|---|---|---|
| `MemoryStore` | `purse-strings` | `new MemoryStore(options?)` | `now` (`Date.now`), `sweepAt` (`1024`) |
| `FirestoreStore` | `purse-strings/firestore` | `new FirestoreStore(firestore, options?)` | `collection` (`'budgetCounters'`), `maxAttempts` (`10`), `now` (`Date.now`) |
| `KVStore` | `purse-strings/cloudflare` | `new KVStore(namespace, options?)` | `prefix` (`''`), `now` (`Date.now`) |
| `DurableObjectStore` | `purse-strings/cloudflare` | `new DurableObjectStore(namespace, options?)` | `prefix` (`''`), `now` (`Date.now`) |

`BudgetCounterObject` is the Durable Object class a Worker exports; see
[the Cloudflare guide](./cloudflare.md). Firestore setup, the TTL policy and
the write rate of a hot document are in
[the Firestore guide](./firestore.md).

## Errors

Every error is a `PurseStringsError` with a stable `code`. Branch on the code.

| Code | Class | Carries | Thrown when |
|---|---|---|---|
| `BUDGET_EXCEEDED` | `BudgetExceededError` | `rule`, `scope`, `subject`, `dimension`, `limit`, `used`, `requested`, `resetAt`, `retryAfterSeconds` | A reservation would take a rule past one of its limits. Nothing is booked. |
| `UNKNOWN_MODEL` | `UnknownModelError` | `model` | A cost limit applies and the model has no price, or no model was given. |
| `MISSING_SUBJECT` | `MissingSubjectError` | `rule`, `scope` | A required rule's scope has no subject in this call. |
| `LEASE_SETTLED` | `LeaseSettledError` | `settledAs` | The lease was already committed or released. |
| `RUN_LIMIT_EXCEEDED` | `RunLimitExceededError` | `limit`, `max`, `actual` | A run reached one of its own caps. Nothing is booked. |
| `LOOP_DETECTED` | `LoopDetectedError` | `tool`, `count` | The same tool was called with the same arguments too many times in one run. |
| `INVALID_CONFIG` | `InvalidConfigError` | — | The guard options or a run's caps are not usable. |
| `INVALID_USAGE` | `InvalidUsageError` | — | An argument is not usable, or the run it was made on has ended. |

`RunLimit`, the type of `RunLimitExceededError.limit`, is
`'steps' | 'toolCalls' | 'duration' | 'tokens' | 'costMicros'`. `costMicros`
is reported in micro-dollars, `duration` in milliseconds.
