import { defineConfig } from 'vitest/config';

// No time zone is pinned. Budget windows are aligned to UTC by construction and
// the suite injects its own clock, so the host zone must not change a result --
// a run under TZ=Pacific/Kiritimati is a test of that.
export default defineConfig({
  test: {
    // Top level only. `test/integration/**` needs a backend the unit suite
    // does not, and runs from vitest.integration.config.ts.
    include: ['test/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The store adapters that need a backend are covered by the contract
      // suite in vitest.integration.config.ts, which this run does not
      // execute. Counting them here would measure the emulator job's work
      // against a run that never loads the file.
      exclude: [
        'src/firestore.ts',
        'src/stores/firestore.ts',
        'src/cloudflare.ts',
        'src/stores/cloudflare/**',
      ],
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
});
