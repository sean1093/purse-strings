/**
 * A Cloudflare Worker with the Durable Objects store, capping both the user
 * and the whole fleet, and capping one agent run on top of that.
 *
 * `wrangler.jsonc` for this Worker is in
 * [the Cloudflare guide](../docs/cloudflare.md#durableobjectstore).
 *
 * Run `npm run build` first: this file is type-checked against `dist/`, the
 * package as it is published.
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { BudgetExceededError, createGuard, RunLimitExceededError } from 'purse-strings';
import { BudgetCounterObject, DurableObjectStore } from 'purse-strings/cloudflare';

// The counter object has to be exported from the Worker's entry module.
export { BudgetCounterObject };

interface Env {
  BUDGET_COUNTERS: DurableObjectNamespace;
}

async function callTheModel(_prompt: string): Promise<{ text: string; tokens: number }> {
  return { text: 'answer', tokens: 0 };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const guard = createGuard({
      store: new DurableObjectStore(env.BUDGET_COUNTERS),
      rules: [
        { id: 'user-daily', scope: 'user', window: 'day', limits: { costUsd: 1 } },
        { id: 'fleet-daily', scope: 'global', window: 'day', limits: { costUsd: 200 } },
      ],
      pricing: { 'gpt-4.1': { input: 2, output: 8 } },
    });

    const userId = request.headers.get('cf-access-authenticated-user-email') ?? 'anonymous';

    // One agent run: at most eight model calls, forty tool calls, the same
    // tool with the same arguments at most three times, and two minutes.
    const run = guard.startRun({
      subjects: { user: userId },
      model: 'gpt-4.1',
      maxSteps: 8,
      maxToolCalls: 40,
      maxIdenticalToolCalls: 3,
      maxDurationMs: 120_000,
      limits: { tokens: 100_000, costUsd: 0.5 },
    });

    try {
      const lease = await run.reserve({ inputTokens: 1_200, maxOutputTokens: 800 });
      try {
        const completion = await callTheModel('hello');
        await lease.commit({ inputTokens: 1_200, outputTokens: completion.tokens });
        return Response.json({ text: completion.text });
      } catch (error) {
        await lease.release();
        throw error;
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        return Response.json(
          { error: error.code, rule: error.rule, resetAt: error.resetAt },
          {
            status: 429,
            headers:
              error.retryAfterSeconds === null
                ? {}
                : { 'retry-after': String(error.retryAfterSeconds) },
          },
        );
      }
      if (error instanceof RunLimitExceededError) {
        // The run hit its own cap, not the user's budget. Nothing is booked.
        return Response.json(
          { error: error.code, limit: error.limit, max: error.max },
          { status: 429 },
        );
      }
      throw error;
    } finally {
      // Aborts `run.signal`, so anything still in flight is cancelled.
      run.end();
    }
  },
};
