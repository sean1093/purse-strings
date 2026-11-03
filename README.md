# purse-strings

Hold the purse strings on your LLM spend.

A denial-of-wallet guard for TypeScript apps that call LLM APIs: per-user,
per-session and global token, cost and request budgets, plus step, tool-call
and time limits for agent loops. It runs in your process and keeps its counters
in memory, Firestore or Cloudflare (Durable Objects or Workers KV).

> **Status:** under active development. The plan is tracked in the
> [v0.1.0 milestone](https://github.com/sean1093/purse-strings/milestone/1).

## License

[MIT](LICENSE)
