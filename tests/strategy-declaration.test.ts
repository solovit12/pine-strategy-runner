import { describe, expect, it } from 'vitest';
import { changedDeclarationProperties, strategyDeclarationProperties } from '../apps/web/src/strategy-declaration';

describe('Strategy Properties from the Pine strategy() declaration', () => {
  it('reads literal properties across continuation lines, strings and comments', () => {
    expect(strategyDeclarationProperties(`//@version=5
strategy("Supertrend, intraday (15m)", overlay=true, // a comment, with commas
     default_qty_type=strategy.percent_of_equity, default_qty_value=10,
     initial_capital=10000, pyramiding=1, commission_value=0.045)
plot(close)`)).toEqual({
      initialCapital: 10_000, defaultOrderSizeType: 'percent_of_equity', defaultOrderSizeValue: 10,
      pyramiding: 1, commissionPercent: 0.045,
    });
  });

  it('ignores computed values, non-percent commission, unfinished calls and code without strategy()', () => {
    expect(strategyDeclarationProperties('strategy("A", initial_capital=1000 * 2, default_qty_type=strategy.cash, default_qty_value=input(5))'))
      .toEqual({ defaultOrderSizeType: 'cash' });
    expect(strategyDeclarationProperties('strategy("A", commission_type=strategy.commission.cash_per_order, commission_value=2)'))
      .toEqual({});
    expect(strategyDeclarationProperties('strategy("A", commission_type=strategy.commission.percent, commission_value=0.1)'))
      .toEqual({ commissionPercent: 0.1 });
    expect(strategyDeclarationProperties('strategy("A", default_qty_value=')).toEqual({});
    expect(strategyDeclarationProperties('indicator("A")\nplot(close)')).toEqual({});
    expect(strategyDeclarationProperties('x = my_strategy(1)\nstrategy.entry("L", strategy.long)')).toEqual({});
  });

  it('reports only declarations that changed, so other form edits survive', () => {
    const before = strategyDeclarationProperties('strategy("A", initial_capital=100000, default_qty_type=strategy.fixed, default_qty_value=0.01)');
    const after = strategyDeclarationProperties('strategy("B", default_qty_type=strategy.percent_of_equity, default_qty_value=10)');
    expect(changedDeclarationProperties(before, after)).toEqual({ defaultOrderSizeType: 'percent_of_equity', defaultOrderSizeValue: 10 });
    expect(changedDeclarationProperties(after, after)).toEqual({});
  });
});
