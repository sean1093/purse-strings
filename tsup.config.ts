import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    firestore: 'src/firestore.ts',
    cloudflare: 'src/cloudflare.ts',
  },
  format: ['esm', 'cjs'],
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  treeshake: true,
  // A handful of small entry points with little shared code. Self-contained
  // files beat a shared chunk here: nothing extra to resolve at runtime, and
  // `size` measures what an importer actually downloads.
  splitting: false,
  clean: true,
  // The guard has to run on Cloudflare Workers, Deno and Bun as well as Node.
  // `neutral` resolves nothing from Node's built-in or package conditions, so
  // an accidental `node:*` import fails the build instead of the deployment.
  platform: 'neutral',
});
