import { defineConfig } from 'vitest/config';

// The suites that need a backend the unit suite does not: the Firestore
// emulator today, and whatever a later store adapter brings. They are kept out
// of the default run because a contributor without an emulator should still be
// able to run `npm test`, and because running them across the whole Node
// matrix would buy nothing: they test one adapter against one backend, not the
// library against a runtime.
//
// No coverage thresholds. Each suite covers one file, and a threshold over the
// whole of `src/` would fail on everything it deliberately does not touch.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // A store contract run against a real backend is network-bound, and the
    // concurrency case issues two dozen transactions against one document.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One backend, shared by every suite in the run: files that interleaved
    // transactions on it would make a contention failure unreproducible.
    fileParallelism: false,
  },
});
