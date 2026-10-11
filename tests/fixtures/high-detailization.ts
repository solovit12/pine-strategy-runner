import type { Candle } from '../../packages/shared/src/contracts.js';
import { MINUTE_MS, TEN_MINUTES_MS } from '../../packages/market-data/src/high-detailization.js';

export const FIXTURE_A_START = Date.UTC(2026, 0, 1);

const replayOhlc = [
  [100, 104, 99, 103],
  [103, 108, 102, 107],
  [107, 115, 106, 114],
  [114, 114, 105, 106],
  [106, 108, 95, 98],
  [98, 112, 97, 110],
] as const;

function expandBucket(
  bucketIndex: number,
  values: readonly [number, number, number, number],
): Candle[] {
  const [open, high, low, close] = values;
  const points = [open, open, high, high, low, low, close, close, close, close, close];
  return Array.from({ length: 10 }, (_, minuteIndex) => {
    const openTime = FIXTURE_A_START + bucketIndex * TEN_MINUTES_MS + minuteIndex * MINUTE_MS;
    const minuteOpen = points[minuteIndex]!;
    const minuteClose = points[minuteIndex + 1]!;
    return {
      openTime,
      open: minuteOpen,
      high: Math.max(minuteOpen, minuteClose),
      low: Math.min(minuteOpen, minuteClose),
      close: minuteClose,
      volume: 1,
      closeTime: openTime + MINUTE_MS - 1,
      quoteAssetVolume: minuteClose,
      numberOfTrades: 1,
      takerBuyBaseAssetVolume: 0.5,
      takerBuyQuoteAssetVolume: minuteClose / 2,
      ignore: 0,
    };
  });
}

export const fixtureAOneMinuteCandles: Candle[] = replayOhlc.flatMap((values, index) =>
  expandBucket(index, values));

const quoteAssetVolume = fixtureAOneMinuteCandles.reduce((total, candle) => total + candle.quoteAssetVolume, 0);
const takerBuyQuoteAssetVolume = fixtureAOneMinuteCandles
  .reduce((total, candle) => total + candle.takerBuyQuoteAssetVolume, 0);

export const fixtureAParent: Candle = {
  openTime: FIXTURE_A_START,
  open: 100,
  high: 115,
  low: 95,
  close: 110,
  volume: 60,
  closeTime: FIXTURE_A_START + 60 * MINUTE_MS - 1,
  quoteAssetVolume,
  numberOfTrades: 60,
  takerBuyBaseAssetVolume: 30,
  takerBuyQuoteAssetVolume,
  ignore: 0,
};

export function cloneFixtureACandles(): Candle[] {
  return fixtureAOneMinuteCandles.map((candle) => ({ ...candle }));
}

export function candleToBinanceRow(candle: Candle): unknown[] {
  return [
    candle.openTime,
    String(candle.open),
    String(candle.high),
    String(candle.low),
    String(candle.close),
    String(candle.volume),
    candle.closeTime,
    String(candle.quoteAssetVolume),
    candle.numberOfTrades,
    String(candle.takerBuyBaseAssetVolume),
    String(candle.takerBuyQuoteAssetVolume),
    String(candle.ignore),
  ];
}
