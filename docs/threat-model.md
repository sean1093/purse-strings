# Threat model and design

`purse-strings` is a spending control, not a convenience helper. Code that
depends on it is deciding how much money a stranger can make you spend, so what
it promises under concurrency, failure and partial outage has to be written down
before anything relies on it.

This document states what the library defends, what it guarantees, how the
guarantee is constructed, and where it stops.

## Contents

- [The asset](#the-asset)
- [Threats](#threats)
- [Security goal](#security-goal)
- [Design: reserve, commit, release](#design-reserve-commit-release)
- [Windows and counter keys](#windows-and-counter-keys)
- [Cost accounting](#cost-accounting)
- [Agent run limits](#agent-run-limits)
- [Fail closed](#fail-closed)
- [Store consistency](#store-consistency)
- [Trust boundaries](#trust-boundaries)
- [Residual risks](#residual-risks)
- [Non-goals](#non-goals)

## The asset

The asset is the operator's LLM bill: a metered, uncapped, post-paid resource
reachable from application code. Unlike CPU or memory, exhausting it does not
degrade the service. It succeeds, repeatedly, and arrives as an invoice.

Three properties make it an unusually attractive target.

- **The cost of an attack is asymmetric.** A request costing the attacker
  nothing but bandwidth can cost the operator cents. A thousand of them, a
  minute apart, stay under every HTTP rate limit and still add up.
- **The damage is unbounded in the short term.** Provider-side spending caps
  are coarse, apply per organisation, and often take effect at the next billing
  period or by hard-stopping every customer at once.
- **The attack is indistinguishable from use.** A long prompt from a paying
  user and a long prompt from a script are the same request.

## Threats

| Threat | How it spends | What stops it |
| --- | --- | --- |
| Scripted or abusive user | Many ordinary requests from one account | A per-user rule with `tokens`, `costUsd` or `requests` limits over a fixed window |
| Stolen session or API key | The same, under a victim's identity | The same per-user and per-session rules; the budget is attached to the authenticated subject, so a stolen credential inherits its remaining budget, not a fresh one |
| Prompts crafted to maximise output | Few requests, each at the model's maximum output | `reserve()` books the worst case up front, so one request can exhaust a budget but cannot exceed it |
| Runaway agent loop | A correct program calling a model until it converges, which it never does | Per-run step, tool-call, repetition and wall-clock limits that stop a loop in seconds instead of at the end of the daily budget |
| Retry storm | A client or queue retrying a failing call without backoff | Every attempt is a `reserve()`, so retries consume the request and token budget like any other call |
| Expensive-model substitution | A request that selects a costlier model than intended | Cost is priced per model, so a costlier model draws proportionally more from the same `costUsd` limit |

The last two are worth stating plainly: the library does not care *why* tokens
are being spent. A bug in your own retry loop and an attacker are the same
threat to a budget, and most real incidents are the bug.

## Security goal

> For each configured rule, the tokens, cost and requests booked in a window
> stay within that rule's limit when the store is strongly consistent.

The only overshoot is the gap between a reservation and the actual usage it is
settled with, and that gap is bounded by the caller's estimate: a reservation
books `inputTokens + maxOutputTokens`, and `commit()` books the difference
between the real usage and what was reserved. So:

- A call whose real usage is **below** its reservation never overshoots. The
  reservation held the worst case; the commit refunds the rest.
- A call whose real usage is **above** its reservation overshoots by exactly
  that excess, once, after the fact. This happens when the caller under-reports
  `inputTokens` or when the provider returns more output than `maxOutputTokens`
  allowed. Both are under the caller's control, which is why `maxOutputTokens`
  has a guard-level default (4096) rather than being unbounded.

The guarantee is per rule, not global. A request passes only if *every*
applicable rule can absorb it, so the effective limit is the tightest one.

### What "within the limit" means

A dimension's limit is a ceiling on the booked total, checked before the
booking: a reservation is admitted only if `used + requested <= limit` for
every dimension of every applicable rule. There is no grace, no burst and no
borrowing from the next window.

## Design: reserve, commit, release

The naive design — call the model, then add the usage to a counter — fails in
two independent ways.

**The cost is not known until afterwards.** By the time usage is reported, the
money is spent. A counter updated after the fact detects an overspend; it
cannot prevent one.

**Concurrent checks all pass.** "Read the counter, compare it to the limit,
make the call" is a classic time-of-check to time-of-use race. With a budget of
100 remaining tokens and fifty concurrent requests of 50 tokens each, all fifty
read 100, all fifty pass, and 2,500 tokens are spent against a 100-token
budget. This is not a theoretical interleaving: a retry storm or a burst of
parallel agent steps produces exactly it.

So the booking happens first, and it happens as one atomic operation:

```text
reserve()   check every applicable counter against its limit and
            increment all of them, atomically, all or nothing
            -> throws BudgetExceededError, or returns a lease

   model call

commit()    book the difference between actual usage and the reservation
            (a negative delta refunds)
release()   refund the reservation entirely, but keep the request counted
```

`reserve()` is the control point. Everything after it is accounting.

### Why the request stays counted on release

`release()` refunds tokens and cost, because the tokens were never generated.
It does not refund the request, because the request was made. A failed call
still consumed provider capacity and still represents an attempt; a caller that
could refund attempts could retry without limit against a `requests` rule.

### Why settling twice throws

A lease is a single-use handle for an outstanding booking. Committing it twice
would book the difference twice against a reservation that no longer exists,
and releasing after committing would refund tokens that were really spent. Both
are silent accounting corruption, so both throw `LeaseSettledError`. A caller
that is unsure whether it settled should structure the call with `try`/`finally`
rather than settling defensively.

### Partial failures

If the store fails during `commit()` or `release()`, the reservation stays
booked. That is the safe direction: the budget is conservative until the
window ends, rather than silently released.

## Windows and counter keys

Windows are **fixed**, not sliding, and aligned to UTC: `minute`, `hour`,
`day`, `week` (ISO weeks, starting Monday), `month`, `total`, or a custom
`{ seconds }` window aligned to the Unix epoch.

Fixed windows are deliberate. A sliding window needs the timestamps of
individual events, which turns one counter into a growing list — unbounded
state that an attacker controls the size of, in a store that charges per read.
A fixed window is a single integer per subject per window, and it expires on
its own.

The cost of the choice is a boundary burst: a user can spend a full window's
budget just before a boundary and another just after. Where that matters, a
short rule (`minute` or `{ seconds: 10 }`) alongside the long one bounds the
rate as well as the total.

Counter keys are `<ruleId>:<encodeURIComponent(subject)>:<windowStart>`. Rule
ids are restricted to `/^[A-Za-z0-9_-]{1,64}$/` and subjects are length-bounded
and percent-encoded, so a key is always a valid Firestore document id, Workers
KV key and Durable Object name. A subject is attacker-influenced data: without
encoding, a subject containing `/` would create a Firestore subcollection path,
and one containing `:` would let two different subjects collide on one counter.

## Cost accounting

Cost is tracked in **integer micro-dollars**, never floating-point dollars.
Repeatedly adding fractional dollars accumulates representation error in a
value that is compared against a limit, and the direction of that error is not
controlled.

Prices are supplied by the caller as USD per million tokens, because provider
prices change far more often than this library will be released, and a stale
built-in table would silently under-price a model — a budget bypass caused by
the library itself.

Rounding is **up**, after the product is rounded to the nearest micro-dollar.
Both steps matter: `1000 * 0.15 / 1e6` is not exactly `150` in IEEE 754, and a
bare `Math.ceil` on the raw product would charge 151 micro-dollars for a price
that is exactly 150. Rounding up a genuinely fractional result keeps the
library conservative, which is the correct direction for a spending control.

Cached input and cache-write tokens are priced separately where a provider
prices them separately, and a caller that knows the real cost can override
pricing entirely by passing `costUsd` to `commit()`.

## Agent run limits

Budget rules bound spending per subject per window. They do not bound a single
agent run, and a stuck agent is the most expensive common failure: it is a
correct program, authenticated as a legitimate user, calling the model as fast
as it can until the daily budget is gone.

A run adds in-process limits on top of the guard's rules:

- `maxSteps` — model calls in this run.
- `maxToolCalls` — tool invocations in this run.
- `maxIdenticalToolCalls` — the same tool with the same arguments, compared
  independently of key order. A loop that calls `search({ query: 'x' })` again
  and again is the signature of an agent that is not converging.
- `maxDurationMs` — a wall-clock deadline, exposed as an `AbortSignal` so
  in-flight provider calls are actually cancelled rather than merely
  un-awaited.
- `limits` — a token and cost budget for the run alone.

Run state lives in one process and is not shared. That is a deliberate scope
limit, not an oversight: a cross-process run would need the same atomic store
operations as a budget rule, and the limits that matter for a loop
(repetition, wall clock) are only meaningful within one logical execution.

## Fail closed

Every ambiguity resolves to refusing the call:

| Condition | Behaviour |
| --- | --- |
| Store read or write error | `reserve()` throws; the model is not called |
| Unknown model while a `costUsd` limit applies | Throws `UnknownModelError` — an unpriced model is an unbounded one |
| Required subject missing from `subjects` | Throws `MissingSubjectError`, unless the rule is `optional` |
| Invalid configuration (bad rule id, non-positive limit, unknown window) | Throws `InvalidConfigError` at `createGuard()`, before any traffic |
| Run deadline passed, or step/tool/repetition limit reached | Throws `RunLimitExceededError` or `LoopDetectedError` |

The alternative — allowing the call when the store is unavailable — turns a
store outage into an unbounded spend, and a store outage is exactly what an
attacker would try to cause. An operator who prefers availability over cost
control can catch the error and decide; the library will not decide that
silently.

Note the asymmetry: an unknown model throws only when a cost limit is actually
in play. A deployment that limits tokens and requests but not cost does not
need a price list.

## Store consistency

The security goal holds **only as strongly as the store beneath it**.

| Store | Consistency | Mechanism | Suitable for |
| --- | --- | --- | --- |
| `MemoryStore` | `strong` | One process, synchronous check-and-increment | Single-instance services, tests, development |
| `FirestoreStore` | `strong` | All counters read and written in one transaction | Firebase and Google Cloud deployments |
| `DurableObjectStore` | `strong` | One Durable Object per counter; a Durable Object processes requests one at a time over transactional storage | Cloudflare Workers that need a real limit |
| `KVStore` | `eventual` | Workers KV read-modify-write, last write wins | Soft limits, sequential agent loops, low-concurrency per-user caps |

Two consequences are worth stating directly.

**Workers KV is not a control against concurrent abuse.** KV propagates writes
asynchronously and accepts roughly one write per second per key. Concurrent
requests read the same stale value and all pass. It reports
`consistency: 'eventual'` and the store contract suite skips the concurrency
case for it by design — not because the case is hard to pass, but because
passing it would be a false claim.

**A multi-counter `consume()` on Durable Objects is not one transaction.** Each
counter is a separate object, so the store books them in sequence and
compensates the ones already booked if a later one is refused. The limit is
never exceeded — a booking is only ever added after a successful check — but
during the compensation window a concurrent request may be refused against a
counter that is about to be refunded. Refusing when the state is uncertain is
the fail-closed direction.

`MemoryStore` deserves its own warning. It is strongly consistent *within one
process*. Three replicas behind a load balancer each enforce the limit
separately, so the effective limit is three times what is configured.

## Trust boundaries

```text
    untrusted                    |  trusted (your server)
    ---------------------------- | ----------------------------
    request body, headers,       |  authenticated session,
    prompt text, model choice    |  user id, tenant id, plan
    sent by the client           |  resolved server-side
                                 |
                                 |  guard.reserve({ subjects })
                                 |            |
                                 |            v
                                 |      budget store
```

**Subject identifiers must come from authenticated server-side state, never
from the request body.** A `userId` read out of JSON is an attacker-chosen
value: a fresh one per request gives a fresh budget per request, and the guard
becomes decoration. This is the single most likely way to deploy the library
and gain nothing from it.

Session identifiers have the same requirement. A `sessionId` the client picks
is only usable for grouping, not for limiting.

Within the trusted side, the library treats its inputs as hostile anyway:
subjects are length-checked and encoded before they reach a key, rule ids are
validated at construction, and token and cost arguments are checked for being
finite non-negative numbers. An abusive input should produce a thrown error
immediately, not a corrupt counter or unbounded memory growth.

## Residual risks

Risks the design accepts, and what reduces them:

- **Under-reserved calls.** A caller that estimates `inputTokens` too low
  overshoots by the difference at commit. Use the provider's token counting
  endpoint, or over-estimate; `estimateTokens()` is a byte heuristic, not a
  tokenizer.
- **Fixed-window boundary burst.** Up to two windows' budget around a
  boundary. Add a short-window rule where the rate matters.
- **Crash between reserve and settle.** The reservation stays booked until the
  window ends. Conservative, but a process that crashes often will
  under-serve its users.
- **Non-model spend.** Embeddings, image generation, web search tool calls and
  other provider-billed operations are only counted if the caller reserves
  against them. The guard sees what it is told about.
- **Replica count with `MemoryStore`.** Covered above: the effective limit
  multiplies by the number of processes.

## Non-goals

These are out of scope by design, not pending work:

- **Prompt-injection detection and content moderation.** Different problem,
  different failure mode. A budget guard that also tried to classify content
  would be worse at both.
- **Provider-side spending caps.** Configure those too; they are the backstop
  for everything this library never sees, including spend from outside your
  application.
- **Agent runs that span processes.** See
  [Agent run limits](#agent-run-limits).
- **A built-in price table.** See [Cost accounting](#cost-accounting).
- **Billing reconciliation.** The counters are a control, not an invoice. They
  are based on what the provider reports and what the caller passes on, and
  they are intentionally conservative, so they will not match a bill to the
  cent.
- **Transport-level rate limiting.** Requests per second per IP is a different
  control, better placed at the edge. This library limits money, not traffic.
