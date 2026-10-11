import { describe, expect, it } from 'vitest';
import { tradingViewStrategyDefaults } from '../packages/pine-runtime/src/tradingview-defaults';

describe('TradingView strategy defaults', () => {
  it('restores the Pine v5 unlimited-leverage defaults when margins are omitted', () => {
    expect(tradingViewStrategyDefaults(`//@version=5\nstrategy('Legacy', overlay=true)`)).toEqual({
      pineVersion: 5,
      marginLongPercent: 0,
      marginShortPercent: 0,
      legacyMarginDefaultsApplied: true,
    });
  });

  it('preserves explicit margins and ignores property names in comments or strings', () => {
    expect(tradingViewStrategyDefaults(`
      //@version=5
      // margin_short=0
      strategy('margin_long=0', margin_long=25, margin_short=50)
    `)).toEqual({
      pineVersion: 5,
      marginLongPercent: undefined,
      marginShortPercent: undefined,
      legacyMarginDefaultsApplied: false,
    });
  });

  it('keeps Pine v6 defaults in PineTS', () => {
    expect(tradingViewStrategyDefaults(`//@version=6\nstrategy('Current')`)).toEqual({
      pineVersion: 6,
      marginLongPercent: undefined,
      marginShortPercent: undefined,
      legacyMarginDefaultsApplied: false,
    });
  });
});
