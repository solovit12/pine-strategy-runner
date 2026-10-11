import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/server';
import {
  timeframeToMs,
  type HistoricalMarketDataProvider,
  type HistoricalMarketDataQuery,
} from '../packages/market-data/src/historical-market-data-provider';
import type { Candle } from '../packages/shared/src/contracts';

const START = Date.parse('2026-09-01T00:00:00.000Z');
const MINUTE_MS = 60_000;
const source = `//@version=6
strategy("Manual fee control", overlay=true)
if bar_index == 0
    strategy.entry("Long", strategy.long)
if bar_index == 2
    strategy.close_all()
`;

function minute(openTime: number): Candle {
  const open = 80_000 + ((openTime - START) / MINUTE_MS) / 10;
  const close = open + 0.1;
  return {
    openTime, open, high: close, low: open, close, volume: 1,
    closeTime: openTime + MINUTE_MS - 1,
    quoteAssetVolume: close,
    numberOfTrades: 1,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

function candle(openTime: number, durationMs: number): Candle {
  const parts = Array.from({ length: durationMs / MINUTE_MS }, (_, index) => minute(openTime + index * MINUTE_MS));
  return {
    openTime,
    open: parts[0]!.open,
    high: parts.at(-1)!.high,
    low: parts[0]!.low,
    close: parts.at(-1)!.close,
    volume: parts.length,
    closeTime: openTime + durationMs - 1,
    quoteAssetVolume: parts.reduce((sum, part) => sum + part.quoteAssetVolume!, 0),
    numberOfTrades: parts.length,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

class BinanceFixture implements HistoricalMarketDataProvider {
  async getCandles(query: HistoricalMarketDataQuery) {
    const intervalMs = timeframeToMs(query.interval);
    const candles = Array.from(
      { length: (query.endExclusive - query.startInclusive) / intervalMs },
      (_, index) => candle(query.startInclusive + index * intervalMs, intervalMs),
    );
    return {
      candles,
      provenance: {
        provider: 'Binance Futures' as const,
        venue: 'binance' as const,
        symbol: query.symbol,
        interval: query.interval,
        fetchedAt: '2026-09-02T00:00:00.000Z',
        pages: 1,
        rawRows: candles.length,
        sha256: `binance-fixture-${query.interval}`,
      },
    };
  }

  async getInstrument(symbol: string) {
    return {
      symbol,
      szDecimals: 3,
      priceTickSize: 0.1,
      quantityStepSize: 0.001,
      minQuantity: 0.001,
      maxLeverage: 125,
      isActive: true,
      instrumentType: 'perp' as const,
      provenance: {
        provider: 'Binance Futures' as const,
        venue: 'binance' as const,
        requestId: 'fixture',
        fetchedAt: '2026-09-02T00:00:00.000Z',
      },
    };
  }
}

class BlockingBinanceFixture extends BinanceFixture {
  readonly started: Promise<void>;
  readonly #markStarted: () => void;
  readonly #gate: Promise<void>;
  readonly #releaseGate: () => void;

  constructor() {
    super();
    let markStarted!: () => void;
    let releaseGate!: () => void;
    this.started = new Promise<void>((resolve) => { markStarted = resolve; });
    this.#gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    this.#markStarted = markStarted;
    this.#releaseGate = releaseGate;
  }

  release(): void {
    this.#releaseGate();
  }

  override async getCandles(query: HistoricalMarketDataQuery) {
    this.#markStarted();
    await this.#gate;
    return super.getCandles(query);
  }
}

function payload(commissionValue: number) {
  return {
    source,
    exchange: 'Binance',
    marketType: 'Perpetual',
    symbol: 'btcusdt',
    timeframe: '1h',
    dateRange: { start: '2026-09-01', end: '2026-09-01' },
    initialCapital: 100_000,
    baseCurrency: 'USDT',
    defaultOrderSizeValue: 0.01,
    defaultOrderSizeType: 'fixed',
    pyramiding: 1,
    feeModel: 'manual',
    commissionType: 'percent',
    commissionValue,
    slippageTicks: 0,
    barDetailization: 'high',
  };
}

describe('Binance Futures HTTP route with user commission', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ historicalProvider: new BinanceFixture(), now: () => Date.parse('2026-09-02T00:00:00.000Z') });
  });
  afterAll(async () => { await app.close(); });

  it('requires the user to supply a commission even when it is zero', async () => {
    const request = payload(0);
    const withoutFee = { ...request, commissionValue: undefined };
    const response = await app.inject({ method: 'POST', url: '/api/backtests', payload: withoutFee });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a future end date rather than silently returning a partial historical run', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/backtests', payload: {
      ...payload(0), dateRange: { start: '2026-09-01', end: '2026-09-03' },
    } });
    expect(response.statusCode).toBe(422);
    expect(response.json().kind).toBe('INVALID_DATE_RANGE');
  });

  it('replays Binance minutes and charges exactly the commission chosen for this run', async () => {
    const free = await app.inject({ method: 'POST', url: '/api/backtests', payload: payload(0) });
    const paid = await app.inject({ method: 'POST', url: '/api/backtests', payload: payload(0.05) });
    expect(free.statusCode, free.body).toBe(200);
    expect(paid.statusCode, paid.body).toBe(200);
    const zero = free.json();
    const fee = paid.json();
    expect(zero.data).toMatchObject({ provider: 'Binance Futures', venue: 'binance', symbol: 'BTCUSDT', tradingViewTicker: 'BINANCE:BTCUSDT.P', bars: 24, intrabar: { bars1m: 1440 } });
    expect(fee.configuration).toMatchObject({ baseCurrency: 'USDT', feeModel: 'manual', feeSchedule: null, commissionType: 'percent', commissionValue: 0.05, liquidityAssumption: 'uniform_manual' });
    expect(zero.metrics.totalTrades).toBe(1);
    expect(fee.metrics.totalTrades).toBe(1);
    expect(zero.metrics.commissionPaid).toBe(0);
    expect(fee.metrics.commissionPaid).toBeGreaterThan(0);
    expect(fee.metrics.netProfit).toBeLessThan(zero.metrics.netProfit);
  });

  it('honours strategy(process_orders_on_close=true): the entry fills at the close of the signal bar', async () => {
    const run = async (onClose: boolean) => {
      const script = source.replace('strategy("Manual fee control", overlay=true)',
        `strategy("Manual fee control", overlay=true, process_orders_on_close=${onClose})`);
      const response = await app.inject({ method: 'POST', url: '/api/backtests', payload: { ...payload(0), source: script } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().trades[0];
    };
    const nextOpen = await run(false);
    const atClose = await run(true);
    // Without the flag the order waits for the next bar (01:00); with it, it fills on bar 0 (00:00 bar) at its close.
    expect(nextOpen.entryTime).toBe('2026-09-01T01:00:00.000Z');
    expect(atClose.entryTime).toBe('2026-09-01T00:00:00.000Z');
    expect(atClose.entryPrice).toBeCloseTo(80_006, 6);
  });

  it('runs Pine features added in PineTS 0.10-0.11 (once, ta.rci, ta.max, switch tuples, methods)', async () => {
    const script = `//@version=6
strategy("PineTS 0.11 features", overlay=true)
method double(float x) => x * 2
pick(int mode) =>
    switch mode
        1 => [close, 1]
        => [open, 0]
[price, flag] = pick(bar_index % 2)
rci = ta.rci(close, 5)
top = ta.max(high)
once bar_index == 3
    strategy.entry("Long", strategy.long)
if bar_index == 6 and not na(rci) and top >= price and close.double() > 0 and flag >= 0
    strategy.close_all()
`;
    const response = await app.inject({ method: 'POST', url: '/api/backtests', payload: { ...payload(0), source: script } });
    expect(response.statusCode, response.body).toBe(200);
    const trades = response.json().trades;
    expect(trades).toHaveLength(1);
    expect(trades[0].entryTime).toBe('2026-09-01T04:00:00.000Z');
    expect(trades[0].exitTime).toBe('2026-09-01T07:00:00.000Z');
  });

  describe('request.security of the chart symbol', () => {
    const run = async (body: string) => {
      const script = `//@version=6\nstrategy("Security", overlay=true, pyramiding=5)\n${body}`;
      const response = await app.inject({ method: 'POST', url: '/api/backtests', payload: { ...payload(0), pyramiding: 5, source: script } });
      return response;
    };
    const signals = async (body: string) => {
      const response = await run(body);
      expect(response.statusCode, response.body).toBe(200);
      return response.json().trades.map((trade: { entrySignal: string }) => trade.entrySignal);
    };

    it('reads a higher timeframe without looking ahead: the 4h close appears on its last hour', async () => {
      // Fixture prices rise by 0.1 per minute from 80,000 at 2026-09-01 00:00 UTC.
      expect(await signals(`h = request.security(syminfo.tickerid, "240", close)
if bar_index >= 2 and bar_index <= 4
    strategy.entry(str.tostring(h), strategy.long)
if bar_index == 7
    strategy.close_all()`)).toEqual(['80000', '80024', '80024']);
    });

    it('reports which candles request.security loaded', async () => {
      const response = await run(`h = request.security(syminfo.tickerid, "120", close)
if bar_index == 2
    strategy.entry("L", strategy.long)`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().warnings[0]).toMatch(/^request\.security: \d+ closed 120 candles of Binance Futures BTCUSDT, built from 1h/);
    });

    it('lets the form switch Fill Orders on Bar Close against the script', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/backtests', payload: { ...payload(0), processOrdersOnClose: true } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().configuration.processOrdersOnClose).toBe(true);
      expect(response.json().trades[0].entryTime).toBe('2026-09-01T00:00:00.000Z');
    });

    it('builds a timeframe the exchange does not offer (2h) from 1h candles', async () => {
      expect(await signals(`h = request.security(syminfo.tickerid, "120", close)
if bar_index == 2 or bar_index == 3
    strategy.entry(str.tostring(h), strategy.long)
if bar_index == 7
    strategy.close_all()`)).toEqual(['80012', '80024']);
    });

    it('serves request.security_lower_tf with the 15m candles inside each hour', async () => {
      expect(await signals(`a = request.security_lower_tf(syminfo.tickerid, "15", close)
if bar_index == 2
    strategy.entry(str.tostring(array.size(a)) + "/" + str.tostring(array.last(a)), strategy.long)
if bar_index == 7
    strategy.close_all()`)).toEqual(['4/80018']);
    });

    it('ends inside a day: lookahead_off keeps yesterday, lookahead_on sees only closed hours of today', async () => {
      const today = await buildApp({ historicalProvider: new BinanceFixture(), now: () => Date.parse('2026-09-01T04:30:00.000Z') });
      try {
        const lastSignal = async (lookahead: string) => {
          const script = `//@version=6\nstrategy("Security", overlay=true)\nd = request.security(syminfo.tickerid, "D", close, lookahead=${lookahead})\nif bar_index == 1\n    strategy.entry(str.tostring(d), strategy.long)\nif bar_index == 2\n    strategy.close_all()\n`;
          const response = await today.inject({ method: 'POST', url: '/api/backtests', payload: { ...payload(0), source: script } });
          expect(response.statusCode, response.body).toBe(200);
          return response.json().trades[0].entrySignal;
        };
        // The run ends at 04:00 inside the day. lookahead_off: yesterday's close. lookahead_on
        // reads the day built from the closed hours up to 04:00 (like TradingView, lookahead_on
        // shows the higher-timeframe bar's later values) but never any price after the run.
        expect(await lastSignal('barmerge.lookahead_off')).toBe('80000');
        expect(await lastSignal('barmerge.lookahead_on')).toBe('80024');
      } finally { await today.close(); }
    });

    it('refuses another symbol with a clear message instead of using the chart', async () => {
      const response = await run(`h = request.security("BINANCE:ETHUSDT", "240", close)
if bar_index == 2
    strategy.entry("L", strategy.long)`);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ kind: 'unsupported-feature' });
      expect(response.json().error).toContain('request.security for another symbol (ETHUSDT) is not supported');
    });
  });

  it('warns when today contains only some completed parent bars', async () => {
    const currentApp = await buildApp({ historicalProvider: new BinanceFixture(), now: () => Date.parse('2026-09-01T04:30:00.000Z') });
    try {
      const response = await currentApp.inject({ method: 'POST', url: '/api/backtests', payload: payload(0) });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.bars).toBe(4);
      expect(response.json().warnings).toContainEqual(expect.stringContaining('только закрытые свечи до 2026-09-01T04:00:00.000Z'));
    } finally {
      await currentApp.close();
    }
  });

  it('allows only one active backtest at a time', async () => {
    const provider = new BlockingBinanceFixture();
    const guardedApp = await buildApp({
      historicalProvider: provider,
      now: () => Date.parse('2026-09-02T00:00:00.000Z'),
    });
    try {
      const first = guardedApp.inject({ method: 'POST', url: '/api/backtests', payload: payload(0) });
      await provider.started;
      const second = await guardedApp.inject({ method: 'POST', url: '/api/backtests', payload: payload(0) });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ kind: 'BACKTEST_ALREADY_RUNNING' });
      provider.release();
      const completed = await first;
      expect(completed.statusCode, completed.body).toBe(200);
    } finally {
      provider.release();
      await guardedApp.close();
    }
  });
});
