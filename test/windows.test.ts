import { describe, expect, it } from 'vitest';
import { InvalidConfigError } from '../src/errors.js';
import { retryAfterSeconds, validateWindow, windowAt } from '../src/windows.js';

/** Readable assertions: window bounds are epoch milliseconds. */
function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

describe('windowAt', () => {
  it('floors to the start of the minute, hour and day in UTC', () => {
    const now = Date.UTC(2026, 4, 17, 13, 47, 29, 123);

    expect(iso(windowAt('minute', now).start)).toBe('2026-05-17T13:47:00.000Z');
    expect(iso(windowAt('hour', now).start)).toBe('2026-05-17T13:00:00.000Z');
    expect(iso(windowAt('day', now).start)).toBe('2026-05-17T00:00:00.000Z');
  });

  it('is unaffected by the host time zone', () => {
    // 2026-01-01T07:30Z is still 2025-12-31 in Honolulu and already the 1st in
    // Taipei. The window is the UTC one in both cases.
    const now = Date.UTC(2026, 0, 1, 7, 30);

    expect(iso(windowAt('day', now).start)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(windowAt('month', now).start)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('resets a month window at the first of the next month', () => {
    const endOfMonth = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
    const january = windowAt('month', endOfMonth);

    expect(iso(january.start)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(january.resetAt)).toBe('2026-02-01T00:00:00.000Z');

    const february = windowAt('month', january.resetAt as number);
    expect(iso(february.start)).toBe('2026-02-01T00:00:00.000Z');
    expect(iso(february.resetAt)).toBe('2026-03-01T00:00:00.000Z');
  });

  it('rolls a December month window into the next year', () => {
    const december = windowAt('month', Date.UTC(2026, 11, 25, 6));

    expect(iso(december.start)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(december.resetAt)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('gives February 29 days in a leap year and 28 otherwise', () => {
    const leap = windowAt('month', Date.UTC(2028, 1, 29, 12));
    expect(iso(leap.start)).toBe('2028-02-01T00:00:00.000Z');
    expect(iso(leap.resetAt)).toBe('2028-03-01T00:00:00.000Z');
    expect((leap.resetAt as number) - leap.start).toBe(29 * 86_400_000);

    const common = windowAt('month', Date.UTC(2026, 1, 28, 12));
    expect((common.resetAt as number) - common.start).toBe(28 * 86_400_000);
  });

  it('keeps the leap day inside its own day window', () => {
    const leapDay = windowAt('day', Date.UTC(2028, 1, 29, 23, 59, 59, 999));

    expect(iso(leapDay.start)).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(leapDay.resetAt)).toBe('2028-03-01T00:00:00.000Z');
  });

  it('starts an ISO week on Monday, including across a year boundary', () => {
    // 2026-01-01 is a Thursday, so its ISO week began on Monday 2025-12-29.
    const thursday = windowAt('week', Date.UTC(2026, 0, 1, 9));
    expect(iso(thursday.start)).toBe('2025-12-29T00:00:00.000Z');
    expect(iso(thursday.resetAt)).toBe('2026-01-05T00:00:00.000Z');

    // Sunday is the last day of its week, not the first.
    const sunday = windowAt('week', Date.UTC(2026, 0, 4, 23, 59, 59, 999));
    expect(iso(sunday.start)).toBe('2025-12-29T00:00:00.000Z');

    const monday = windowAt('week', Date.UTC(2026, 0, 5));
    expect(iso(monday.start)).toBe('2026-01-05T00:00:00.000Z');
  });

  it('starts the epoch week on the Monday before the epoch', () => {
    // The epoch itself was a Thursday, which is the case a naive
    // floor-to-seven-days gets wrong.
    expect(iso(windowAt('week', 0).start)).toBe('1969-12-29T00:00:00.000Z');
  });

  it('aligns a custom window to the epoch', () => {
    const now = Date.UTC(2026, 4, 17, 13, 47, 29);
    const ten = windowAt({ seconds: 10 }, now);

    expect(iso(ten.start)).toBe('2026-05-17T13:47:20.000Z');
    expect(iso(ten.resetAt)).toBe('2026-05-17T13:47:30.000Z');

    const ninety = windowAt({ seconds: 90 }, now);
    expect((ninety.resetAt as number) - ninety.start).toBe(90_000);
    expect(ninety.start % 90_000).toBe(0);
  });

  it('never resets a total window', () => {
    expect(windowAt('total', Date.UTC(2026, 4, 17))).toEqual({ start: 0, resetAt: null });
  });
});

describe('validateWindow', () => {
  it('rejects an unknown name and a seconds value that is not a usable length', () => {
    expect(() => validateWindow('fortnight' as never, 'r')).toThrow(InvalidConfigError);
    expect(() => validateWindow({ seconds: 0 }, 'r')).toThrow(InvalidConfigError);
    expect(() => validateWindow({ seconds: -60 }, 'r')).toThrow(InvalidConfigError);
    expect(() => validateWindow({ seconds: 1.5 }, 'r')).toThrow(InvalidConfigError);
    expect(() => validateWindow({ seconds: Number.NaN }, 'r')).toThrow(InvalidConfigError);

    // A length whose milliseconds overflow the exact-integer range floors to
    // NaN bounds: a counter key that reads as corrupt and never expires.
    expect(() => validateWindow({ seconds: 1e308 }, 'r')).toThrow(InvalidConfigError);
    expect(() => validateWindow({ seconds: Number.MAX_SAFE_INTEGER }, 'r')).toThrow(
      InvalidConfigError,
    );
    expect(() => validateWindow({ seconds: 86_400 }, 'r')).not.toThrow();
  });
});

describe('retryAfterSeconds', () => {
  it('rounds up to the next whole second and never returns zero', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(retryAfterSeconds(now + 1_000, now)).toBe(1);
    expect(retryAfterSeconds(now + 1_001, now)).toBe(2);
    expect(retryAfterSeconds(now + 1, now)).toBe(1);
    expect(retryAfterSeconds(now, now)).toBe(1);
  });

  it('has nothing to report for a window that never resets', () => {
    expect(retryAfterSeconds(null, Date.now())).toBeNull();
  });
});
