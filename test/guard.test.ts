import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExceededError,
  InvalidConfigError,
  InvalidUsageError,
  LeaseSettledError,
  MissingSubjectError,
  PurseStringsError,
  UnknownModelError,
} from '../src/errors.js';
import { createGuard } from '../src/guard.js';
import { MemoryStore } from '../src/stores/memory.js';
import type { BudgetRule, BudgetStore, ConsumeResult, CounterUpdate } from '../src/types.js';

const PRICING = { 'gpt-4.1': { input: 2, output: 8 } };

/** The error a call was refused with. Fails the test if it was not refused. */
async function refusal<T>(call: Promise<unknown>): Promise<T> {
  try {
    await call;
  } catch (error) {
    return error as T;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

/** A mutable clock the guard and the store share, so windows and expiry agree. */
function clock(startedAt: number) {
  let value = startedAt;
  return {
    now: () => value,
    set(ms: number) {
      value = ms;
    },
    advance(ms: number) {
      value += ms;
    },
  };
}

function guardWith(rules: BudgetRule[], startedAt = Date.UTC(2026, 2, 10, 12)) {
  const time = clock(startedAt);
  const store = new MemoryStore({ now: time.now });
  const guard = createGuard({ store, rules, pricing: PRICING, now: time.now });
  return { guard, store, time };
}

describe('createGuard', () => {
  it('rejects a store that is not one', () => {
    expect(() => createGuard({ store: {} as BudgetStore, rules: [] })).toThrow(InvalidConfigError);
  });

  it('rejects a rule id that could not be a counter key', () => {
    for (const id of ['', 'a/b', 'a:b', 'a'.repeat(65), 'with space']) {
      expect(() =>
        createGuard({
          store: new MemoryStore(),
          rules: [{ id, scope: 'user', window: 'day', limits: { tokens: 1 } }],
        }),
      ).toThrow(InvalidConfigError);
    }
  });

  it('rejects two rules with the same id', () => {
    const rule: BudgetRule = { id: 'dup', scope: 'user', window: 'day', limits: { tokens: 1 } };

    expect(() => createGuard({ store: new MemoryStore(), rules: [rule, rule] })).toThrow(
      /share the id/,
    );
  });

  it('rejects a rule that limits nothing, and a non-positive limit', () => {
    const base = { id: 'r', scope: 'user', window: 'day' } as const;

    expect(() =>
      createGuard({ store: new MemoryStore(), rules: [{ ...base, limits: {} }] }),
    ).toThrow(/limits nothing/);
    expect(() =>
      createGuard({ store: new MemoryStore(), rules: [{ ...base, limits: { tokens: 0 } }] }),
    ).toThrow(InvalidConfigError);
    expect(() =>
      createGuard({ store: new MemoryStore(), rules: [{ ...base, limits: { costUsd: -1 } }] }),
    ).toThrow(InvalidConfigError);
    expect(() =>
      createGuard({ store: new MemoryStore(), rules: [{ ...base, limits: { requests: 2.5 } }] }),
    ).toThrow(InvalidConfigError);
  });

  it('rejects a price that is not a non-negative number', () => {
    expect(() =>
      createGuard({
        store: new MemoryStore(),
        rules: [],
        pricing: { m: { input: -1, output: 1 } },
      }),
    ).toThrow(InvalidConfigError);
  });

  it('rejects malformed options before any traffic reaches the guard', () => {
    const store = new MemoryStore();
    const rules: BudgetRule[] = [{ id: 'r', scope: 'user', window: 'day', limits: { tokens: 1 } }];

    expect(() => createGuard({ store, rules: 'day' as never })).toThrow(/rules must be an array/);
    expect(() => createGuard({ store, rules: [null as never] })).toThrow(InvalidConfigError);
    expect(() =>
      createGuard({ store, rules: [{ id: 'r', scope: '', window: 'day', limits: { tokens: 1 } }] }),
    ).toThrow(/non-empty scope/);
    expect(() =>
      createGuard({
        store,
        rules: [{ id: 'r', scope: 'user', window: 'day', limits: 5 as never }],
      }),
    ).toThrow(/limits object/);
    expect(() => createGuard({ store, rules, pricing: 'free' as never })).toThrow(
      /pricing must be an object/,
    );
    expect(() => createGuard({ store, rules, pricing: { m: 1 as never } })).toThrow(
      /must be an object/,
    );
    expect(() =>
      createGuard({ store, rules, pricing: { m: { input: 1, output: 1, cachedInput: -1 } } }),
    ).toThrow(/cachedInput/);
    expect(() => createGuard({ store, rules, defaultMaxOutputTokens: -1 })).toThrow(
      /defaultMaxOutputTokens/,
    );
    expect(() => createGuard({ store, rules, defaultMaxOutputTokens: 1.5 })).toThrow(
      InvalidConfigError,
    );
  });
});

describe('reserve', () => {
  it('books the input estimate plus the worst-case output across every applicable rule', async () => {
    const { guard, store } = guardWith([
      { id: 'user-daily', scope: 'user', window: 'day', limits: { tokens: 200_000 } },
      { id: 'session', scope: 'session', window: 'total', limits: { tokens: 50_000 } },
    ]);

    const lease = await guard.reserve({
      subjects: { user: 'u1', session: 's1' },
      model: 'gpt-4.1',
      inputTokens: 1_200,
      maxOutputTokens: 800,
    });

    expect(lease.reserved).toEqual({ tokens: 2_000, costMicros: 1_200 * 2 + 800 * 8, requests: 1 });

    const [daily, session] = await guard.usage({ subjects: { user: 'u1', session: 's1' } });
    expect(daily?.tokens.used).toBe(2_000);
    expect(session?.tokens.used).toBe(2_000);
    expect(store.size).toBe(2);
  });

  it('defaults the worst-case output to defaultMaxOutputTokens', async () => {
    const rules: BudgetRule[] = [
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 1_000_000 } },
    ];
    const { guard } = guardWith(rules);
    const lenient = createGuard({
      store: new MemoryStore(),
      rules,
      defaultMaxOutputTokens: 10,
    });

    const byDefault = await guard.reserve({ subjects: { user: 'u1' }, inputTokens: 100 });
    const configured = await lenient.reserve({ subjects: { user: 'u1' }, inputTokens: 100 });

    expect(byDefault.reserved.tokens).toBe(100 + 4096);
    expect(configured.reserved.tokens).toBe(110);
  });

  it('refuses when any one rule cannot absorb the reservation, and books nothing', async () => {
    const { guard } = guardWith([
      { id: 'roomy', scope: 'user', window: 'day', limits: { tokens: 1_000_000 } },
      { id: 'tight', scope: 'session', window: 'total', limits: { tokens: 100 } },
    ]);
    const subjects = { user: 'u1', session: 's1' };

    await expect(
      guard.reserve({ subjects, inputTokens: 60, maxOutputTokens: 60 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    const report = await guard.usage({ subjects });
    expect(report.map((rule) => rule.tokens.used)).toEqual([0, 0]);
  });

  it('allows a reservation that lands exactly on the limit and refuses the next token', async () => {
    const { guard } = guardWith([
      { id: 'tight', scope: 'user', window: 'day', limits: { tokens: 100 } },
    ]);
    const subjects = { user: 'u1' };

    await guard.reserve({ subjects, inputTokens: 50, maxOutputTokens: 50 });

    await expect(guard.reserve({ subjects, inputTokens: 1, maxOutputTokens: 0 })).rejects.toThrow(
      BudgetExceededError,
    );
  });

  it('carries the rule, dimension, numbers and retry time on the error', async () => {
    const startedAt = Date.UTC(2026, 2, 10, 12, 0, 0);
    const { guard } = guardWith(
      [{ id: 'user-daily', scope: 'user', window: 'day', limits: { costUsd: 1 } }],
      startedAt,
    );

    await guard.reserve({
      subjects: { user: 'u1' },
      model: 'gpt-4.1',
      inputTokens: 400_000,
      maxOutputTokens: 0,
    });

    const error = await refusal<BudgetExceededError>(
      guard.reserve({
        subjects: { user: 'u1' },
        model: 'gpt-4.1',
        inputTokens: 200_000,
        maxOutputTokens: 0,
      }),
    );

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error.code).toBe('BUDGET_EXCEEDED');
    expect(error.rule).toBe('user-daily');
    expect(error.scope).toBe('user');
    expect(error.subject).toBe('u1');
    expect(error.dimension).toBe('costMicros');
    expect(error.limit).toBe(1_000_000);
    expect(error.used).toBe(800_000);
    expect(error.requested).toBe(400_000);
    expect(error.resetAt).toBe(Date.UTC(2026, 2, 11));
    expect(error.retryAfterSeconds).toBe(12 * 60 * 60);
  });

  it('has no retry time for a window that never resets', async () => {
    const { guard } = guardWith([
      { id: 'forever', scope: 'user', window: 'total', limits: { requests: 1 } },
    ]);

    await guard.reserve({ subjects: { user: 'u1' } });
    const error = await refusal<BudgetExceededError>(guard.reserve({ subjects: { user: 'u1' } }));

    expect(error.dimension).toBe('requests');
    expect(error.resetAt).toBeNull();
    expect(error.retryAfterSeconds).toBeNull();
  });

  it('starts from zero once the window has rolled over', async () => {
    const { guard, time } = guardWith(
      [{ id: 'hourly', scope: 'user', window: 'hour', limits: { tokens: 100 } }],
      Date.UTC(2026, 2, 10, 12, 30),
    );
    const subjects = { user: 'u1' };

    await guard.reserve({ subjects, inputTokens: 100, maxOutputTokens: 0 });
    await expect(guard.reserve({ subjects, inputTokens: 1, maxOutputTokens: 0 })).rejects.toThrow(
      BudgetExceededError,
    );

    time.set(Date.UTC(2026, 2, 10, 13));

    await expect(
      guard.reserve({ subjects, inputTokens: 100, maxOutputTokens: 0 }),
    ).resolves.toBeDefined();
  });

  it('keeps subjects apart, including ones that would collide without encoding', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 10 } },
    ]);

    await guard.reserve({ subjects: { user: 'a:b' }, inputTokens: 10, maxOutputTokens: 0 });

    // 'a' + ':' + 'b' must not share a counter with 'a:b'.
    await expect(
      guard.reserve({ subjects: { user: 'a' }, inputTokens: 10, maxOutputTokens: 0 }),
    ).resolves.toBeDefined();
    await expect(
      guard.reserve({ subjects: { user: 'a:b' }, inputTokens: 1, maxOutputTokens: 0 }),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('rejects a subject too long to key safely', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 10 } },
    ]);

    await expect(guard.reserve({ subjects: { user: 'x'.repeat(201) } })).rejects.toThrow(
      /over the limit of 200/,
    );

    // Short enough by characters, but nine bytes each once percent-encoded.
    await expect(guard.reserve({ subjects: { user: '\u{1F4B8}'.repeat(100) } })).rejects.toThrow(
      /bytes once encoded/,
    );
  });

  it('shares one counter for a global rule, whoever calls', async () => {
    const { guard } = guardWith([
      { id: 'all', scope: 'global', window: 'month', limits: { requests: 2 } },
    ]);

    await guard.reserve({ subjects: { user: 'a' } });
    await guard.reserve({ subjects: { user: 'b' } });

    await expect(guard.reserve({ subjects: { user: 'c' } })).rejects.toThrow(BudgetExceededError);
  });
});

