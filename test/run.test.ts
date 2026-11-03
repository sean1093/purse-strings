import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExceededError,
  InvalidConfigError,
  InvalidUsageError,
  LoopDetectedError,
  RunLimitExceededError,
  UnknownModelError,
} from '../src/errors.js';
import { createGuard } from '../src/guard.js';
import { MemoryStore } from '../src/stores/memory.js';
import type { BudgetRule } from '../src/types.js';

const PRICING = { 'gpt-4.1': { input: 2, output: 8 } };

/** 2026-03-10T12:00:00Z: fixed, so no result depends on the day it runs. */
const START = Date.UTC(2026, 2, 10, 12);

/** The start of the UTC day `START` falls in: the window part of a counter key. */
const DAY = Date.UTC(2026, 2, 10);

/** A mutable clock the guard and the store share, so windows and expiry agree. */
function clock(startedAt: number) {
  let value = startedAt;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function guardWith(rules: BudgetRule[] = []) {
  const time = clock(START);
  const store = new MemoryStore({ now: time.now });
  const guard = createGuard({ store, rules, pricing: PRICING, now: time.now });
  return { guard, store, time };
}

/** The error a call was refused with. Fails the test if it was not refused. */
async function refusal<T>(call: Promise<unknown>): Promise<T> {
  try {
    await call;
  } catch (error) {
    return error as T;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

/** The error a synchronous call threw. Fails the test if it did not throw. */
function thrown<T>(call: () => void): T {
  try {
    call();
  } catch (error) {
    return error as T;
  }
  throw new Error('expected the call to throw, but it returned');
}

function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

describe('Guard.startRun', () => {
  describe('step limit', () => {
    it('admits exactly maxSteps reservations and books nothing for the one past it', async () => {
      const { guard, store } = guardWith([
        { id: 'global', scope: 'global', window: 'day', limits: { tokens: 1_000_000 } },
      ]);
      const run = guard.startRun({ maxSteps: 2 });

      await run.reserve({ inputTokens: 10, maxOutputTokens: 5 });
      await run.reserve({ inputTokens: 10, maxOutputTokens: 5 });
      const error = await refusal<RunLimitExceededError>(run.reserve({ inputTokens: 10 }));

      expect(error).toBeInstanceOf(RunLimitExceededError);
      expect(error.code).toBe('RUN_LIMIT_EXCEEDED');
      expect([error.limit, error.max, error.actual]).toEqual(['steps', 2, 3]);
      expect(run.steps).toBe(2);
      expect(await store.read([`global:global:${DAY}`])).toEqual([
        { tokens: 30, costMicros: 0, requests: 2 },
      ]);
    });

    it('counts no step for a reservation a budget rule refused', async () => {
      const { guard } = guardWith([
        { id: 'global', scope: 'global', window: 'day', limits: { requests: 1 } },
      ]);
      const run = guard.startRun({ maxSteps: 10 });

      await run.reserve({ inputTokens: 1 });
      await expect(run.reserve({ inputTokens: 1 })).rejects.toBeInstanceOf(BudgetExceededError);

      expect(run.steps).toBe(1);
    });
  });

  describe('tool-call limits', () => {
    it('admits exactly maxToolCalls invocations', () => {
      const run = guardWith().guard.startRun({ maxToolCalls: 2 });

      run.recordToolCall('search');
      run.recordToolCall('fetch');
      const error = thrown<RunLimitExceededError>(() => run.recordToolCall('search'));

      expect([error.limit, error.max, error.actual]).toEqual(['toolCalls', 2, 3]);
      expect(run.toolCalls).toBe(2);
    });

    it('treats arguments as identical regardless of key order', () => {
      const run = guardWith().guard.startRun({ maxIdenticalToolCalls: 2 });

      run.recordToolCall('search', { query: 'pricing', filters: { lang: 'en', page: 1 } });
      run.recordToolCall('search', { filters: { page: 1, lang: 'en' }, query: 'pricing' });

      expect(() =>
        run.recordToolCall('search', { query: 'pricing', filters: { lang: 'en', page: 1 } }),
      ).toThrow(LoopDetectedError);
    });

    it('separates different arguments, different tools and array order', () => {
      const run = guardWith().guard.startRun({ maxIdenticalToolCalls: 1 });

      run.recordToolCall('search', { query: 'a' });
      run.recordToolCall('search', { query: 'b' });
      run.recordToolCall('fetch', { query: 'a' });
      run.recordToolCall('search', { ids: [1, 2] });
      run.recordToolCall('search', { ids: [2, 1] });
      // No arguments at all is its own signature, not the same as `{}`.
      run.recordToolCall('search');

      expect(run.toolCalls).toBe(6);
      expect(() => run.recordToolCall('search', { query: 'a' })).toThrow(LoopDetectedError);
    });

    it('keeps values JSON would drop or reject inside the signature', () => {
      const run = guardWith().guard.startRun({ maxIdenticalToolCalls: 1 });

      run.recordToolCall('page', { limit: 10n });
      // An explicit `undefined` and a missing key are different calls, even
      // though `JSON.stringify` renders them the same.
      run.recordToolCall('page', { limit: 10n, after: undefined });
      run.recordToolCall('page', { limit: 10n, onDone: () => undefined });

      expect(run.toolCalls).toBe(3);
      expect(() => run.recordToolCall('page', { limit: 10n })).toThrow(LoopDetectedError);
    });

    it('does not count the refused repetition, so a retry reports the same count', () => {
      const run = guardWith().guard.startRun({ maxIdenticalToolCalls: 1 });
      run.recordToolCall('search', { query: 'pricing' });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const error = thrown<LoopDetectedError>(() =>
          run.recordToolCall('search', { query: 'pricing' }),
        );
        expect([error.code, error.tool, error.count]).toEqual(['LOOP_DETECTED', 'search', 2]);
      }

      expect(run.toolCalls).toBe(1);
    });

    it('compares self-referencing arguments without hanging', () => {
      const run = guardWith().guard.startRun({ maxIdenticalToolCalls: 1 });

      const first: Record<string, unknown> = { name: 'node' };
      first.self = first;
      run.recordToolCall('walk', first);

      const second: Record<string, unknown> = { name: 'node' };
      second.self = second;
      expect(() => run.recordToolCall('walk', second)).toThrow(LoopDetectedError);
    });

    it('keeps two long but different argument sets apart once truncated', () => {
      const run = guardWith().guard.startRun({ maxIdenticalToolCalls: 1 });
      const shared = 'x'.repeat(8192);

      run.recordToolCall('write', { body: shared });
      // The same 4 kB prefix, a different total length: not the same call.
      run.recordToolCall('write', { body: `${shared}${shared}` });

      expect(run.toolCalls).toBe(2);
    });

    it('bounds the work a shared-reference argument graph costs', () => {
      const run = guardWith().guard.startRun({ maxIdenticalToolCalls: 1 });
      // 24 levels, every level holding the one below it twice: 25 objects
      // that a depth-bounded walk alone visits 2^24 times.
      let node: Record<string, unknown> = { leaf: 1 };
      for (let level = 0; level < 24; level += 1) node = { left: node, right: node };

      const startedAt = performance.now();
      run.recordToolCall('plan', node);
      const elapsed = performance.now() - startedAt;

      expect(elapsed).toBeLessThan(2_000);
      expect(() => run.recordToolCall('plan', node)).toThrow(LoopDetectedError);
    });

    it('rejects a tool name that could not identify a call', () => {
      const run = guardWith().guard.startRun({ maxToolCalls: 5 });

      expect(() => run.recordToolCall('')).toThrow(InvalidUsageError);
      expect(run.toolCalls).toBe(0);
    });
  });

  describe('deadline', () => {
    it('expires on the timer and aborts the signal with the reason', async () => {
      vi.useFakeTimers({ now: START });
      try {
        const run = createGuard({ store: new MemoryStore(), rules: [] }).startRun({
          maxDurationMs: 30_000,
        });
        expect(run.endsAt).toBe(START + 30_000);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(run.signal.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);

        expect(run.signal.aborted).toBe(true);
        const reason = run.signal.reason as RunLimitExceededError;
        expect([reason.limit, reason.max, reason.actual]).toEqual(['duration', 30_000, 30_000]);
        await expect(run.reserve()).rejects.toBeInstanceOf(RunLimitExceededError);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the deadline timer when the run ends', () => {
      vi.useFakeTimers({ now: START });
      try {
        const run = createGuard({ store: new MemoryStore(), rules: [] }).startRun({
          maxDurationMs: 30_000,
        });

        run.end();

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-arms a deadline wider than a 32-bit timer instead of firing at once', async () => {
      vi.useFakeTimers({ now: START });
      try {
        // Over 2^31-1 milliseconds: `setTimeout` cannot hold the delay, and
        // Node fires it immediately rather than weeks later.
        const run = createGuard({ store: new MemoryStore(), rules: [] }).startRun({
          maxDurationMs: 3 * 2_147_483_647,
        });

        await vi.advanceTimersByTimeAsync(2_147_483_647);
        expect(run.signal.aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(2 * 2_147_483_647);

        expect(run.signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('expires on the clock even when the timer never gets to fire', async () => {
      const { guard, time } = guardWith();
      const run = guard.startRun({ maxDurationMs: 1_000 });

      time.advance(1_500);

      const error = await refusal<RunLimitExceededError>(run.reserve());
      expect([error.limit, error.max, error.actual]).toEqual(['duration', 1_000, 1_500]);
      expect(run.signal.aborted).toBe(true);
      expect(() => run.recordToolCall('search')).toThrow(RunLimitExceededError);
    });

    it('does not keep a Node.js process alive with its deadline timer', () => {
      const { guard } = guardWith();
      const before = activeTimers();

      const run = guard.startRun({ maxDurationMs: 3_600_000 });
      const during = activeTimers();
      run.end();

      expect(during).toBe(before);
    });
  });

  describe('overlapping reservations', () => {
    it('counts a step that is still in flight against maxSteps', async () => {
      const { guard } = guardWith([
        { id: 'global', scope: 'global', window: 'day', limits: { tokens: 1_000_000 } },
      ]);
      const run = guard.startRun({ maxSteps: 1 });

      const settled = await Promise.allSettled([
        run.reserve({ inputTokens: 1, maxOutputTokens: 0 }),
        run.reserve({ inputTokens: 1, maxOutputTokens: 0 }),
      ]);

      expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
      expect(run.steps).toBe(1);
    });

    it('counts tokens that are still in flight against the run budget', async () => {
      const { guard, store } = guardWith([
        { id: 'global', scope: 'global', window: 'day', limits: { tokens: 1_000_000 } },
      ]);
      const run = guard.startRun({ limits: { tokens: 100 } });

      const settled = await Promise.allSettled([
        run.reserve({ inputTokens: 90, maxOutputTokens: 0 }),
        run.reserve({ inputTokens: 90, maxOutputTokens: 0 }),
      ]);

      expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
      expect(run.tokens).toBe(90);
      expect(await store.read([`global:global:${DAY}`])).toEqual([
        { tokens: 90, costMicros: 0, requests: 1 },
      ]);
    });
  });

  describe('run budget', () => {
    it('refuses the reservation that would cross the token budget, before the store', async () => {
      const { guard, store } = guardWith([
        { id: 'global', scope: 'global', window: 'day', limits: { tokens: 1_000_000 } },
      ]);
      const run = guard.startRun({ limits: { tokens: 100 } });

      await run.reserve({ inputTokens: 40, maxOutputTokens: 20 });
      const error = await refusal<RunLimitExceededError>(
        run.reserve({ inputTokens: 40, maxOutputTokens: 20 }),
      );

      expect([error.limit, error.max, error.actual]).toEqual(['tokens', 100, 120]);
      expect(run.tokens).toBe(60);
      expect(await store.read([`global:global:${DAY}`])).toEqual([
        { tokens: 60, costMicros: 0, requests: 1 },
      ]);
    });

    it('frees the room a commit gives back, so the next step fits', async () => {
      const { guard } = guardWith();
      const run = guard.startRun({ limits: { tokens: 100 } });

      const lease = await run.reserve({ inputTokens: 40, maxOutputTokens: 50 });
      await lease.commit({ inputTokens: 40, outputTokens: 2 });
      expect(run.tokens).toBe(42);

      await run.reserve({ inputTokens: 8, maxOutputTokens: 50 });
      expect(run.tokens).toBe(100);
    });

    it('frees the whole reservation on release', async () => {
      const { guard } = guardWith();
      const run = guard.startRun({ limits: { tokens: 100 } });

      const lease = await run.reserve({ inputTokens: 90, maxOutputTokens: 10 });
      await lease.release();

      expect(run.tokens).toBe(0);
      await expect(run.reserve({ inputTokens: 90, maxOutputTokens: 10 })).resolves.toBeDefined();
    });

    it('keeps a cost budget even when no rule limits cost', async () => {
      const { guard } = guardWith([
        { id: 'global', scope: 'global', window: 'day', limits: { tokens: 1_000_000 } },
      ]);
      // gpt-4.1 is $2 per million input and $8 per million output, so
      // 1000 + 1000 tokens is 10,000 micro-dollars.
      const run = guard.startRun({ model: 'gpt-4.1', limits: { costUsd: 0.015 } });

      await run.reserve({ inputTokens: 1_000, maxOutputTokens: 1_000 });
      expect(run.costMicros).toBe(10_000);

      const error = await refusal<RunLimitExceededError>(
        run.reserve({ inputTokens: 1_000, maxOutputTokens: 1_000 }),
      );
      expect([error.limit, error.max, error.actual]).toEqual(['costMicros', 15_000, 20_000]);
    });

    it('refuses to run a cost budget it cannot price', async () => {
      const { guard } = guardWith();
      const run = guard.startRun({ limits: { costUsd: 1 } });

      await expect(run.reserve({ model: 'o-unknown', inputTokens: 10 })).rejects.toBeInstanceOf(
        UnknownModelError,
      );
    });

    it('rejects a cap that is not a positive finite number', () => {
      const { guard } = guardWith();

      expect(() => guard.startRun({ maxSteps: 0 })).toThrow(InvalidConfigError);
      expect(() => guard.startRun({ maxSteps: 1.5 })).toThrow(InvalidConfigError);
      expect(() => guard.startRun({ maxDurationMs: Number.NaN })).toThrow(InvalidConfigError);
      expect(() => guard.startRun({ maxToolCalls: -1 })).toThrow(InvalidConfigError);
      expect(() => guard.startRun({ limits: { costUsd: Number.POSITIVE_INFINITY } })).toThrow(
        InvalidConfigError,
      );
    });
  });

  describe('run options', () => {
    it('applies the run subjects and model, and lets a call override them', async () => {
      const { guard, store } = guardWith([
        { id: 'user', scope: 'user', window: 'day', limits: { costUsd: 10 } },
        { id: 'session', scope: 'session', window: 'day', limits: { tokens: 1_000_000 } },
      ]);
      const run = guard.startRun({ subjects: { user: 'u1', session: 's1' }, model: 'gpt-4.1' });

      await run.reserve({ inputTokens: 1_000, maxOutputTokens: 0 });
      await run.reserve({ subjects: { session: 's2' }, inputTokens: 1_000, maxOutputTokens: 0 });

      expect(
        await store.read([`user:u1:${DAY}`, `session:s1:${DAY}`, `session:s2:${DAY}`]),
      ).toEqual([
        { tokens: 2_000, costMicros: 4_000, requests: 2 },
        { tokens: 1_000, costMicros: 2_000, requests: 1 },
        { tokens: 1_000, costMicros: 2_000, requests: 1 },
      ]);
    });

    it('caps nothing when no cap is configured', async () => {
      const { guard } = guardWith();
      const run = guard.startRun();

      expect(run.endsAt).toBeNull();
      for (let step = 0; step < 50; step += 1) {
        await run.reserve({ inputTokens: 1 });
        run.recordToolCall('search', { query: 'pricing' });
      }

      expect([run.steps, run.toolCalls]).toEqual([50, 50]);
    });

    it('refuses every call after end(), and aborts the signal once', async () => {
      const { guard } = guardWith();
      const run = guard.startRun({ maxDurationMs: 60_000 });
      let aborts = 0;
      run.signal.addEventListener('abort', () => {
        aborts += 1;
      });

      run.end();
      run.end();

      expect(aborts).toBe(1);
      expect(run.signal.aborted).toBe(true);
      expect(() => run.recordToolCall('search')).toThrow(InvalidUsageError);
      await expect(run.reserve()).rejects.toBeInstanceOf(InvalidUsageError);
    });

    it('keeps reporting an expired run as expired after end()', async () => {
      const { guard, time } = guardWith();
      const run = guard.startRun({ maxDurationMs: 1_000 });

      time.advance(2_000);
      await expect(run.reserve()).rejects.toBeInstanceOf(RunLimitExceededError);
      run.end();

      await expect(run.reserve()).rejects.toBeInstanceOf(RunLimitExceededError);
    });
  });
});
