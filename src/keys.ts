import { InvalidConfigError, InvalidUsageError } from './errors.js';

/**
 * Counter keys.
 *
 * One key is a Firestore document id, a Workers KV key and a Durable Object
 * name at the same time, and part of it is attacker-influenced: a subject is
 * whatever your authenticated session resolves to. Without encoding, a
 * subject containing `/` would create a Firestore subcollection path, and one
 * containing `:` would let two different subjects share a counter.
 */

/** Also the set of characters that survive `encodeURIComponent` unchanged. */
const RULE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The counter key of a rule whose scope is `'global'`. */
export const GLOBAL_SUBJECT = 'global';

/**
 * Firestore allows 1500 bytes per document id and Workers KV allows 512 per
 * key, so 512 is the limit everywhere. A key is `<=66` bytes of rule id,
 * separators and window start, which leaves the subject the rest.
 */
const MAX_KEY_BYTES = 512;

/** Before encoding. A real user, session or tenant id is far below this. */
const MAX_SUBJECT_LENGTH = 200;

const utf8 = new TextEncoder();

export function validateRuleId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !RULE_ID.test(id)) {
    throw new InvalidConfigError(
      `rule id ${JSON.stringify(id)} is not usable as part of a counter key. ` +
        'Use 1 to 64 characters from A-Z, a-z, 0-9, underscore and hyphen.',
    );
  }
}

/**
 * `<ruleId>:<encodeURIComponent(subject)>:<windowStart>`.
 *
 * Throws rather than truncating an over-long subject: two subjects that
 * truncate to the same prefix would share a budget.
 */
export function counterKey(ruleId: string, subject: string, windowStart: number): string {
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new InvalidUsageError(
      `subject for rule '${ruleId}' is ${subject.length} characters, over the limit of ${MAX_SUBJECT_LENGTH}`,
    );
  }

  const key = `${ruleId}:${encodeURIComponent(subject)}:${windowStart}`;
  const bytes = utf8.encode(key).length;

  if (bytes > MAX_KEY_BYTES) {
    throw new InvalidUsageError(
      `the counter key for rule '${ruleId}' is ${bytes} bytes once encoded, over the limit of ${MAX_KEY_BYTES}`,
    );
  }

  return key;
}
