import { InvalidConfigError } from './errors.js';
import type { WindowSpec } from './types.js';

/**
 * Fixed windows aligned to UTC.
 *
 * Minute, hour, day and custom-second windows are plain arithmetic on epoch
 * milliseconds: UTC has no offset changes, so flooring to a multiple of the
 * window length is exact. Weeks and months need the calendar, because their
 * length is not constant.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The epoch fell on a Thursday, so `(days + 4) % 7` is the UTC day of week. */
const EPOCH_DAY_OF_WEEK = 4;

/**
 * A window long enough that its millisecond length stops being an exact
 * integer is not a window: `{ seconds: 1e308 }` floors to `NaN` bounds and a
 * counter key that reads as corrupt. This is about 285,000 years, so nothing
 * usable is lost by refusing beyond it.
 */
const MAX_WINDOW_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

export interface WindowBounds {
  /** Epoch milliseconds at which the current window began. Part of the counter key. */
  readonly start: number;
  /** Epoch milliseconds at which it ends, or `null` for `total`. */
  readonly resetAt: number | null;
}

/** Throws `InvalidConfigError` if the spec cannot be used. Call once, at construction. */
export function validateWindow(spec: WindowSpec, ruleId: string): void {
  if (typeof spec === 'string') {
    if (
      spec !== 'minute' &&
      spec !== 'hour' &&
      spec !== 'day' &&
      spec !== 'week' &&
      spec !== 'month' &&
      spec !== 'total'
    ) {
      throw new InvalidConfigError(
        `rule '${ruleId}' has an unknown window '${spec}'. Use minute, hour, day, week, month, total, or { seconds }.`,
      );
    }
    return;
  }

  if (
    spec === null ||
    typeof spec !== 'object' ||
    !Number.isSafeInteger(spec.seconds) ||
    spec.seconds <= 0 ||
    spec.seconds > MAX_WINDOW_SECONDS
  ) {
    throw new InvalidConfigError(
      `rule '${ruleId}' has a custom window whose 'seconds' is not a positive integer ` +
        `of at most ${MAX_WINDOW_SECONDS}`,
    );
  }
}

export function windowAt(spec: WindowSpec, now: number): WindowBounds {
  if (typeof spec !== 'string') {
    const length = spec.seconds * 1000;
    const start = Math.floor(now / length) * length;
    return { start, resetAt: start + length };
  }

  switch (spec) {
    case 'minute':
      return fixed(now, MINUTE);
    case 'hour':
      return fixed(now, HOUR);
    case 'day':
      return fixed(now, DAY);
    case 'week': {
      const days = Math.floor(now / DAY);
      // ISO weeks start on Monday; `(dayOfWeek + 6) % 7` is days since Monday.
      const sinceMonday = (((days + EPOCH_DAY_OF_WEEK) % 7) + 6) % 7;
      const start = (days - sinceMonday) * DAY;
      return { start, resetAt: start + 7 * DAY };
    }
    case 'month': {
      const date = new Date(now);
      const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
      // Month 12 of a year is January of the next, which Date.UTC normalises.
      const resetAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      return { start, resetAt };
    }
    default:
      return { start: 0, resetAt: null };
  }
}

function fixed(now: number, length: number): WindowBounds {
  const start = Math.floor(now / length) * length;
  return { start, resetAt: start + length };
}

/** Whole seconds until the window ends, at least 1. `null` for `total`. */
export function retryAfterSeconds(resetAt: number | null, now: number): number | null {
  if (resetAt === null) return null;
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}
