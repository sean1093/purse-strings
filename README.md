# purse-strings

Hold the purse strings on your LLM spend.

A denial-of-wallet guard for TypeScript apps that call LLM APIs: per-user,
per-session and global token, cost and request budgets, plus step, tool-call
and time limits for agent loops. It runs in your process and keeps its counters
in memory, Firestore or Cloudflare (Durable Objects or Workers KV).

> **Status:** under active development. The plan is tracked in the
> [v0.1.0 milestone](https://github.com/sean1093/purse-strings/milestone/1).

## Documentation

- [Threat model and design](https://github.com/sean1093/purse-strings/blob/main/docs/threat-model.md)
  — what the guard defends, what it guarantees under concurrency and failure,
  and where it stops.
- [The Firestore store](https://github.com/sean1093/purse-strings/blob/main/docs/firestore.md)
  — setup for Firebase and Google Cloud, the TTL policy on `expiresAt`, and
  the write rate a single counter document sustains.
- [The Cloudflare stores](https://github.com/sean1093/purse-strings/blob/main/docs/cloudflare.md)
  — the KV and Durable Objects bindings, and which of the two a hard
  limit needs.
- [Contributing](https://github.com/sean1093/purse-strings/blob/main/CONTRIBUTING.md)
  — scripts, project layout, how to add a store adapter, the quality gates and
  the release process.
- [Security policy](https://github.com/sean1093/purse-strings/blob/main/SECURITY.md)
  — what counts as a vulnerability here, and how to report one privately.
- [Code of conduct](https://github.com/sean1093/purse-strings/blob/main/CODE_OF_CONDUCT.md)

## License

[MIT](https://github.com/sean1093/purse-strings/blob/main/LICENSE)
