import { describe, expect, it } from 'vitest';
import {
  buildMinuteReplayDetailizationData,
  IntrabarDataError,
  MINUTE_MS,
} from '../packages/market-data/src/high-detailization';
import type { Candle } from '../packages/shared/src/contracts';

const START = Date.parse('2026-09-01T00:00:00.000Z');

function minute(openTime: number, open: number, close: number): Candle {
  return {
    openTime,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
    closeTime: openTime + MINUTE_MS - 1,
    quoteAssetVolume: close,
    numberOfTrades: 1,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

function fiveMinuteFixture(): { parent: Candle; source: Candle[] } {
  const source = [100, 101, 99, 102, 98, 103].slice(0, 5).map((open, index, values) =>
    minute(START + index * MINUTE_MS, open, values[index + 1] ?? 103));
  return {
    parent: {
      openTime: START,
      open: source[0]!.open,
      high: Math.max(...source.map((item) => item.high)),
      low: Math.min(...source.map((item) => item.low)),
      close: source.at(-1)!.close,
      volume: 5,
      closeTime: START + 5 * MINUTE_MS - 1,
      quoteAssetVolume: source.reduce((sum, item) => sum + item.quoteAssetVolume, 0),
      numberOfTrades: 5,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
      ignore: 0,
    },
    source,
  };
}

describe('0xArchive direct minute replay', () => {
  it('keeps one Pine parent bar while exposing every complete minute to the broker', () => {
    const fixture = fiveMinuteFixture();
    const result = buildMinuteReplayDetailizationData([fixture.parent], fixture.source, {
      symbol: 'BTC',
      parentTimeframe: '5m',
      tickSize: 0.1,
      cache: 'fixture',
    });

    expect(result.replayBars).toHaveLength(5);
    expect(result.replayTicks).toHaveLength(20);
    expect(result.replayTicks.map((tick) => tick.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(result.metadata.aggregate).toMatchObject({
      version: '1m-direct-replay-v1',
      replayTimeframe: '1m',
      bars: 5,
      ticks: 20,
    });
  });

  it('can defer tick materialization without changing the reported execution count', () => {
    const fixture = fiveMinuteFixture();
    const result = buildMinuteReplayDetailizationData([fixture.parent], fixture.source, {
      symbol: 'BTCUSDT',
      parentTimeframe: '5m',
      tickSize: 0.1,
      cache: 'fixture',
      materializeReplayTicks: false,
    });

    expect(result.replayBars).toHaveLength(5);
    expect(result.replayTicks).toEqual([]);
    expect(result.metadata.aggregate.ticks).toBe(20);
  });

  it('fails closed when even one expected minute is absent', () => {
    const fixture = fiveMinuteFixture();
    expect(() => buildMinuteReplayDetailizationData([fixture.parent], fixture.source.slice(0, 4), {
      symbol: 'BTC', parentTimeframe: '5m', tickSize: 0.1,
    })).toThrowError(expect.objectContaining<Partial<IntrabarDataError>>({ kind: 'INTRABAR_DATA_INCOMPLETE' }));
  });

  it('fails closed when minute OHLC does not reconcile with the parent candle', () => {
    const fixture = fiveMinuteFixture();
    const parent = { ...fixture.parent, high: fixture.parent.high + 1 };
    expect(() => buildMinuteReplayDetailizationData([parent], fixture.source, {
      symbol: 'BTC', parentTimeframe: '5m', tickSize: 0.1,
    })).toThrowError(expect.objectContaining<Partial<IntrabarDataError>>({ kind: 'INTRABAR_PARENT_MISMATCH' }));
  });

  it('fails closed when a parent bar is missing between two valid parents', () => {
    const first = fiveMinuteFixture();
    const secondSource = first.source.map((candle) => ({
      ...candle,
      openTime: candle.openTime + 10 * MINUTE_MS,
      closeTime: candle.closeTime + 10 * MINUTE_MS,
    }));
    const second = {
      ...first.parent,
      openTime: first.parent.openTime + 10 * MINUTE_MS,
      closeTime: first.parent.closeTime + 10 * MINUTE_MS,
    };
    expect(() => buildMinuteReplayDetailizationData(
      [first.parent, second],
      [...first.source, ...secondSource],
      { symbol: 'BTC', parentTimeframe: '5m', tickSize: 0.1 },
    )).toThrowError(expect.objectContaining<Partial<IntrabarDataError>>({
      kind: 'INTRABAR_PARENT_MISMATCH',
    }));
  });
});
