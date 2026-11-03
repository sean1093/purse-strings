/**
 * Per-run limits.
 *
 * Budget rules bound spending per subject per window. They do not bound one
 * agent run, and a stuck agent is the most expensive common failure: a correct
 * program, authenticated as a legitimate user, calling the model as fast as it
 * can until the daily budget is gone. These limits stop that in seconds
 * instead of at the end of the day.
 *
 * A run lives in one process. That is deliberate: the limits that matter for a
 * loop — repetition and wall clock — are only meaningful within one logical
 * execution, and making them shared state would add a round trip to every
 * step in exchange for a guarantee nobody asked for.
 */

import { usdToMicros } from './cost.js';
import {
  InvalidConfigError,
  InvalidUsageError,
  LoopDetectedError,
  RunLimitExceededError,
} from './errors.js';
import type { Lease, ReserveOptions } from './guard.js';
import type { Counter } from './types.js';

/** How deep a tool argument is walked before the rest is summarised. */
const MAX_ARGUMENT_DEPTH = 24;

/** How long a tool-call signature may get. Arguments come from the model. */
const MAX_SIGNATURE_LENGTH = 4096;

/** A token and cost budget for one run, on top of the guard's rules. */
export interface RunLimits {
  readonly tokens?: number;
  /** US dollars, as `RuleLimits.costUsd` is. */
  readonly costUsd?: number;
}

export interface RunOptions {
  /** Subjects for every reservation in this run. A call may add to or override them. */
  readonly subjects?: Readonly<Record<string, string>>;
  /** Model for every reservation in this run. A call may override it. */
  readonly model?: string;
  /** Model calls. */
  readonly maxSteps?: number;
  /** Tool invocations. */
  readonly maxToolCalls?: number;
  /** The same tool with the same arguments, compared independently of key order. */
  readonly maxIdenticalToolCalls?: number;
  /** Wall clock, from `startRun()`. Also aborts `signal`. */
  readonly maxDurationMs?: number;
  /** A token and cost budget for this run alone, on top of the guard's rules. */
  readonly limits?: RunLimits;
}

export interface Run {
  /** Aborts at the deadline and on `end()`, so in-flight calls can be cancelled. */
  readonly signal: AbortSignal;
  /** Model calls booked so far. */
  readonly steps: number;
  /** Tool calls recorded so far. */
  readonly toolCalls: number;
  /** Tokens this run has booked, after settlement. */
  readonly tokens: number;
  /** Micro-dollars this run has booked, after settlement. */
  readonly costMicros: number;
  readonly startedAt: number;
  /** Epoch milliseconds the deadline falls at, or `null` without one. */
  readonly endsAt: number | null;
  /** Reserve for one model call. Counts one step. */
  reserve(options?: ReserveOptions): Promise<Lease>;
  /** Count one tool invocation and check it against the repetition limit. */
  recordToolCall(tool: string, args?: unknown): void;
  /** Finish the run and abort `signal`. Doing it twice is harmless. */
  end(): void;
}

/**
 * How a run joins one reservation. The guard calls `precheck()` with what the
 * reservation would book, before the store sees it, and `settle()` with every
 * delta the resulting lease later books.
 */
export interface RunHooks {
  /** A run with a cost limit has to be priced even when no rule limits cost. */
  readonly requireCost: boolean;
  precheck(reserved: Readonly<Counter>): void;
  settle(delta: Readonly<Counter>): void;
}

/** What a run needs from the guard. Keeps the runtime dependency one-way. */
export interface RunHost {
  now(): number;
  reserveInRun(options: ReserveOptions, hooks: RunHooks): Promise<Lease>;
}

type MutableReserveOptions = { -readonly [K in keyof ReserveOptions]: ReserveOptions[K] };

export function startRun(host: RunHost, options: RunOptions): Run {
  return new AgentRun(host, options);
}

class AgentRun implements Run {
  readonly startedAt: number;
  readonly endsAt: number | null;