describe('fail closed', () => {
  it('throws when a required rule has no subject', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 10 } },
    ]);

    await expect(guard.reserve({ subjects: { session: 's1' } })).rejects.toBeInstanceOf(
      MissingSubjectError,
    );
    await expect(guard.reserve({ subjects: { user: '' } })).rejects.toThrow(MissingSubjectError);
    await expect(guard.reserve()).rejects.toThrow(MissingSubjectError);
  });

  it('skips an optional rule whose subject is absent and still applies the others', async () => {
    const { guard } = guardWith([
      { id: 'tenant', scope: 'tenant', window: 'day', limits: { tokens: 10 }, optional: true },
      { id: 'user', scope: 'user', window: 'day', limits: { tokens: 1_000 } },
    ]);

    const report = await guard.usage({ subjects: { user: 'u1' } });
    expect(report.map((rule) => rule.rule)).toEqual(['user']);

    await guard.reserve({ subjects: { user: 'u1' }, inputTokens: 100, maxOutputTokens: 0 });
    // With the tenant present the optional rule applies and is the tighter one.
    await expect(
      guard.reserve({
        subjects: { user: 'u1', tenant: 't1' },
        inputTokens: 100,
        maxOutputTokens: 0,
      }),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('throws when a cost limit applies and the model has no price', async () => {
    const { guard } = guardWith([
      { id: 'cost', scope: 'user', window: 'day', limits: { costUsd: 1 } },
    ]);

    await expect(
      guard.reserve({ subjects: { user: 'u1' }, model: 'o5-ultra', inputTokens: 10 }),
    ).rejects.toBeInstanceOf(UnknownModelError);
    await expect(guard.reserve({ subjects: { user: 'u1' }, inputTokens: 10 })).rejects.toThrow(
      /needs a model/,
    );
  });

  it('does not need a price when no cost limit applies', async () => {
    const { guard } = guardWith([
      { id: 'tokens', scope: 'user', window: 'day', limits: { tokens: 1_000 } },
    ]);

    const lease = await guard.reserve({
      subjects: { user: 'u1' },
      model: 'o5-ultra',
      inputTokens: 10,
      maxOutputTokens: 10,
    });

    expect(lease.reserved.costMicros).toBe(0);
  });

  it('still prices a call when the model is known and no cost limit applies', async () => {
    const { guard } = guardWith([
      { id: 'tokens', scope: 'user', window: 'day', limits: { tokens: 1_000 } },
    ]);

    const lease = await guard.reserve({
      subjects: { user: 'u1' },
      model: 'gpt-4.1',
      inputTokens: 100,
      maxOutputTokens: 100,
    });

    expect(lease.reserved.costMicros).toBe(100 * 2 + 100 * 8);
  });

  it('propagates a store failure rather than allowing the call', async () => {
    const broken: BudgetStore = {
      consistency: 'strong',
      consume: () => Promise.reject(new Error('firestore unavailable')),
      add: () => Promise.resolve(),
      read: () => Promise.resolve([]),
    };
    const guard = createGuard({
      store: broken,
      rules: [{ id: 'u', scope: 'user', window: 'day', limits: { tokens: 10 } }],
    });

    await expect(guard.reserve({ subjects: { user: 'u1' } })).rejects.toThrow(
      'firestore unavailable',
    );
  });

  it('rejects token counts that are negative, fractional or not finite', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 10 } },
    ]);
    const subjects = { user: 'u1' };

    for (const inputTokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(guard.reserve({ subjects, inputTokens })).rejects.toBeInstanceOf(
        InvalidUsageError,
      );
    }
  });

  it('rejects cached and cache-write tokens that exceed the input they are part of', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 1_000 } },
    ]);

    await expect(
      guard.reserve({
        subjects: { user: 'u1' },
        inputTokens: 100,
        cachedInputTokens: 80,
        cacheWriteTokens: 40,
      }),
    ).rejects.toThrow(InvalidUsageError);
  });

  it('gives every error a stable code on a shared base class', async () => {
    const { guard } = guardWith([{ id: 'u', scope: 'user', window: 'day', limits: { tokens: 1 } }]);

    const missing = await refusal<PurseStringsError>(guard.reserve({}));
    expect(missing).toBeInstanceOf(PurseStringsError);
    expect(missing.code).toBe('MISSING_SUBJECT');
    expect(new InvalidConfigError('x').code).toBe('INVALID_CONFIG');
  });
});

