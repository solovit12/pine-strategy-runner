import type { BacktestResponse } from '../../../../packages/shared/src/contracts';

export type BacktestResultEvent =
  | { type: 'run-started' }
  | { type: 'run-succeeded'; result: BacktestResponse }
  | { type: 'run-failed-or-stopped' };

/**
 * A failed or stopped run must never leave metrics, trades or chart data from
 * an older successful run on screen.
 */
export function backtestResultAfter(
  _current: BacktestResponse | null,
  event: BacktestResultEvent,
): BacktestResponse | null {
  return event.type === 'run-succeeded' ? event.result : null;
}
