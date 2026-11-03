/**
 * An HTTP handler on Cloud Run or Cloud Functions, with the Firestore store.
 *
 * The shape is the one every server should use: reserve the worst case before
 * the model call, commit the real usage after it, release on any failure. A
 * refused reservation answers 429 with `Retry-After`.
 *
 * Run `npm run build` first: this file is type-checked against `dist/`, the
 * package as it is published.
 */

import { createServer } from 'node:http';
import { Firestore } from '@google-cloud/firestore';
import {
  BudgetExceededError,
  createGuard,
  estimateTokens,
  PurseStringsError,
  usageFromOpenAI,
} from 'purse-strings';
import { FirestoreStore } from 'purse-strings/firestore';

const guard = createGuard({
  store: new FirestoreStore(new Firestore()),
  rules: [
    { id: 'user-daily', scope: 'user', window: 'day', limits: { costUsd: 1 } },
    { id: 'user-minute', scope: 'user', window: 'minute', limits: { requests: 20 } },
    { id: 'fleet-daily', scope: 'global', window: 'day', limits: { costUsd: 200 } },
  ],
  pricing: { 'gpt-4.1': { input: 2, output: 8 } },
});

/** Whatever your auth middleware resolves. Never read this from the body. */
function userIdOf(authorization: string | undefined): string {
  if (authorization === undefined) throw new Error('unauthenticated');
  return authorization.slice('Bearer '.length);
}

async function callTheModel(prompt: string): Promise<{
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}> {
  // Your provider SDK call goes here.
  return { text: `echo: ${prompt}`, usage: { prompt_tokens: 0, completion_tokens: 0 } };
}

export const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const prompt = (JSON.parse(body) as { prompt: string }).prompt;

  const lease = await guard
    .reserve({
      subjects: { user: userIdOf(request.headers.authorization) },
      model: 'gpt-4.1',
      inputTokens: estimateTokens(prompt),
      maxOutputTokens: 1_000,
    })
    .catch((error: unknown) => {
      if (error instanceof BudgetExceededError) return error;
      throw error;
    });

  if (lease instanceof BudgetExceededError) {
    response.writeHead(429, {
      'content-type': 'application/json',
      // `null` for a `total` window, which never resets.
      ...(lease.retryAfterSeconds === null
        ? {}
        : { 'retry-after': String(lease.retryAfterSeconds) }),
    });
    response.end(
      JSON.stringify({
        error: lease.code,
        rule: lease.rule,
        dimension: lease.dimension,
        resetAt: lease.resetAt,
      }),
    );
    return;
  }

  try {
    const completion = await callTheModel(prompt);
    // The provider's real counts replace the reservation; the difference is
    // refunded, so a short answer does not cost a long one's budget.
    await lease.commit(usageFromOpenAI(completion.usage));

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: completion.text }));
  } catch (error) {
    // The call failed, so give the reservation back. The request itself stays
    // counted: it was made.
    await lease.release();
    const status = error instanceof PurseStringsError ? 400 : 502;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'upstream failed' }));
  }
});