describe('commit and release', () => {
  it('books the difference between the reservation and what was really used', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 1_000_000, costUsd: 100 } },
    ]);
    const subjects = { user: 'u1' };

    const lease = await guard.reserve({
      subjects,
      model: 'gpt-4.1',
      inputTokens: 1_200,
      maxOutputTokens: 800,
    });
    await lease.commit({ inputTokens: 1_150, outputTokens: 640 });

    const [rule] = await guard.usage({ subjects });
    expect(rule?.tokens.used).toBe(1_790);
    expect(rule?.costMicros.used).toBe(1_150 * 2 + 640 * 8);
    expect(rule?.requests.used).toBe(1);
  });

  it('books the excess when the call used more than it reserved', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 1_000 } },
    ]);
    const subjects = { user: 'u1' };

    const lease = await guard.reserve({ subjects, inputTokens: 100, maxOutputTokens: 100 });
    await lease.commit({ inputTokens: 100, outputTokens: 500 });

    const [rule] = await guard.usage({ subjects });
    expect(rule?.tokens.used).toBe(600);
  });

  it('lets a caller-reported cost override the price table', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { costUsd: 100 } },
    ]);
    const subjects = { user: 'u1' };

    const lease = await guard.reserve({
      subjects,
      model: 'gpt-4.1',
      inputTokens: 1_000,
      maxOutputTokens: 1_000,
    });
    await lease.commit({ inputTokens: 1_000, outputTokens: 900, costUsd: 0.25 });

    const [rule] = await guard.usage({ subjects });
    expect(rule?.costMicros.used).toBe(250_000);
  });

  it('refunds tokens and cost on release but keeps the request counted', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 1_000, costUsd: 1, requests: 5 } },
    ]);
    const subjects = { user: 'u1' };

    const lease = await guard.reserve({
      subjects,
      model: 'gpt-4.1',
      inputTokens: 100,
      maxOutputTokens: 100,
    });
    await lease.release();

    const [rule] = await guard.usage({ subjects });
    expect(rule?.tokens.used).toBe(0);
    expect(rule?.costMicros.used).toBe(0);
    expect(rule?.requests.used).toBe(1);
  });

  it('throws on a second settle, whichever way round', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 1_000 } },
    ]);

    const committed = await guard.reserve({
      subjects: { user: 'u1' },
      inputTokens: 1,
      maxOutputTokens: 1,
    });
    await committed.commit({ inputTokens: 1, outputTokens: 1 });
    await expect(committed.commit({ inputTokens: 1, outputTokens: 1 })).rejects.toBeInstanceOf(
      LeaseSettledError,
    );
    await expect(committed.release()).rejects.toThrow(/already committed/);

    const released = await guard.reserve({
      subjects: { user: 'u1' },
      inputTokens: 1,
      maxOutputTokens: 1,
    });
    await released.release();
    await expect(released.commit()).rejects.toThrow(/already released/);
  });

  it('refuses the second of two settles that start at the same time', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 1_000 } },
    ]);
    const subjects = { user: 'u1' };

    const lease = await guard.reserve({ subjects, inputTokens: 100, maxOutputTokens: 100 });
    const settled = await Promise.allSettled([lease.release(), lease.release()]);

    expect(settled.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    const [rule] = await guard.usage({ subjects });
    expect(rule?.tokens.used).toBe(0);
  });

  it('settles against the window the reservation was made in, not the current one', async () => {
    const { guard, time } = guardWith(
      [{ id: 'hourly', scope: 'user', window: 'hour', limits: { tokens: 1_000 } }],
      Date.UTC(2026, 2, 10, 12, 59, 50),
    );
    const subjects = { user: 'u1' };

    const lease = await guard.reserve({ subjects, inputTokens: 100, maxOutputTokens: 100 });
    time.set(Date.UTC(2026, 2, 10, 13, 0, 5));
    await lease.release();

    // The new window is untouched; the refund went where the booking went.
    const [current] = await guard.usage({ subjects });
    expect(current?.tokens.used).toBe(0);
    expect(current?.windowStart).toBe(Date.UTC(2026, 2, 10, 13));
  });
});

