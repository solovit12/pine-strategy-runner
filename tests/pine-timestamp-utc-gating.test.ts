import { describe, expect, it } from 'vitest';

import { runPineWorker } from '../apps/api/src/worker-client.js';
import type { Candle } from '../packages/shared/src/contracts.js';

const MINUTE_MS = 60_000;
const FIRST_BAR = Date.parse('2026-08-21T23:58:00.000Z');
const LAST_BAR_EXCLUSIVE = Date.parse('2026-08-23T00:03:00.000Z');

function candle(openTime: number, index: number): Candle {
  const open = 100 + index / 1_000;
  return {
    openTime,
    open,
    high: open + 0.1,
    low: open - 0.1,
    close: open + 0.01,
    volume: 1,
    closeTime: openTime + MINUTE_MS - 1,
    quoteAssetVolume: open,
    numberOfTrades: 1,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

describe('Pine timestamp UTC date gating', () => {
  it('interprets timestamp("UTC", 2026, 8, 22, 0, 0) exactly and gates orders by time', async () => {
    const candles = Array.from(
      { length: (LAST_BAR_EXCLUSIVE - FIRST_BAR) / MINUTE_MS },
      (_, index) => candle(FIRST_BAR + index * MINUTE_MS, index),
    );
    const source = `//@version=5
strategy("timestamp UTC gating", overlay=true)
int START_TIME = timestamp("UTC", 2026, 8, 22, 0, 0)
int END_TIME = timestamp("UTC", 2026, 8, 23, 0, 0)
bool inWindow = time >= START_TIME and time < END_TIME
var bool submitted = false
if inWindow and not submitted
    strategy.entry("Long", strategy.long)
    submitted := true
if time >= END_TIME and strategy.position_size != 0
    strategy.close_all()
`;

    const result = await runPineWorker({
      source,
      candles,
      barIndexOffset: 0,
      market: {
        tickerId: 'BINANCE:BTCUSDT.P',
        symbol: 'BTCUSDT',
        exchange: 'Binance',
        quoteCurrency: 'USDT',
        timeframe: '1m',
        pineTimeframe: '1',
        mintick: 0.1,
        minContract: 0.001,
      },
      execution: {
        initialCapital: 10_000,
        defaultOrderSizeValue: 1,
        defaultOrderSizeType: 'fixed',
        pyramiding: 1,
        commissionType: 'percent',
        commissionValue: 0,
        slippageTicks: 0,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      entryTime: '2026-08-22T00:01:00.000Z',
      exitTime: '2026-08-23T00:01:00.000Z',
      entrySignal: 'Long',
      exitSignal: 'Close position order', // TradingView's name for strategy.close_all
    });
  });
});
