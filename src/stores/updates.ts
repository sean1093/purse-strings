import { InvalidUsageError } from '../errors.js';
import type { CounterUpdate } from '../types.js';

/**
 * Every limit check in a store is a `>` comparison, and a comparison against
 * `NaN` is false. A batch carrying a non-finite delta would therefore be
 * admitted whatever the limits say, and the counter it lands in would become
 * `NaN` -- after which every later check on that key passes too, so the rule
 * stops limiting that dimension for the rest of the window.
 *
 * One corrupt number is not worth a dead counter, so a store refuses the
 * batch instead. The guard never produces one; an adapter is the boundary
 * where a caller's own code could.
 */
export function assertFiniteUpdates(updates: readonly CounterUpdate[]): void {
  for (const update of updates) {
    const { delta } = update;
    if (
      !Number.isFinite(delta.tokens) ||
      !Number.isFinite(delta.costMicros) ||
      !Number.isFinite(delta.requests)
    ) {
      throw new InvalidUsageError(
        `the delta for counter '${update.key}' is not finite: ` +
          `tokens ${String(delta.tokens)}, costMicros ${String(delta.costMicros)}, requests ${String(delta.requests)}`,
      );
    }
  }
}