describe('usage', () => {
  it('reports used, limit, remaining and reset time per rule', async () => {
    const startedAt = Date.UTC(2026, 2, 10, 12);
    const { guard } = guardWith(
      [
        { id: 'daily', scope: 'user', window: 'day', limits: { tokens: 1_000, costUsd: 0.5 } },
        { id: 'total', scope: 'user', window: 'total', limits: { requests: 3 } },
      ],
      startedAt,
    );
    const subjects = { user: 'u1' };

    const lease = await guard.reserve({
      subjects,
      model: 'gpt-4.1',
      inputTokens: 100,
      maxOutputTokens: 100,
    });
    await lease.commit({ inputTokens: 100, outputTokens: 50 });

    const [daily, total] = await guard.usage({ subjects });

    expect(daily).toEqual({
      rule: 'daily',
      scope: 'user',
      subject: 'u1',
      windowStart: Date.UTC(2026, 2, 10),
      resetAt: Date.UTC(2026, 2, 11),
      tokens: { used: 150, limit: 1_000, remaining: 850 },
      costMicros: { used: 600, limit: 500_000, remaining: 499_400 },
      requests: { used: 1, limit: null, remaining: null },
    });
    expect(total?.resetAt).toBeNull();
    expect(total?.requests).toEqual({ used: 1, limit: 3, remaining: 2 });
  });

  it('never reports a negative remaining once a commit has overshot', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 100 } },
    ]);
    const subjects = { user: 'u1' };

    const lease = await guard.reserve({ subjects, inputTokens: 50, maxOutputTokens: 50 });
    await lease.commit({ inputTokens: 50, outputTokens: 5_000 });

    const [rule] = await guard.usage({ subjects });
    expect(rule?.tokens.used).toBe(5_050);
    expect(rule?.tokens.remaining).toBe(0);
  });

  it('reports nothing when no rule applies', async () => {
    const guard = createGuard({ store: new MemoryStore(), rules: [] });

    expect(await guard.usage({ subjects: { user: 'u1' } })).toEqual([]);
  });
});

