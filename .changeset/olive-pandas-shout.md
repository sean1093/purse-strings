---
"purse-strings": minor
---

First release. A denial-of-wallet guard for apps that call LLM APIs.

- `createGuard()` enforces per-user, per-session and global token, cost and
  request budgets over fixed UTC windows, booking the worst case of a call
  before it is made and settling the difference afterwards.
- `guard.startRun()` caps one agent loop: model calls, tool calls, the same
  tool called with the same arguments, a wall-clock deadline that aborts an
  `AbortSignal`, and a token and cost budget of its own.
- `usageFromOpenAI()`, `usageFromAnthropic()` and `usageFromGemini()`
  normalise provider usage without importing an SDK; `estimateTokens()`
  sizes a reservation.
- Stores: `MemoryStore`, `FirestoreStore` (`purse-strings/firestore`), and
  `KVStore` and `DurableObjectStore` with `BudgetCounterObject`
  (`purse-strings/cloudflare`). Each reports whether it is strongly or
  eventually consistent, and each is tested against its real backend with
  the same store contract suite.
