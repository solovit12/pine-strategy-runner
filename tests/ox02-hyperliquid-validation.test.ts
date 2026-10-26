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

const DAY_START = Date.parse('2026-09-16T00:00:00.000Z');
const MINUTE_MS = 60_000;

function minute(openTime: number): Candle {
  const minuteOfDay = (openTime - DAY_START) / MINUTE_MS;
  const hour = Math.floor(minuteOfDay / 60);
  const minuteOfHour = minuteOfDay % 60;
  let open = 75_670;
  let high = 75_670;
  let low = 75_670;
  let close = 75_670;

  if (hour === 18) {
    if (minuteOfHour === 0) {
      [open, high, low, close] = [75_670, 75_945, 75_375, 75_551];
    } else if (minuteOfHour < 6) {
      [open, high, low, close] = [75_551, 76_221, 75_217, 76_107];
    } else if (minuteOfHour === 6) {
      [open, high, low, close] = [76_107, 76_340, 76_101, 76_220];
    } else if (minuteOfHour < 36) {
      [open, high, low, close] = [76_220, 76_547, 75_217, 75_229];
    } else if (minuteOfHour === 36) {
      [open, high, low, close] = [75_229, 75_333, 75_000, 75_096];
    } else {
      [open, high, low, close] = [75_096, 75_700, 75_000, 75_601];
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

class Ox02FixtureProvider implements HistoricalMarketDataProvider {
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
        sha256: `ox02-fixture-${query.interval}`,
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
        requestId: 'ox02-fixture',
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
    dateRange: { start: '2026-09-16', end: '2026-09-16' },
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

describe('OX02 Hyperliquid minute bracket control', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let source: string;

  beforeAll(async () => {
    source = await readFile(
      path.join(process.cwd(), 'tests', 'fixtures', 'qualification', 'strategies', '10-oxarchive-minute-bracket.pine'),
      'utf8',
    );
    app = await buildApp({
      historicalProvider: new Ox02FixtureProvider(),
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

  it('chooses the minute-first TP even though the parent hour also crosses the SL', async () => {
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
      entryTime: '2026-09-16T18:00:00.000Z',
      entryPrice: 75_670,
      exitPrice: 76_300,
      size: 0.01,
      entrySignal: 'Long',
      exitSignal: 'Bracket',
    });
    expect(minuteBucket(result.trades[0].exitTime)).toBe('2026-09-16T18:06:00.000Z');
    expect(result.metrics).toMatchObject({
      totalTrades: 1,
      winRatePercent: 100,
      netProfit: 5.616135,
      commissionPaid: 0.683865,
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
    expect(minuteResult.trades[0].durationBars).toBe(6);
  });

  it('is byte-stable across repeated hourly minute-replay runs', async () => {
    const first = await run('1h');
    const second = await run('1h');
    expect(JSON.stringify({ trades: first.trades, metrics: first.metrics }))
      .toBe(JSON.stringify({ trades: second.trades, metrics: second.metrics }));
  });
});
