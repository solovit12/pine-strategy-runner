import { describe, expect, it } from 'vitest';

import { backtestSettingsSupportedByEditor } from '../apps/web/src/lib/strategy-editor-compat';
import { normalizedBacktestSettings } from '../packages/shared/src/strategy-catalog-contracts';

const source = '//@version=6\nstrategy("test")\n';
const settings = normalizedBacktestSettings({
  exchange: 'Binance', marketType: 'Perpetual', symbol: 'HYPEUSDT', timeframe: '1m',
  dateRange: { start: '2026-09-10', end: '2026-09-23' },
  initialCapital: 5000, baseCurrency: 'USDT', defaultOrderSizeValue: 10,
  defaultOrderSizeType: 'percent_of_equity', pyramiding: 1, feeModel: 'manual',
  commissionType: 'percent', commissionValue: 0, slippagePercent: 0,
  barDetailization: 'default',
}, source);

describe('saved backtest settings in the editor', () => {
  it('loads the HYPEUSDT historical proxy settings without altering their meaning', () => {
    expect(backtestSettingsSupportedByEditor(settings)).toBe(true);
  });

  it('refuses API strategies whose venue or hidden fields the UI would silently change', () => {
    expect(backtestSettingsSupportedByEditor({ ...settings, exchange: 'Hyperliquid', baseCurrency: 'USDC' })).toBe(false);
    expect(backtestSettingsSupportedByEditor({ ...settings, barIndexOffset: 5 })).toBe(false);
    expect(backtestSettingsSupportedByEditor({ ...settings, timeframe: '1w', barDetailization: 'high' })).toBe(false);
  });
});
