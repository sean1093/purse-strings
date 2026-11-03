# Security Policy

## Supported versions

| Version | Supported | Notes |
|---|---|---|
| `0.x` | Yes | Pre-1.0 and actively maintained. Security fixes land on the latest `0.x` minor; there are no backports to earlier minors. |

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

**<https://github.com/sean1093/purse-strings/security/advisories/new>**

**Do not open a public issue, discussion, or pull request for a suspected
vulnerability.** A way to spend past a configured limit is a vulnerability, and
a public report tells everyone how to use it before a fix exists.

Please include:

- the version of `purse-strings` and of Node.js, Cloudflare Workers, Deno or Bun,
- which store you use (`MemoryStore`, `FirestoreStore`, `KVStore`,
  `DurableObjectStore`) and the rules you configured,
- a minimal snippet that reproduces the behaviour,
- the impact you believe it has, in terms of what can be spent.

You will get an acknowledgement within **5 business days**. If the report is
accepted we will agree a disclosure timeline with you, publish a fixed release,
and credit you in the advisory unless you ask us not to.

## Scope

`purse-strings` has **zero runtime dependencies** and performs no I/O of its
own: every read and write goes through the `BudgetStore` the caller supplies.
The asset it protects is the operator's LLM bill, so the security boundary is
the limit itself. See the
[threat model](https://github.com/sean1093/purse-strings/blob/main/docs/threat-model.md)
for the full statement of what is guaranteed.

In scope:

- **Booking past a limit with a strongly consistent store.** Any sequence of
  `reserve()`, `commit()`, `release()` and `startRun()` calls against
  `MemoryStore`, `FirestoreStore` or `DurableObjectStore` that leaves a
  counter above its configured limit by more than the documented reservation
  gap.
- **Settling a lease twice.** Any way to make one lease book or refund its
  reservation more than once, including racing `commit()` against `release()`.
- **Counter key collision.** Two distinct subjects, rules or windows sharing a
  counter, or a subject escaping its key — for example into a Firestore
  subcollection path.
- **Crashes or unbounded growth on hostile input.** A thrown error that is not
  a `PurseStringsError`, memory that grows without bound from
  attacker-controlled subjects or tool arguments, or input that makes a call
  hang.
- **A limit that silently stops applying.** A rule, dimension or window that is
  skipped rather than enforced, or a store error that is swallowed instead of
  throwing.

Out of scope:

- **The documented consistency limits of eventually consistent stores.**
  `KVStore` reports `consistency: 'eventual'`, and both the README and the
  threat model state that concurrent requests can read the same stale value
  and all pass. Demonstrating that is a demonstration of the documentation.
- **`MemoryStore` across processes.** It is strongly consistent within one
  process, which is documented; *N* replicas enforce the limit *N* times.
- **Overshoot bounded by the caller's own estimate.** A caller that reports
  `inputTokens` too low, or a provider that returns more than
  `maxOutputTokens`, overshoots by that difference at commit. This is the
  documented bound in the security goal.
- **A wrong price producing a wrong cost.** Pricing is supplied by the caller
  on purpose; the library has no price table to be stale.
- **Spend the guard was never asked about.** Calls made without `reserve()`,
  and provider-billed operations the caller does not reserve against.
- Vulnerabilities in development-only dependencies that cannot affect the
  published `dist/` output.
- Missing hardening with no demonstrated impact.
