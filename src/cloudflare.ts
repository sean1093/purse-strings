/**
 * `purse-strings/cloudflare` — counters on Cloudflare.
 *
 * ```ts
 * import { createGuard } from 'purse-strings';
 * import { KVStore } from 'purse-strings/cloudflare';
 *
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const guard = createGuard({
 *       store: new KVStore(env.BUDGETS),
 *       rules: [{ id: 'user-daily', scope: 'user', window: 'day', limits: { costUsd: 1 } }],
 *       pricing: { 'gpt-4.1': { input: 2, output: 8 } },
 *     });
 *     // ...
 *   },
 * };
 * ```
 *
 * Nothing from `@cloudflare/workers-types` is imported. The bindings are
 * typed structurally, naming only the members the stores call, so the types
 * `wrangler types` generates fit without this package depending on them.
 *
 * @packageDocumentation
 */

export {
  type KVNamespaceLike,
  type KVPutOptions,
  KVStore,
  type KVStoreOptions,
} from './stores/cloudflare/kv.js';