describe('concurrency', () => {
  it('never books past a limit when reservations race', async () => {
    const { guard } = guardWith([
      { id: 'u', scope: 'user', window: 'day', limits: { tokens: 1_000 } },
    ]);
    const subjects = { user: 'u1' };

    const outcomes = await Promise.allSettled(
      Array.from({ length: 200 }, () =>
        guard.reserve({ subjects, inputTokens: 50, maxOutputTokens: 50 }),
      ),
    );

    const admitted = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
    expect(admitted).toBe(10);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(BudgetExceededError);
    }

    const [rule] = await guard.usage({ subjects });
    expect(rule?.tokens.used).toBe(1_000);
  });

  it('holds the tightest of several rules under a race', async () => {
    const { guard } = guardWith([
      { id: 'global', scope: 'global', window: 'day', limits: { requests: 1_000 } },
      { id: 'user', scope: 'user', window: 'day', limits: { requests: 3 } },
    ]);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, () => guard.reserve({ subjects: { user: 'u1' } })),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(3);
    const [global] = await guard.usage({ subjects: { user: 'u1' } });
    expect(global?.requests.used).toBe(3);
  });
});

describe('store interaction', () => {
  it('asks the store once per reservation, with one update per applicable rule', async () => {
    const consume = vi.fn((updates: readonly CounterUpdate[]): Promise<ConsumeResult> => {
      expect(updates).toHaveLength(2);
      return Promise.resolve({ ok: true });
    });
    const guard = createGuard({
      store: {
        consistency: 'strong',
        consume,
        add: () => Promise.resolve(),
        read: () => Promise.resolve([]),
      },
      rules: [
        { id: 'a', scope: 'user', window: 'day', limits: { tokens: 10 } },
        { id: 'b', scope: 'global', window: 'day', limits: { tokens: 10 } },
      ],
    });

    await guard.reserve({ subjects: { user: 'u1' }, inputTokens: 1, maxOutputTokens: 1 });

    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('does not touch the store when no rule applies', async () => {
    const consume = vi.fn((): Promise<ConsumeResult> => Promise.resolve({ ok: true }));
    const add = vi.fn(() => Promise.resolve());
    const guard = createGuard({
      store: { consistency: 'strong', consume, add, read: () => Promise.resolve([]) },
      rules: [{ id: 'a', scope: 'tenant', window: 'day', limits: { tokens: 10 }, optional: true }],
    });

    const lease = await guard.reserve({ subjects: { user: 'u1' }, inputTokens: 5 });
    await lease.commit({ inputTokens: 5, outputTokens: 5 });

    expect(consume).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('refuses the call when the store names a counter it was never given', async () => {
    const guard = createGuard({
      store: {
        consistency: 'strong',
        consume: () =>
          Promise.resolve<ConsumeResult>({
            ok: false,
            key: 'some:other:key',
            current: { tokens: 0, costMicros: 0, requests: 0 },
          }),
        add: () => Promise.resolve(),
        read: () => Promise.resolve([]),
      },
      rules: [{ id: 'a', scope: 'user', window: 'day', limits: { tokens: 10 } }],
    });

    // A broken store must not end up allowing the call.
    await expect(guard.reserve({ subjects: { user: 'u1' }, inputTokens: 1 })).rejects.toThrow(
      /refused an unknown counter key/,
    );
  });
});
