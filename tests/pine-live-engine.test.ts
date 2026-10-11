import { describe, expect, it } from 'vitest';

import { runPineLive } from '../packages/pine-runtime/src/live-engine.js';

const H = 3_600_000;
const t0 = Date.UTC(2026, 9, 1);
const candles = Array.from({ length: 50 }, (_, i) => {
  const open = 100 + Math.sin(i / 3) * 5;
  const close = 100 + Math.sin((i + 1) / 3) * 5;
  return { openTime: t0 + i * H, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1,
    closeTime: t0 + (i + 1) * H - 1, quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0, ignore: 0 };
});
const source = `//@version=5
strategy("t", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=10)
if bar_index % 6 == 0
    strategy.entry("L", strategy.long)
if bar_index % 6 == 3
    strategy.entry("S", strategy.short)
strategy.exit("XL", "L", profit=300, loss=200)
`;
const market = { tickerId: 'LIGHTER:BTCUSDC.P', symbol: 'BTC', exchange: 'Lighter' as const, quoteCurrency: 'USDC' as const,
  mintick: 0.01, minContract: 0.001, pineTimeframe: '60' };
const execution = { initialCapital: 10_000, defaultOrderSizeValue: 10, defaultOrderSizeType: 'percent_of_equity' as const,
  pyramiding: 1, commissionType: 'percent' as const, commissionValue: 0.04 };
const startMs = t0 + 42 * H;
const entryTime = t0 + 43 * H + 300_000;
const entry = { orderId: 'L', category: 'entry' as const, price: 104, time: entryTime };

describe('Pine live engine', () => {
  it('keeps history state, ignores the emulator after start and exports Pine orders with fill plans', async () => {
    const result = await runPineLive({ source, market, execution, candles: candles.slice(0, 43), startMs, fills: [] });
    expect(result.trades).toEqual([expect.objectContaining({ entryId: 'S', side: 'short', beforeStart: true })]);
    const long = result.orders.find(order => order.id === 'L')!;
    expect(long.plan).toMatchObject({ accepted: true, opensSide: 'long', closes: [{ tradeKey: result.trades[0]!.key }] });
    // Without fills, a live bar does not move Pine: the market order stays pending.
    const next = await runPineLive({ source, market, execution, candles: candles.slice(0, 44), startMs, fills: [] });
    expect(next.orders.some(order => order.id === 'L')).toBe(true);
    expect(next.trades.map(trade => trade.entryId)).toEqual(['S']);
  });

  it('books a real fill at its price and time and keeps a partially filled exit working', async () => {
    const opened = await runPineLive({ source, market, execution, candles: candles.slice(0, 44), startMs, fills: [entry] });
    const trade = opened.trades.find(row => row.entryId === 'L')!;
    expect(trade).toMatchObject({ key: `L@${entryTime}`, entryPrice: 104, beforeStart: false });
    expect(opened.orders.find(order => order.id === 'XL')!.tradeKeys).toEqual([trade.key]);
    const partial = { orderId: 'XL', category: 'exit' as const, price: 101.9, time: t0 + 44 * H + 600_000, leg: 'loss' as const,
      tradeKey: trade.key, qty: 4 };
    const after = await runPineLive({ source, market, execution, candles: candles.slice(0, 46), startMs, fills: [entry, partial] });
    expect(after.fillOutcomes.every(outcome => outcome.applied)).toBe(true);
    expect(after.trades.find(row => row.key === trade.key)!.qty).toBeCloseTo(trade.qty - 4, 9);
    expect(after.orders.find(order => order.id === 'XL')!.tradeKeys).toEqual([trade.key]);
  });
});
