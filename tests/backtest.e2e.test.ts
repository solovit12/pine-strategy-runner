import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  DEFAULT_MAX_BACKTEST_EXECUTION_MINUTES,
  MAX_BACKTEST_EXECUTION_MINUTES,
} from '../apps/api/src/server';
import {
  timeframeToMs,
  type HistoricalMarketDataProvider,
  type HistoricalMarketDataQuery,
  type HistoricalMarketDataResult,
} from '../packages/market-data/src/historical-market-data-provider';
import type { Candle } from '../packages/shared/src/contracts';

/** The former editor example; the app now ships without strategies, so tests keep it as a fixture. */
const buyAndHold = readFileSync(new URL('./fixtures/qualification/strategies/13-binance-futures-buy-and-hold.pine', import.meta.url), 'utf8');

function minutePrice(openTime: number): number {
  return 100 + (Math.floor(openTime / 60_000) % 1_000) / 100;
}

function minuteCandle(openTime: number): Candle {
  const open = minutePrice(openTime);
  const close = minutePrice(openTime + 60_000);
  return {
    openTime,
    open,
    high: Math.max(open, close) + 0.01,
    low: Math.min(open, close) - 0.01,
    close,
    volume: 1,
    closeTime: openTime + 60_000 - 1,
    quoteAssetVolume: close,
    numberOfTrades: 1,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

function aggregate(openTime: number, durationMs: number): Candle {
  const minutes = Array.from(
    { length: durationMs / 60_000 },
    (_, index) => minuteCandle(openTime + index * 60_000),
  );
  return {
    openTime,
    open: minutes[0]!.open,
    high: Math.max(...minutes.map((candle) => candle.high)),
    low: Math.min(...minutes.map((candle) => candle.low)),
    close: minutes.at(-1)!.close,
    volume: minutes.length,
    closeTime: openTime + durationMs - 1,
    quoteAssetVolume: minutes.reduce((sum, candle) => sum + candle.quoteAssetVolume, 0),
    numberOfTrades: minutes.length,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

class FixtureProvider implements HistoricalMarketDataProvider {
  readonly calls: HistoricalMarketDataQuery[] = [];

  constructor(private readonly omitMinuteAt: number | null = null) {}

  async getCandles(query: HistoricalMarketDataQuery): Promise<HistoricalMarketDataResult> {
    this.calls.push(query);
    const intervalMs = timeframeToMs(query.interval);
    const candles = Array.from(
      { length: (query.endExclusive - query.startInclusive) / intervalMs },
      (_, index) => query.interval === '1m'
        ? minuteCandle(query.startInclusive + index * intervalMs)
        : aggregate(query.startInclusive + index * intervalMs, intervalMs),
    ).filter((candle) => candle.openTime !== this.omitMinuteAt);
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
        sha256: `fixture-${query.interval}`,
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
        requestId: 'fixture',
        fetchedAt: '2026-09-18T00:00:00.000Z',
      },
    };
  }
}

describe('0xArchive Hyperliquid HTTP vertical slice', () => {
  const provider = new FixtureProvider();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      historicalProvider: provider,
      now: () => Date.parse('2026-09-18T00:00:00.000Z'),
    });
  });
  afterAll(async () => { await app.close(); });

  it('starts the editor from an empty strategy template and reports the public active source', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().historicalData).toEqual({
      provider: 'Binance Futures',
      venue: 'binance',
      configured: true,
    });
    expect(health.json().backtestCapacity).toEqual({
      maxConcurrentRuns: 1,
      maxExecutionMinutes: 172_800,
    });
    expect(DEFAULT_MAX_BACKTEST_EXECUTION_MINUTES).toBeGreaterThan(69 * 24 * 60);
    expect(DEFAULT_MAX_BACKTEST_EXECUTION_MINUTES).toBe(120 * 24 * 60);
    expect(MAX_BACKTEST_EXECUTION_MINUTES).toBe(189 * 24 * 60);

    const presetResponse = await app.inject({ method: 'GET', url: '/api/preset' });
    expect(presetResponse.statusCode).toBe(200);
    expect(presetResponse.json().source).toContain('strategy("My strategy"');
    expect(presetResponse.json()).toMatchObject({
      id: 'TEMPLATE',
      configuration: {
        exchange: 'Binance',
        marketType: 'Perpetual',
        symbol: 'BTCUSDT',
        timeframe: '1h',
        baseCurrency: 'USDT',
        feeModel: 'manual',
        commissionValue: null,
      },
    });
  });

  it('runs Pine on parent bars and checks execution on every 0xArchive minute', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      payload: {
        source: buyAndHold,
        exchange: 'Hyperliquid',
        marketType: 'Perpetual',
        symbol: 'BTC',
        timeframe: '1h',
        barIndexOffset: 0,
        dateRange: { start: '2026-09-01', end: '2026-09-07' },
        initialCapital: 100_000,
        baseCurrency: 'USDC',
        defaultOrderSizeValue: 0.01,
        defaultOrderSizeType: 'fixed',
        pyramiding: 1,
        commissionType: 'percent',
        commissionValue: 0.1,
        slippagePercent: 0,
        barDetailization: 'high',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const result = response.json();
    expect(result.data).toMatchObject({
      provider: '0xArchive',
      venue: 'hyperliquid',
      marketType: 'perpetual',
      symbol: 'BTC',
      tradingViewTicker: 'HYPERLIQUID:BTCUSDC.P',
      timeframe: '1h',
      bars: 168,
      missingBars: 0,
      fetchedPages: 1,
      rawRows: 168,
      instrument: {
        sizeDecimals: 5,
        mintick: 0.1,
        minContract: 0.00001,
        maxLeverage: 40,
        mintickModel: 'hyperliquid-minimum-increment-v1',
      },
      intrabar: {
        source: '0xArchive Hyperliquid candles',
        sourceTimeframe: '1m',
        replayTimeframe: '1m',
        bars1m: 10_080,
        replayBars: 10_080,
        replayTicks: 40_320,
        missingBars1m: 0,
        sourceSha256: 'fixture-1m',
        fetchedPages: 1,
      },
    });
    expect(result.configuration).toMatchObject({
      feeModel: 'venue_default_all_taker_v1',
      liquidityAssumption: 'all_taker',
      commissionType: 'percent',
      commissionValue: 0.045,
      feeSchedule: {
        venue: 'hyperliquid',
        accountProfile: 'base-tier',
        makerFeeRate: '0.00015',
        takerFeeRate: '0.00045',
      },
    });
    expect(result.configuration).toMatchObject({
      baseCurrency: 'USDC',
      barDetailization: 'high',
      executionModelVersion: 'minute-replay-v1',
      chartTimeframe: '1h',
    });
    expect(result.comparison.status).toBe('NOT_APPLICABLE');
    expect(result.chart.candles).toHaveLength(168);
    expect(result.metrics.totalTrades).toBe(1);
  });

  it('fills market and stop orders the execution cost worse, limits and take-profits at their price', async () => {
    const run = async (source: string, slippagePercent: number) => {
      const response = await app.inject({ method: 'POST', url: '/api/backtests', payload: {
        source, exchange: 'Hyperliquid', marketType: 'Perpetual', symbol: 'BTC', timeframe: '1h', barIndexOffset: 0,
        dateRange: { start: '2026-09-01', end: '2026-09-07' }, initialCapital: 100_000, baseCurrency: 'USDC',
        defaultOrderSizeValue: 0.01, defaultOrderSizeType: 'fixed', pyramiding: 1, commissionType: 'percent', commissionValue: 0,
        slippagePercent, barDetailization: 'high',
      } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as { trades: Array<{ entryPrice: number; exitPrice: number }>; configuration: { slippagePercent: number } };
    };
    const worse = (price: number, up: boolean) => Number(((up ? Math.ceil(price * 1.002 * 10 - 1e-9) : Math.floor(price * 0.998 * 10 + 1e-9)) / 10).toFixed(1));
    // Market entry and market close: both 0.2 % worse, on the 0.1 tick.
    const plain = await run(buyAndHold, 0);
    const costed = await run(buyAndHold, 0.2);
    expect(costed.configuration.slippagePercent).toBe(0.2);
    expect(costed.trades[0]!.entryPrice).toBe(worse(plain.trades[0]!.entryPrice, true));
    expect(costed.trades[0]!.exitPrice).toBe(worse(plain.trades[0]!.exitPrice, false));
    // A take-profit limit fills at its own price either way.
    const takeProfit = `//@version=6
strategy("TP", overlay=true, default_qty_type=strategy.fixed, default_qty_value=0.01)
var bool sent = false
if not sent
    strategy.entry("L", strategy.long)
    sent := true
strategy.exit("TP", "L", limit=109.0)
`;
    const tpPlain = await run(takeProfit, 0);
    const tpCosted = await run(takeProfit, 0.2);
    expect(tpPlain.trades[0]!.exitPrice).toBe(109);
    expect(tpCosted.trades[0]!.exitPrice).toBe(109);
    expect(tpCosted.trades[0]!.entryPrice).toBe(worse(tpPlain.trades[0]!.entryPrice, true));
    // The default is 0.2 % when the request leaves it out.
    const defaulted = await app.inject({ method: 'POST', url: '/api/backtests', payload: {
      source: buyAndHold, exchange: 'Hyperliquid', marketType: 'Perpetual', symbol: 'BTC', timeframe: '1h', barIndexOffset: 0,
      dateRange: { start: '2026-09-01', end: '2026-09-07' }, initialCapital: 100_000, baseCurrency: 'USDC',
      defaultOrderSizeValue: 0.01, defaultOrderSizeType: 'fixed', pyramiding: 1, commissionType: 'percent', commissionValue: 0,
      barDetailization: 'high' } });
    expect(defaulted.json().configuration.slippagePercent).toBe(0.2);
  });

  it('fails closed when one required minute is absent', async () => {
    const missingAt = Date.parse('2026-09-01T00:30:00.000Z');
    const brokenApp = await buildApp({
      historicalProvider: new FixtureProvider(missingAt),
      now: () => Date.parse('2026-09-18T00:00:00.000Z'),
    });
    try {
      const response = await brokenApp.inject({
        method: 'POST',
        url: '/api/backtests',
        payload: {
          source: buyAndHold,
          exchange: 'Hyperliquid',
          marketType: 'Perpetual',
          symbol: 'BTC',
          timeframe: '1h',
          barIndexOffset: 0,
          dateRange: { start: '2026-09-01', end: '2026-09-01' },
          initialCapital: 100_000,
          baseCurrency: 'USDC',
          defaultOrderSizeValue: 0.01,
          defaultOrderSizeType: 'fixed',
          pyramiding: 1,
          commissionType: 'percent',
          commissionValue: 0.1,
          slippagePercent: 0,
          barDetailization: 'high',
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ kind: 'INTRABAR_DATA_INCOMPLETE' });
    } finally {
      await brokenApp.close();
    }
  });

  it('rejects a run above the configured execution-minute budget before fetching candles', async () => {
    const limitedProvider = new FixtureProvider();
    const limitedApp = await buildApp({
      historicalProvider: limitedProvider,
      now: () => Date.parse('2026-09-18T00:00:00.000Z'),
      maxExecutionMinutes: 1_000,
    });
    try {
      const response = await limitedApp.inject({
        method: 'POST',
        url: '/api/backtests',
        payload: {
          source: buyAndHold,
          exchange: 'Hyperliquid',
          marketType: 'Perpetual',
          symbol: 'BTC',
          timeframe: '1h',
          barIndexOffset: 0,
          dateRange: { start: '2026-09-01', end: '2026-09-01' },
          initialCapital: 100_000,
          baseCurrency: 'USDC',
          defaultOrderSizeValue: 0.01,
          defaultOrderSizeType: 'fixed',
          pyramiding: 1,
          commissionType: 'percent',
          commissionValue: 0.1,
          slippagePercent: 0,
          barDetailization: 'high',
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        kind: 'INTRABAR_LIMIT_EXCEEDED',
        details: {
          expectedMinuteBars: 1_440,
          maxMinuteReplayBars: 1_000,
          requiredExecutionMinutes: 1_440,
          maxExecutionMinutes: 1_000,
        },
      });
      expect(limitedProvider.calls).toEqual([]);
    } finally {
      await limitedApp.close();
    }
  });

  it('fails closed when an operator configures more than the built-in execution-minute ceiling', async () => {
    await expect(buildApp({
      historicalProvider: new FixtureProvider(),
      maxExecutionMinutes: MAX_BACKTEST_EXECUTION_MINUTES + 1,
    })).rejects.toThrow(/must not exceed the built-in/i);
  });

  it('accepts the 189-day candidate ceiling when the operator explicitly configures it', async () => {
    const candidateApp = await buildApp({
      historicalProvider: new FixtureProvider(),
      maxExecutionMinutes: MAX_BACKTEST_EXECUTION_MINUTES,
    });
    try {
      const health = await candidateApp.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json().backtestCapacity).toEqual({
        maxConcurrentRuns: 1,
        maxExecutionMinutes: 189 * 24 * 60,
      });
    } finally {
      await candidateApp.close();
    }
  });

  it('does not accept Binance spot for the Binance Futures route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      payload: {
        source: '//@version=6\nstrategy("x")',
        exchange: 'Binance',
        marketType: 'Spot',
        symbol: 'BTCUSDT',
        timeframe: '1h',
        dateRange: { start: '2026-09-01', end: '2026-09-01' },
        initialCapital: 100_000,
        baseCurrency: 'USDT',
        defaultOrderSizeValue: 1,
        defaultOrderSizeType: 'fixed',
        pyramiding: 1,
        commissionType: 'percent',
        commissionValue: 0.1,
        slippagePercent: 0,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Invalid run settings. / Некорректные настройки запуска.');
  });
});
