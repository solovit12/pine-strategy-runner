import { describe, expect, it } from 'vitest';
import {
  aggregateCandles,
  assertCompleteSeries,
  isChartSymbol,
  pineTimeframeMs,
  seriesSourcePlan,
  seriesWindow,
} from '../packages/pine-runtime/src/series-requests';
import type { Candle } from '../packages/shared/src/contracts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hour = (openTime: number, price: number): Candle => ({
  openTime, open: price, high: price + 1, low: price - 1, close: price + 0.5, volume: 2, closeTime: openTime + HOUR - 1,
  quoteAssetVolume: 1, numberOfTrades: 1, takerBuyBaseAssetVolume: 1, takerBuyQuoteAssetVolume: 1, ignore: 0,
});

describe('request.security series requests', () => {
  it('reads Pine timeframes that tile a UTC day, days and weeks', () => {
    expect(pineTimeframeMs('240')).toBe(4 * HOUR);
    expect(pineTimeframeMs('45')).toBe(45 * 60_000);
    expect(pineTimeframeMs('D')).toBe(DAY);
    expect(pineTimeframeMs('1W')).toBe(7 * DAY);
    expect(pineTimeframeMs('7')).toBeNull(); // does not tile a day
    expect(pineTimeframeMs('M')).toBeNull();
    expect(pineTimeframeMs('3D')).toBeNull();
  });

  it('treats the exchange prefix, perpetual suffix and empty symbol as the chart symbol', () => {
    expect(isChartSymbol('BINANCE:BTCUSDT.P', 'BTCUSDT')).toBe(true);
    expect(isChartSymbol('btcusdt', 'BTCUSDT')).toBe(true);
    expect(isChartSymbol('', 'BTCUSDT')).toBe(true);
    expect(isChartSymbol('BINANCE:ETHUSDT', 'BTCUSDT')).toBe(false);
  });

  it('loads exchange candles directly or joins smaller ones', () => {
    expect(seriesSourcePlan(4 * HOUR)).toEqual({ interval: '4h', factor: 1 });
    expect(seriesSourcePlan(2 * HOUR)).toEqual({ interval: '1h', factor: 2 });
    expect(seriesSourcePlan(45 * 60_000)).toEqual({ interval: '15m', factor: 3 });
  });

  it('asks only for whole bars closed by the chart end, aligned to Monday for weeks', () => {
    const end = Date.parse('2026-09-10T13:00:00Z');
    expect(seriesWindow({ timeframe: '240', timeframeMs: 4 * HOUR, endExclusive: end, limit: 3 }))
      .toEqual({ startInclusive: Date.parse('2026-09-10T00:00:00Z'), endExclusive: Date.parse('2026-09-10T12:00:00Z') });
    expect(seriesWindow({ timeframe: 'W', timeframeMs: 7 * DAY, startInclusive: Date.parse('2026-09-02T00:00:00Z'), endExclusive: end }))
      .toEqual({ startInclusive: Date.parse('2026-08-31T00:00:00Z'), endExclusive: Date.parse('2026-09-07T00:00:00Z') });
  });

  it('joins candles and stops on a missing one instead of filling it', () => {
    const start = Date.parse('2026-09-01T00:00:00Z');
    const joined = aggregateCandles([hour(start, 10), hour(start + HOUR, 20)], 2 * HOUR, 2);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ open: 10, high: 21, low: 9, close: 20.5, volume: 4, closeTime: start + 2 * HOUR - 1 });
    expect(() => aggregateCandles([hour(start, 10)], 2 * HOUR, 2)).toThrow(/missing/);
    expect(() => assertCompleteSeries(joined, { startInclusive: start, endExclusive: start + 4 * HOUR }, 2 * HOUR)).toThrow(/1 missing bars/);
  });
});
