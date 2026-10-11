import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../packages/shared/src/contracts.js';
import {
  aggregateTenMinuteBucket,
  buildHighDetailizationData,
  IntrabarDataError,
  TEN_MINUTES_MS,
  type IntrabarDataErrorKind,
} from '../packages/market-data/src/high-detailization.js';
import {
  candleToBinanceRow,
  cloneFixtureACandles,
  FIXTURE_A_START,
  fixtureAOneMinuteCandles,
  fixtureAParent,
} from './fixtures/high-detailization.js';

function expectDataError(action: () => unknown, kind: IntrabarDataErrorKind): IntrabarDataError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IntrabarDataError);
  expect(caught).toMatchObject({ kind });
  return caught as IntrabarDataError;
}

function flatHourlyFixture(hours: number): { parents: Candle[]; source: Candle[] } {
  const source = Array.from({ length: hours * 60 }, (_, index): Candle => {
    const openTime = FIXTURE_A_START + index * 60_000;
    return {
      openTime,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
      closeTime: openTime + 59_999,
      quoteAssetVolume: 100,
      numberOfTrades: 1,
      takerBuyBaseAssetVolume: 0.5,
      takerBuyQuoteAssetVolume: 50,
      ignore: 0,
    };
  });
  const parents = Array.from({ length: hours }, (_, index): Candle => {
    const openTime = FIXTURE_A_START + index * 3_600_000;
    return {
      openTime,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 60,
      closeTime: openTime + 3_599_999,
      quoteAssetVolume: 6_000,
      numberOfTrades: 60,
      takerBuyBaseAssetVolume: 30,
      takerBuyQuoteAssetVolume: 3_000,
      ignore: 0,
    };
  });
  return { parents, source };
}

describe('High detailization H1 data gate', () => {
  it('D01 aggregates 10 sequential 1m bars into one correct 10m OHLCV bucket', () => {
    const bucket = aggregateTenMinuteBucket(fixtureAOneMinuteCandles.slice(0, 10));
    expect(bucket).toMatchObject({
      openTime: FIXTURE_A_START,
      open: 100,
      high: 104,
      low: 99,
      close: 103,
      volume: 10,
      numberOfTrades: 10,
    });
    expect(bucket.closeTime).toBe(FIXTURE_A_START + TEN_MINUTES_MS - 1);
  });

  it('D02 converts 60 sequential 1m bars into exactly 6 replay bars and 24 ticks', () => {
    const result = buildHighDetailizationData([fixtureAParent], cloneFixtureACandles(), { tickSize: 0.01 });
    expect(result.replayBars).toHaveLength(6);
    expect(result.replayTicks).toHaveLength(24);
    expect(result.replayTicks.map((tick) => tick.sequence)).toEqual(Array.from({ length: 24 }, (_, index) => index));
  });

  it('D03 aligns buckets strictly to UTC minutes 00/10/20/30/40/50', () => {
    const result = buildHighDetailizationData([fixtureAParent], cloneFixtureACandles(), { tickSize: 0.01 });
    expect(result.replayBars.map((bar) => new Date(bar.openTime).getUTCMinutes())).toEqual([0, 10, 20, 30, 40, 50]);
    expect(result.replayBars.every((bar) => bar.openTime % TEN_MINUTES_MS === 0)).toBe(true);
  });

  it('D04 keeps actual high and low when they occur in different source minutes', () => {
    const result = buildHighDetailizationData([fixtureAParent], cloneFixtureACandles(), { tickSize: 0.01 });
    expect(result.replayBars[2]).toMatchObject({ high: 115, low: 106 });
    expect(result.replayBars[4]).toMatchObject({ high: 108, low: 95 });
  });

  it('D05 sums volume, quote volume, trades and taker volumes', () => {
    const source = fixtureAOneMinuteCandles.slice(0, 10);
    const bucket = aggregateTenMinuteBucket(source);
    expect(bucket.volume).toBe(source.reduce((total, candle) => total + candle.volume, 0));
    expect(bucket.quoteAssetVolume).toBe(source.reduce((total, candle) => total + candle.quoteAssetVolume, 0));
    expect(bucket.numberOfTrades).toBe(source.reduce((total, candle) => total + candle.numberOfTrades, 0));
    expect(bucket.takerBuyBaseAssetVolume).toBe(source.reduce((total, candle) => total + candle.takerBuyBaseAssetVolume, 0));
    expect(bucket.takerBuyQuoteAssetVolume).toBe(source.reduce((total, candle) => total + candle.takerBuyQuoteAssetVolume, 0));
  });

  it('D06 fails closed when one minute is missing', () => {
    const source = cloneFixtureACandles();
    const missing = source.splice(17, 1)[0]!;
    const error = expectDataError(
      () => buildHighDetailizationData([fixtureAParent], source, { tickSize: 0.01 }),
      'INTRABAR_DATA_INCOMPLETE',
    );
    expect(error.details).toMatchObject({ missingTimestamps: [missing.openTime] });
  });

  it('D07 rejects a duplicated timestamp without deduplicating it', () => {
    const source = cloneFixtureACandles();
    source.splice(11, 0, { ...source[10]! });
    const error = expectDataError(
      () => buildHighDetailizationData([fixtureAParent], source, { tickSize: 0.01 }),
      'INTRABAR_DUPLICATE_TIMESTAMP',
    );
    expect(error.details).toMatchObject({ duplicateTimestamps: [source[10]!.openTime] });
  });

  it('D08 rejects timestamps that move backwards without sorting them', () => {
    const source = cloneFixtureACandles();
    [source[10], source[11]] = [source[11]!, source[10]!];
    expectDataError(
      () => buildHighDetailizationData([fixtureAParent], source, { tickSize: 0.01 }),
      'INTRABAR_TIME_ORDER_INVALID',
    );
  });

  it('D09 rejects low above high or a close outside the candle range', () => {
    const source = cloneFixtureACandles();
    source[3] = { ...source[3]!, low: source[3]!.high + 1 };
    expectDataError(
      () => buildHighDetailizationData([fixtureAParent], source, { tickSize: 0.01 }),
      'INTRABAR_OHLC_INVALID',
    );
  });

  it('D10 rejects a native 1h parent that differs after tick-size normalization', () => {
    const parent = { ...fixtureAParent, high: fixtureAParent.high + 0.01 };
    const error = expectDataError(
      () => buildHighDetailizationData([parent], cloneFixtureACandles(), { tickSize: 0.01 }),
      'INTRABAR_PARENT_MISMATCH',
    );
    expect(error.details).toMatchObject({ mismatches: ['high'] });
  });
});
