import { describe, expect, it } from 'vitest';
import { applyBarIndexOffset, toPineSessionCandles } from '../packages/pine-runtime/src/bar-index-origin';
import type { Candle } from '../packages/shared/src/contracts';

const first: Candle = {
  openTime: Date.parse('2017-08-17T04:00:00.000Z'),
  open: 4261.48, high: 4485.39, low: 4200.74, close: 4285.08, volume: 795.15,
  closeTime: Date.parse('2017-08-17T04:59:59.999Z'), quoteAssetVolume: 0,
  numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0,
};

describe('bar-index origin compatibility', () => {
  it('does not alter ordinary data when the offset is zero', () => {
    const data = [first];
    expect(applyBarIndexOffset(data, 0)).toBe(data);
  });

  it('prepends disclosed zero-volume context bars', () => {
    const result = applyBarIndexOffset([first], 12);
    expect(result).toHaveLength(13);
    expect(result[0]!.openTime).toBe(Date.parse('2017-08-16T16:00:00.000Z'));
    expect(result[11]!.openTime).toBe(Date.parse('2017-08-17T03:00:00.000Z'));
    expect(result[12]).toEqual(first);
    expect(result.slice(0, 12).every((candle) => candle.volume === 0)).toBe(true);
  });

  it('uses the selected market timeframe instead of assuming one hour', () => {
    const result = applyBarIndexOffset([first], 2, 5 * 60_000);
    expect(result[0]!.openTime).toBe(first.openTime - 10 * 60_000);
    expect(result[1]!.openTime).toBe(first.openTime - 5 * 60_000);
    expect(result[1]!.closeTime).toBe(first.openTime - 1);
  });

  it('exposes Pine time_close at the next session boundary, not one millisecond early', () => {
    const [result] = toPineSessionCandles([first]);
    expect(result!.closeTime).toBe(Date.parse('2017-08-17T05:00:00.000Z'));
    expect(first.closeTime).toBe(Date.parse('2017-08-17T04:59:59.999Z'));
  });
});
