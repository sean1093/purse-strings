/**
 * purse-strings — a denial-of-wallet guard for apps that call LLM APIs.
 *
 * ```ts
 * import { createGuard, MemoryStore } from 'purse-strings';
 *
 * const guard = createGuard({
 *   store: new MemoryStore(),
 *   rules: [{ id: 'user-daily', scope: 'user', window: 'day', limits: { costUsd: 1 } }],
 *   pricing: { 'gpt-4.1': { input: 2, output: 8 } },
 * });
 *
 * const lease = await guard.reserve({
 *   subjects: { user: userId },
 *   model: 'gpt-4.1',
 *   inputTokens: 1_200,
 *   maxOutputTokens: 800,
 * });
 * try {
 *   const response = await callTheModel();
 *   await lease.commit({ inputTokens: 1_150, outputTokens: 640 });
 * } catch (error) {
 *   await lease.release();
 *   throw error;
 * }
 * ```
 *
 * @packageDocumentation
 */

export {
  type BudgetDimension,
  BudgetExceededError,
  InvalidConfigError,
  InvalidUsageError,
  LeaseSettledError,
  LoopDetectedError,
  MissingSubjectError,
  PurseStringsError,
  type PurseStringsErrorCode,
  type RunLimit,
  RunLimitExceededError,
  UnknownModelError,
} from './errors.js';
export {
  type CommitUsage,
  createGuard,
  type Guard,
  type GuardOptions,
  type Lease,
  type ReserveOptions,
  type RuleUsage,
  type UsageDimension,
  type UsageOptions,
} from './guard.js';
export type { Run, RunLimits, RunOptions } from './run.js';
export { MemoryStore, type MemoryStoreOptions } from './stores/memory.js';
export type {
  BudgetRule,
  BudgetStore,
  ConsumeResult,
  Counter,
  CounterUpdate,
  ModelPricing,
  PricingTable,
  RuleLimits,
  TokenUsage,
  WindowSpec,
} from './types.js';