  readonly #host: RunHost;
  readonly #subjects: Readonly<Record<string, string>> | undefined;
  readonly #model: string | undefined;
  readonly #maxSteps: number | null;
  readonly #maxToolCalls: number | null;
  readonly #maxIdentical: number | null;
  readonly #maxTokens: number | null;
  readonly #maxCostMicros: number | null;
  readonly #duration: number | null;
  readonly #controller = new AbortController();
  /** Only populated when a repetition limit is configured. */
  readonly #identical = new Map<string, number>();
  /**
   * Cancels the deadline timer, or `null` when there is no deadline or it has
   * already been cancelled. A closure rather than the handle itself: that
   * handle is a `Timeout` object on Node and a number everywhere else, and
   * this file has no reason to name either.
   */
  #cancelTimer: (() => void) | null = null;
  #steps = 0;
  #toolCalls = 0;
  #tokens = 0;
  #costMicros = 0;
  #finished: 'ended' | 'expired' | null = null;

  constructor(host: RunHost, options: RunOptions) {
    this.#host = host;
    this.#subjects = options.subjects;
    this.#model = options.model;
    this.startedAt = host.now();

    this.#maxSteps = positive(options.maxSteps, 'maxSteps', true);
    this.#maxToolCalls = positive(options.maxToolCalls, 'maxToolCalls', true);
    this.#maxIdentical = positive(options.maxIdenticalToolCalls, 'maxIdenticalToolCalls', true);
    this.#maxTokens = positive(options.limits?.tokens, 'limits.tokens', true);
    const costUsd = positive(options.limits?.costUsd, 'limits.costUsd', false);
    this.#maxCostMicros = costUsd === null ? null : usdToMicros(costUsd);

    this.#duration = positive(options.maxDurationMs, 'maxDurationMs', true);
    this.endsAt = this.#duration === null ? null : this.startedAt + this.#duration;

    if (this.#duration !== null) {
      const timer = setTimeout(() => this.#expire(), this.#duration);
      // Node keeps the process alive for a pending timer. A budget deadline
      // must not be the reason a script does not exit; other runtimes have no
      // unref() and need none.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.#cancelTimer = () => clearTimeout(timer);
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get steps(): number {
    return this.#steps;
  }

  get toolCalls(): number {
    return this.#toolCalls;
  }

  get tokens(): number {
    return this.#tokens;
  }

  get costMicros(): number {
    return this.#costMicros;
  }

  async reserve(options: ReserveOptions = {}): Promise<Lease> {
    this.#checkAlive();

    if (this.#maxSteps !== null && this.#steps + 1 > this.#maxSteps) {
      throw new RunLimitExceededError('steps', this.#maxSteps, this.#steps + 1);
    }

    const lease = await this.#host.reserveInRun(this.#merge(options), {
      requireCost: this.#maxCostMicros !== null,
      precheck: (reserved) => this.#checkBudget(reserved),
      settle: (delta) => {
        this.#tokens += delta.tokens;
        this.#costMicros += delta.costMicros;
      },
    });

    this.#steps += 1;
    this.#tokens += lease.reserved.tokens;
    this.#costMicros += lease.reserved.costMicros;
    return lease;
  }

  recordToolCall(tool: string, args?: unknown): void {
    this.#checkAlive();

    if (typeof tool !== 'string' || tool === '') {
      throw new InvalidUsageError('recordToolCall() needs a non-empty tool name');
    }

    const next = this.#toolCalls + 1;
    if (this.#maxToolCalls !== null && next > this.#maxToolCalls) {
      throw new RunLimitExceededError('toolCalls', this.#maxToolCalls, next);
    }

    if (this.#maxIdentical !== null) {
      const signature = signatureOf(tool, args);
      const seen = (this.#identical.get(signature) ?? 0) + 1;
      // Refused, so it is not recorded: a caller that retries the same call
      // keeps getting the same count rather than an ever-growing one.
      if (seen > this.#maxIdentical) throw new LoopDetectedError(tool, seen);
      this.#identical.set(signature, seen);
    }

    this.#toolCalls = next;
  }

  end(): void {
    if (this.#finished === null) this.#finished = 'ended';
    this.#stopTimer();
    if (!this.#controller.signal.aborted) this.#controller.abort();
  }

  /**
   * The clock is the check and the timer is only the backstop. A run that
   * never yields to the event loop between steps would otherwise sail past
   * its deadline, and under fake timers nothing would fire at all.
   */
  #checkAlive(): void {
    if (this.#finished === null && this.endsAt !== null && this.#host.now() >= this.endsAt) {
      this.#expire();
    }

    if (this.#finished === 'expired') {
      throw new RunLimitExceededError(
        'duration',
        this.#duration ?? 0,
        this.#host.now() - this.startedAt,
      );
    }
    if (this.#finished === 'ended') {
      throw new InvalidUsageError('this run has ended');
    }
  }

  #checkBudget(reserved: Readonly<Counter>): void {
    const tokens = this.#tokens + reserved.tokens;
    if (this.#maxTokens !== null && tokens > this.#maxTokens) {
      throw new RunLimitExceededError('tokens', this.#maxTokens, tokens);
    }

    const costMicros = this.#costMicros + reserved.costMicros;
    if (this.#maxCostMicros !== null && costMicros > this.#maxCostMicros) {
      throw new RunLimitExceededError('costMicros', this.#maxCostMicros, costMicros);
    }
  }

  #expire(): void {
    if (this.#finished !== null) return;
    this.#finished = 'expired';
    this.#stopTimer();
    this.#controller.abort(
      new RunLimitExceededError('duration', this.#duration ?? 0, this.#host.now() - this.startedAt),
    );
  }

  #stopTimer(): void {
    if (this.#cancelTimer === null) return;
    this.#cancelTimer();
    this.#cancelTimer = null;
  }

  /** Call options win over run options; subjects merge rather than replace. */
  #merge(options: ReserveOptions): ReserveOptions {
    const merged: MutableReserveOptions = { ...options };

    if (this.#subjects !== undefined) {
      merged.subjects =
        options.subjects === undefined
          ? this.#subjects
          : { ...this.#subjects, ...options.subjects };
    }
    if (options.model === undefined && this.#model !== undefined) {
      merged.model = this.#model;
    }

    return merged;
  }
}

function positive(value: number | undefined, name: string, integer: boolean): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidConfigError(`${name} must be a positive finite number, got ${String(value)}`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new InvalidConfigError(`${name} must be an integer, got ${String(value)}`);
  }
  return value;
}

/**
 * A tool call's identity: its name and its arguments, compared as JSON-shaped
 * data, independently of key order.
 *
 * Arguments come from the model, so the walk is bounded in depth and the
 * result in length. A truncated signature carries the untruncated length,
 * which keeps two long but different argument sets from colliding on the
 * shared prefix alone — and a collision would refuse a call, never allow one.
 */
function signatureOf(tool: string, args: unknown): string {
  const body = canonical(args, 0);
  const bounded =
    body.length <= MAX_SIGNATURE_LENGTH
      ? body
      : `${body.slice(0, MAX_SIGNATURE_LENGTH)}#${body.length}`;

  return `${tool}\u0000${bounded}`;
}

function canonical(value: unknown, depth: number): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return `${value}n`;
    case 'undefined':
      return 'undefined';
    case 'object':
      break;
    default:
      return `[${typeof value}]`;
  }

  // Deep nesting is where a recursive walk becomes a stack overflow, and a
  // cycle is where it becomes an infinite one. Both stop here.
  if (depth >= MAX_ARGUMENT_DEPTH) return '[deep]';

  if (Array.isArray(value)) {
    let out = '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out += ',';
      out += canonical(value[index], depth + 1);
    }
    return `${out}]`;
  }

  const keys = Object.keys(value as object).sort();
  let out = '{';
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    if (index > 0) out += ',';
    out += `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`;
  }
  return `${out}}`;
}
