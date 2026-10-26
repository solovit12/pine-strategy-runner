import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/server';
import {
  timeframeToMs,
  type HistoricalMarketDataProvider,
  type HistoricalMarketDataQuery,
  type HistoricalMarketDataResult,
} from '../packages/market-data/src/historical-market-data-provider';
import type { BacktestTimeframe, Candle } from '../packages/shared/src/contracts';

const DAY_START = Date.parse('2026-09-15T00:00:00.000Z');
const MINUTE_MS = 60_000;

function minute(openTime: number): Candle {
  const minuteOfDay = (openTime - DAY_START) / MINUTE_MS;
  const hour = Math.floor(minuteOfDay / 60);
  const minuteOfHour = minuteOfDay % 60;
  let open = 76_931;
  let high = 76_931;
  let low = 76_931;
  let close = 76_931;

  if (hour === 18) {
    if (minuteOfHour === 0) {
      [open, high, low, close] = [76_931, 76_931, 76_812, 76_838];
    } else if (minuteOfHour < 17) {
      [open, high, low, close] = [76_900, 77_050, 76_650, 76_670];
    } else if (minuteOfHour === 17) {
      [open, high, low, close] = [76_670, 76_675, 76_475, 76_515];
    } else if (minuteOfHour < 29) {
      [open, high, low, close] = [76_515, 77_050, 74_903, 76_700];
    } else if (minuteOfHour === 29) {
      [open, high, low, close] = [76_700, 77_205, 76_699, 76_879];
    } else {
      [open, high, low, close] = [76_879, 77_000, 74_903, 75_957];
    }
  }

  return {
    openTime,
    open,
    high,
    low,
    close,
    volume: 1,
    closeTime: openTime + MINUTE_MS - 1,
    quoteAssetVolume: close,
    numberOfTrades: 1,
    takerBuyBaseAssetVolume: 0.5,
    takerBuyQuoteAssetVolume: close / 2,
    ignore: 0,
  };
}

function aggregate(openTime: number, intervalMs: number): Candle {
  const minutes = Array.from(
    { length: intervalMs / MINUTE_MS },
    (_, index) => minute(openTime + index * MINUTE_MS),
  );
  return {
    openTime,
    open: minutes[0]!.open,
    high: Math.max(...minutes.map((candle) => candle.high)),
    low: Math.min(...minutes.map((candle) => candle.low)),
    close: minutes.at(-1)!.close,
    volume: minutes.reduce((sum, candle) => sum + candle.volume, 0),
    closeTime: openTime + intervalMs - 1,
    quoteAssetVolume: minutes.reduce((sum, candle) => sum + candle.quoteAssetVolume, 0),
    numberOfTrades: minutes.reduce((sum, candle) => sum + candle.numberOfTrades, 0),
    takerBuyBaseAssetVolume: minutes.reduce((sum, candle) => sum + candle.takerBuyBaseAssetVolume, 0),
    takerBuyQuoteAssetVolume: minutes.reduce((sum, candle) => sum + candle.takerBuyQuoteAssetVolume, 0),
    ignore: 0,
  };
}

class Ox03FixtureProvider implements HistoricalMarketDataProvider {
  async getCandles(query: HistoricalMarketDataQuery): Promise<HistoricalMarketDataResult> {
    const intervalMs = timeframeToMs(query.interval);
    const candles = Array.from(
      { length: (query.endExclusive - query.startInclusive) / intervalMs },
      (_, index) => query.interval === '1m'
        ? minute(query.startInclusive + index * intervalMs)
        : aggregate(query.startInclusive + index * intervalMs, intervalMs),
    );
    return {
      candles,
      provenance: {
        provider: '0xArchive',
        venue: 'hyperliquid',
        symbol: query.symbol,
        interval: query.interval,
        fetchedAt: '2026-09-18T00:00:00.000Z',
        pages: 1,
        rawRows: candles.length,
        sha256: `ox03-fixture-${query.interval}`,
      },
    };
  }

  async getInstrument(symbol: string) {
    return {
      symbol,
      szDecimals: 5,
      maxLeverage: 40,
      isActive: true,
      instrumentType: 'perp' as const,
      provenance: {
        provider: '0xArchive' as const,
        venue: 'hyperliquid' as const,
        requestId: 'ox03-fixture',
        fetchedAt: '2026-09-18T00:00:00.000Z',
      },
    };
  }
}

