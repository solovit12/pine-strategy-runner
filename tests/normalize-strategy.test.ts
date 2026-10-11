import { describe, expect, it } from 'vitest';

import { normalizeStrategy } from '../packages/pine-runtime/src/normalize.js';

describe('normalizeStrategy commission totals', () => {
  it('includes a commission already paid by a still-open position', () => {
    const normalized = normalizeStrategy({
      config: { initial_capital: 100_000 },
      closedtrades: [],
      opentrades: [{
        entry_id: 'OPEN',
        entry_price: 100,
        entry_bar_index: 1,
        entry_time: 1_000,
        size: 10,
        commission: 0.45,
      }],
      netprofit: -0.45,
      grossprofit: 0,
      grossloss: 0.45,
      max_drawdown: 0.45,
      openprofit: 10,
      equity: 100_009.55,
      position_size: 10,
      wintrades: 0,
    });

    expect(normalized.metrics.commissionPaid).toBe(0.45);
    expect(normalized.metrics.netProfit).toBe(-0.45);
  });
});
