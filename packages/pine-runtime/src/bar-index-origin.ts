import type { Candle } from '../../shared/src/contracts.js';

export function applyBarIndexOffset(candles: Candle[], offset: number, intervalMs = 60 * 60 * 1000): Candle[] {
  if (offset === 0) return candles;
  const first = candles[0];
  if (!first) return candles;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('bar_index interval must be a positive integer number of milliseconds.');
  }
  const prefix = Array.from({ length: offset }, (_, index): Candle => {
    const openTime = first.openTime - (offset - index) * intervalMs;
    return {
      ...first,
      openTime,
      closeTime: openTime + intervalMs - 1,
      volume: 0,
      quoteAssetVolume: 0,
      numberOfTrades: 0,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
    };
  });
  return prefix.concat(candles);
}

/** Convert exchange-style inclusive candle ends to TradingView/Pine session boundaries. */
export function toPineSessionCandles(candles: Candle[]): Candle[] {
  return candles.map((candle) => {
    if (!Number.isSafeInteger(candle.closeTime) || candle.closeTime === Number.MAX_SAFE_INTEGER) {
      throw new Error('Candle close time cannot be converted to a Pine session boundary.');
    }
    return { ...candle, closeTime: candle.closeTime + 1 };
  });
}