function request(source: string, timeframe: BacktestTimeframe) {
  return {
    source,
    exchange: 'Hyperliquid',
    marketType: 'Perpetual',
    symbol: 'BTC',
    timeframe,
    barIndexOffset: 0,
    dateRange: { start: '2026-09-15', end: '2026-09-15' },
    initialCapital: 100_000,
    baseCurrency: 'USDC',
    defaultOrderSizeValue: 0.01,
    defaultOrderSizeType: 'fixed',
    pyramiding: 1,
    feeModel: 'venue_default_all_taker_v1',
    commissionType: 'percent',
    commissionValue: 0.045,
    slippagePercent: 0,
    barDetailization: timeframe === '1m' ? 'default' : 'high',
    calcOnOrderFills: false,
    calcOnEveryTick: false,
    calcOnEveryHistoryTick: false,
    limitOrderVerificationTicks: 0,
    processOrdersOnClose: false,
  } as const;
}

function minuteBucket(value: unknown): string {
  const timestamp = Date.parse(String(value));
  return new Date(Math.floor(timestamp / MINUTE_MS) * MINUTE_MS).toISOString();
}

function comparableTrade(trade: Record<string, unknown>) {
  const { durationBars: _durationBars, entryTime, exitTime, ...comparable } = trade;
  return {
    ...comparable,
    entryMinute: minuteBucket(entryTime),
    exitMinute: minuteBucket(exitTime),
  };
}

describe('OX03 Hyperliquid minute bracket SL-first control', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let source: string;

  beforeAll(async () => {
    source = await readFile(
      path.join(process.cwd(), 'tests', 'fixtures', 'qualification', 'strategies', '11-oxarchive-minute-bracket-sl-first.pine'),
      'utf8',
    );
    app = await buildApp({
      historicalProvider: new Ox03FixtureProvider(),
      now: () => Date.parse('2026-09-18T00:00:00.000Z'),
    });
  });

  afterAll(async () => { await app.close(); });

  async function run(timeframe: BacktestTimeframe) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      payload: request(source, timeframe),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  it('proves the witness candles cross SL before TP while the coarse parent path points to TP', () => {
    const hourStart = Date.parse('2026-09-15T18:00:00.000Z');
    const minutes = Array.from({ length: 60 }, (_, index) => minute(hourStart + index * MINUTE_MS));
    const firstSl = minutes.findIndex((candle) => candle.low <= 76_600);
    const firstTp = minutes.findIndex((candle) => candle.high >= 77_100);
    const parent = aggregate(hourStart, 60 * MINUTE_MS);

    expect({ firstSl, firstTp }).toEqual({ firstSl: 17, firstTp: 29 });
    expect(minutes[firstSl]).toMatchObject({ open: 76_670, high: 76_675, low: 76_475, close: 76_515 });
    expect(minutes[firstTp]).toMatchObject({ open: 76_700, high: 77_205, low: 76_699, close: 76_879 });
    expect(parent).toMatchObject({ open: 76_931, high: 77_205, low: 74_903, close: 75_957 });
    expect(parent.high - parent.open).toBeLessThan(parent.open - parent.low);
  });

  it('chooses the minute-first SL even though the coarse parent path would choose TP', async () => {
    const result = await run('1h');
    expect(result.configuration.executionModelVersion).toBe('minute-replay-v1');
    expect(result.data.intrabar).toMatchObject({
      bars1m: 1_440,
      replayBars: 1_440,
      missingBars1m: 0,
      recovery: null,
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      side: 'long',
      entryTime: '2026-09-15T18:00:00.000Z',
      entryPrice: 76_931,
      exitPrice: 76_600,
      size: 0.01,
      entrySignal: 'Long',
      exitSignal: 'Bracket',
    });
    expect(minuteBucket(result.trades[0].exitTime)).toBe('2026-09-15T18:17:00.000Z');
    expect(result.metrics).toMatchObject({
      totalTrades: 1,
      winRatePercent: 0,
      netProfit: -4.0008895,
      commissionPaid: 0.6908895,
      openProfit: 0,
    });
  });

  it('matches the same source on 1h minute replay and native 1m execution', async () => {
    const hourly = await run('1h');
    const minuteResult = await run('1m');
    expect(minuteResult.configuration.executionModelVersion).toBe('default-v2');
    expect(minuteResult.data).toMatchObject({ bars: 1_440, missingBars: 0, recovery: null, intrabar: null });
    expect(comparableTrade(hourly.trades[0])).toEqual(comparableTrade(minuteResult.trades[0]));
    expect(hourly.metrics.netProfit).toBe(minuteResult.metrics.netProfit);
    expect(hourly.metrics.commissionPaid).toBe(minuteResult.metrics.commissionPaid);
    expect(hourly.metrics.endingEquity).toBe(minuteResult.metrics.endingEquity);
    expect(hourly.trades[0].durationBars).toBe(0);
    expect(minuteResult.trades[0].durationBars).toBe(17);
  });

  it('is byte-stable across repeated hourly minute-replay runs', async () => {
    const first = await run('1h');
    const second = await run('1h');
    expect(JSON.stringify({ trades: first.trades, metrics: first.metrics }))
      .toBe(JSON.stringify({ trades: second.trades, metrics: second.metrics }));
  });
});
