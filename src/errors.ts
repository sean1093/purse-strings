/**
 * Every error this library throws is a `PurseStringsError` with a stable
 * `code`. Callers branch on the code, not on the class name or the message:
 * the class is lost across a structured clone or a JSON boundary, and the
 * message is prose that may be improved.
 */

/** The dimensions a rule can limit. Cost is always in integer micro-dollars. */
export type BudgetDimension = 'tokens' | 'costMicros' | 'requests';

/** The caps a single agent run keeps on itself, beside the guard's rules. */
export type RunLimit = 'steps' | 'toolCalls' | 'duration' | 'tokens' | 'costMicros';

export type PurseStringsErrorCode =
  /** A reservation would take a rule past one of its limits. */
  | 'BUDGET_EXCEEDED'
  /** A cost limit applies but the model has no price. */
  | 'UNKNOWN_MODEL'
  /** A rule's scope has no subject in this call, and the rule is required. */
  | 'MISSING_SUBJECT'
  /** The lease was already committed or released. */
  | 'LEASE_SETTLED'
  /** A run reached one of its own caps. */
  | 'RUN_LIMIT_EXCEEDED'
  /** The same tool was called with the same arguments too many times in one run. */
  | 'LOOP_DETECTED'
  /** The guard options are not usable. Thrown by `createGuard()`. */
  | 'INVALID_CONFIG'
  /** An argument to `reserve()` or `commit()` is not usable. */
  | 'INVALID_USAGE';

export class PurseStringsError extends Error {
  readonly code: PurseStringsErrorCode;

  constructor(code: PurseStringsErrorCode, message: string) {
    super(message);
    this.name = 'PurseStringsError';
    this.code = code;
  }
}

/**
 * A reservation was refused. Carries everything a caller needs to answer the
 * request: which rule and subject refused it, which dimension ran out, and
 * when it will be available again.
 */
export class BudgetExceededError extends PurseStringsError {
  readonly rule: string;
  readonly scope: string;
  readonly subject: string;
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly used: number;
  readonly requested: number;
  /** Epoch milliseconds when the window ends, or `null` for a `total` window. */
  readonly resetAt: number | null;
  /** Ready for a `Retry-After` header. `null` for a `total` window. */
  readonly retryAfterSeconds: number | null;

  constructor(details: {
    rule: string;
    scope: string;
    subject: string;
    dimension: BudgetDimension;
    limit: number;
    used: number;
    requested: number;
    resetAt: number | null;
    retryAfterSeconds: number | null;
  }) {
    super(
      'BUDGET_EXCEEDED',
      `rule '${details.rule}' (${details.scope}: ${details.subject}) is out of ${details.dimension}: ` +
        `${details.used} used plus ${details.requested} requested exceeds the limit of ${details.limit}`,
    );
    this.name = 'BudgetExceededError';
    this.rule = details.rule;
    this.scope = details.scope;
    this.subject = details.subject;
    this.dimension = details.dimension;
    this.limit = details.limit;
    this.used = details.used;
    this.requested = details.requested;
    this.resetAt = details.resetAt;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/**
 * A cost limit applies, so the call has to be priced, and it cannot be. An
 * unpriced model is an unbounded one, so this fails closed.
 */
export class UnknownModelError extends PurseStringsError {
  readonly model: string | null;

  constructor(model: string | null) {
    super(
      'UNKNOWN_MODEL',
      model === null
        ? 'a cost limit applies, so reserve() needs a model, and none was given'
        : `a cost limit applies and no price is configured for model '${model}'`,
    );
    this.name = 'UnknownModelError';
    this.model = model;
  }
}

/** A required rule's scope has no subject in this call. */
export class MissingSubjectError extends PurseStringsError {
  readonly rule: string;
  readonly scope: string;

  constructor(rule: string, scope: string) {
    super(
      'MISSING_SUBJECT',
      `rule '${rule}' is scoped to '${scope}' and no such subject was given. ` +
        `Pass subjects.${scope}, or mark the rule optional.`,
    );
    this.name = 'MissingSubjectError';
    this.rule = rule;
    this.scope = scope;
  }
}

/** A lease can be committed or released once. */
export class LeaseSettledError extends PurseStringsError {
  readonly settledAs: 'commit' | 'release';

  constructor(settledAs: 'commit' | 'release') {
    super(
      'LEASE_SETTLED',
      `this lease was already ${settledAs === 'commit' ? 'committed' : 'released'}`,
    );
    this.name = 'LeaseSettledError';
    this.settledAs = settledAs;
  }
}

/**
 * A run reached one of its own caps. Nothing is booked: the reservation that
 * would have crossed the cap is refused before the store sees it, so the
 * guard's counters are untouched.
 *
 * `actual` is what the run would have reached — elapsed milliseconds for
 * `duration`, otherwise the count or amount including the refused call.
 */
export class RunLimitExceededError extends PurseStringsError {
  readonly limit: RunLimit;
  readonly max: number;
  readonly actual: number;

  constructor(limit: RunLimit, max: number, actual: number) {
    super(
      'RUN_LIMIT_EXCEEDED',
      `this run is over its ${limit} limit: ${actual} exceeds the maximum of ${max}`,
    );
    this.name = 'RunLimitExceededError';
    this.limit = limit;
    this.max = max;
    this.actual = actual;
  }
}

/**
 * The same tool was called with the same arguments too many times in one run:
 * the signature of an agent that is not converging.
 *
 * `count` includes the refused call, which is not recorded. A caller that
 * retries it sees the same count rather than one that keeps climbing.
 */
export class LoopDetectedError extends PurseStringsError {
  readonly tool: string;
  readonly count: number;

  constructor(tool: string, count: number) {
    super(
      'LOOP_DETECTED',
      `tool '${tool}' was called ${count} times with the same arguments in this run`,
    );
    this.name = 'LoopDetectedError';
    this.tool = tool;
    this.count = count;
  }
}

/** The guard options are not usable. Thrown by `createGuard()`, before traffic. */
export class InvalidConfigError extends PurseStringsError {
  constructor(message: string) {
    super('INVALID_CONFIG', message);
    this.name = 'InvalidConfigError';
  }
}

/** An argument to a call is not usable. */
export class InvalidUsageError extends PurseStringsError {
  constructor(message: string) {
    super('INVALID_USAGE', message);
    this.name = 'InvalidUsageError';
  }
}
