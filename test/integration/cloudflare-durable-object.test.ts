import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import { InvalidConfigError } from '../../src/errors.js';
import {
  type DurableObjectNamespaceLike,
  DurableObjectStore,
} from '../../src/stores/cloudflare/durable-object.js';
import { runStoreContract } from '../contract/store-contract.js';

/**
 * The Durable Objects adapter against Miniflare, which runs the same workerd
 * Cloudflare runs. The object has to be a module in a real Worker script, so
 * the TypeScript source is bundled here the way a user's build would bundle
 * it; that also proves `BudgetCounterObject` carries no import a Worker
 * cannot resolve.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const entry = resolve(here, '../../src/stores/cloudflare/durable-object.ts');

const bundle = await build({
  stdin: {
    contents: `export { BudgetCounterObject } from ${JSON.stringify(entry)};
export default { fetch: () => new Response(null, { status: 404 }) };`,
    resolveDir: here,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  // The setting tsup builds the package with: nothing resolves from Node, so
  // an accidental `node:*` import fails here instead of in production.
  platform: 'neutral',
  write: false,
  plugins: [
    {
      // The sources import with the `.js` specifier ESM requires; the files
      // on disk are `.ts`.
      name: 'typescript-sources',
      setup(builder) {
        builder.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => ({
          path: resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts')),
        }));
      },
    },
  ],
});

const miniflare = new Miniflare({
  modules: true,
  compatibilityDate: '2026-01-01',
  script: bundle.outputFiles[0]?.text as string,
  durableObjects: { COUNTERS: 'BudgetCounterObject' },
});

const namespace = (await miniflare.getDurableObjectNamespace(
  'COUNTERS',
)) as unknown as DurableObjectNamespaceLike;

afterAll(async () => {
  await miniflare.dispose();
});

runStoreContract('DurableObjectStore', (startedAt) => {
  let now = startedAt;
  return {
    store: new DurableObjectStore(namespace, { prefix: 'contract:', now: () => now }),
    setNow(ms: number) {
      now = ms;
    },
  };
});

describe('DurableObjectStore', () => {
  const store = new DurableObjectStore(namespace, { prefix: 'behaviour:' });

  function key(label: string): string {
    return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  it('reports strong consistency, which is what makes a hard limit possible', () => {
    expect(store.consistency).toBe('strong');
  });

  it('gives back the counters it booked when a later one in the batch refuses', async () => {
    const first = key('first');
    const second = key('second');
    const delta = { tokens: 5, costMicros: 0, requests: 1 };

    await store.consume([{ key: first, delta, limits: { tokens: 100 }, expiresAt: null }]);

    const result = await store.consume([
      { key: first, delta, limits: { tokens: 100 }, expiresAt: null },
      { key: second, delta, limits: { tokens: 4 }, expiresAt: null },
    ]);

    expect(result).toEqual({
      ok: false,
      key: second,
      current: { tokens: 0, costMicros: 0, requests: 0 },
    });
    // The first counter was booked, then compensated back to what it was.
    expect(await store.read([first, second])).toEqual([
      { tokens: 5, costMicros: 0, requests: 1 },
      { tokens: 0, costMicros: 0, requests: 0 },
    ]);
  });

  it('gives back what it booked when a counter in the batch fails outright', async () => {
    const unprefixed = new DurableObjectStore(namespace);
    const booked = key('booked');
    const delta = { tokens: 9, costMicros: 0, requests: 1 };

    await expect(
      unprefixed.consume([
        { key: booked, delta, expiresAt: null },
        // An empty name addresses no object, so this one throws rather than
        // refusing. The compensation has to run for a throw too.
        { key: '', delta, expiresAt: null },
      ]),
    ).rejects.toThrow();

    expect(await unprefixed.read([booked])).toEqual([{ tokens: 0, costMicros: 0, requests: 0 }]);
  });

  it('rejects a binding that is not a Durable Object namespace', () => {
    expect(() => new DurableObjectStore({} as unknown as DurableObjectNamespaceLike)).toThrow(
      InvalidConfigError,
    );
  });
});
