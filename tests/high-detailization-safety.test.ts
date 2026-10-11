import { describe, expect, it } from 'vitest';
import { PineTS } from 'pinets';
import { runPineWorker } from '../apps/api/src/worker-client.js';
import { backtestResultAfter } from '../apps/web/src/lib/run-result-state.js';
import {
  buildHighDetailizationData,
  HOUR_MS,
  MINUTE_MS,
  TEN_MINUTES_MS,
} from '../packages/market-data/src/high-detailization.js';
import { attachHighBrokerReplay } from '../packages/pine-runtime/src/high-execution.js';
import {
  assertHighRunConfiguration,
  HighSafetyError,
  type HighSafetyErrorKind,
  type HighRunConfiguration,
} from '../packages/pine-runtime/src/high-safety.js';
import type { BacktestResponse, Candle, WorkerRequest } from '../packages/shared/src/contracts.js';
import { FIXTURE_A_START } from './fixtures/high-detailization.js';

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 60): Candle {
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime: openTime + HOUR_MS - 1,
    quoteAssetVolume: close * volume,
    numberOfTrades: volume,
    takerBuyBaseAssetVolume: volume / 2,
    takerBuyQuoteAssetVolume: close * volume / 2,
    ignore: 0,
  };
}

function flatHour(openTime: number, price: number): { parent: Candle; source: Candle[] } {
  const source = Array.from({ length: 60 }, (_, minute): Candle => ({
    ...candle(openTime + minute * MINUTE_MS, price, price, price, price, 1),
    closeTime: openTime + (minute + 1) * MINUTE_MS - 1,
    quoteAssetVolume: price,
    numberOfTrades: 1,
    takerBuyBaseAssetVolume: 0.5,
    takerBuyQuoteAssetVolume: price / 2,
  }));
  return { parent: candle(openTime, price, price, price, price), source };
}

function expandHour(
  openTime: number,
  ohlc: ReadonlyArray<readonly [number, number, number, number]>,
): { parent: Candle; source: Candle[] } {
  const source = ohlc.flatMap(([open, high, low, close], bucketIndex) => {
    const points = [open, open, high, high, low, low, close, close, close, close, close];
    return Array.from({ length: 10 }, (_, minuteIndex): Candle => {
      const minuteOpenTime = openTime + bucketIndex * TEN_MINUTES_MS + minuteIndex * MINUTE_MS;
      const minuteOpen = points[minuteIndex]!;
      const minuteClose = points[minuteIndex + 1]!;
      return {
        ...candle(
          minuteOpenTime,
          minuteOpen,
          Math.max(minuteOpen, minuteClose),
          Math.min(minuteOpen, minuteClose),
          minuteClose,
          1,
        ),
        closeTime: minuteOpenTime + MINUTE_MS - 1,
        quoteAssetVolume: minuteClose,
        numberOfTrades: 1,
        takerBuyBaseAssetVolume: 0.5,
        takerBuyQuoteAssetVolume: minuteClose / 2,
      };
    });
  });
  return {
    parent: candle(
      openTime,
      source[0]!.open,
      Math.max(...source.map((item) => item.high)),
      Math.min(...source.map((item) => item.low)),
      source.at(-1)!.close,
    ),
    source,
  };
}

const supportedConfiguration: HighRunConfiguration = {
  exchange: 'Binance',
  marketType: 'Spot',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  calcOnOrderFills: false,
  calcOnEveryTick: false,
  calcOnEveryHistoryTick: false,
  processOrdersOnClose: false,
};

function captureHighError(action: () => unknown): HighSafetyError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HighSafetyError);
    return error as HighSafetyError;
  }
  throw new Error('Expected HighSafetyError.');
}

async function expectHighRunFailure(
  source: string,
  parents: Candle[],
  sourceCandles: Candle[],
  kind: HighSafetyErrorKind,
): Promise<HighSafetyError> {
  const detailization = buildHighDetailizationData(parents, sourceCandles, { tickSize: 0.01 });
  const pine = new PineTS(parents as never, 'BINANCE:BTCUSDT', '60');
  const evidence = attachHighBrokerReplay(pine, detailization);
  try {
    await pine.run(source);
    evidence.assertFinalPendingOrdersSupported();
  } catch (error) {
    expect(error).toBeInstanceOf(HighSafetyError);
    expect(error).toMatchObject({ kind });
    return error as HighSafetyError;
  }
  throw new Error(`Expected ${kind}.`);
}

describe('High H4 fail-closed safety', () => {
  it('allows required minute replay for Binance USD-M perpetual parent bars', () => {
    expect(() => assertHighRunConfiguration({
      exchange: 'Binance', marketType: 'Perpetual', symbol: 'BTCUSDT', timeframe: '15m',
      barIndexOffset: 0, calcOnOrderFills: false, calcOnEveryTick: false,
      calcOnEveryHistoryTick: false, processOrdersOnClose: false,
    })).not.toThrow();
  });
  it('allows 0xArchive minute replay for a Hyperliquid parent timeframe above 1m', () => {
    expect(() => assertHighRunConfiguration({
      exchange: 'Hyperliquid',
      marketType: 'Perpetual',
      symbol: 'HYPE',
      timeframe: '15m',
      barIndexOffset: 0,
      calcOnOrderFills: false,
      calcOnEveryTick: false,
      calcOnEveryHistoryTick: false,
      processOrdersOnClose: false,
    })).not.toThrow();
  });

  it('rejects enhanced detailization for a 1m parent because no sub-minute source exists', () => {
    const error = captureHighError(() => assertHighRunConfiguration({
      exchange: 'Hyperliquid',
      marketType: 'Perpetual',
      symbol: 'HYPE',
      timeframe: '1m',
      barIndexOffset: 0,
      calcOnOrderFills: false,
      calcOnEveryTick: false,
      calcOnEveryHistoryTick: false,
      processOrdersOnClose: false,
    }));
    expect(error.kind).toBe('HIGH_UNSUPPORTED_TIMEFRAME');
  });

  it('F01 rejects a 4h parent timeframe before execution', () => {
    const error = captureHighError(() => assertHighRunConfiguration({ ...supportedConfiguration, timeframe: '4h' }));
    expect(error.kind).toBe('HIGH_UNSUPPORTED_TIMEFRAME');
  });

  it('F02 rejects a symbol outside Binance Spot BTCUSDT before execution', () => {
    const error = captureHighError(() => assertHighRunConfiguration({ ...supportedConfiguration, symbol: 'ETHUSDT' }));
    expect(error.kind).toBe('HIGH_UNSUPPORTED_SYMBOL');
  });

  it('rejects synthetic bar_index prehistory in High instead of misaligning replay bars', () => {
    const error = captureHighError(() => assertHighRunConfiguration({ ...supportedConfiguration, barIndexOffset: 12 }));
    expect(error.kind).toBe('HIGH_UNSUPPORTED_BAR_INDEX_OFFSET');
  });

  it('F03 rejects On order fill', () => {
    const error = captureHighError(() => assertHighRunConfiguration({ ...supportedConfiguration, calcOnOrderFills: true }));
    expect(error.kind).toBe('HIGH_UNSUPPORTED_SCRIPT_EXECUTION');
  });

  it('F04 rejects On history bar tick', () => {
    const error = captureHighError(() => assertHighRunConfiguration({ ...supportedConfiguration, calcOnEveryHistoryTick: true }));
    expect(error.kind).toBe('HIGH_UNSUPPORTED_SCRIPT_EXECUTION');
  });

  it('F05 rejects stop-limit orders instead of approximating them', async () => {
    const first = flatHour(FIXTURE_A_START, 100);
    const second = flatHour(FIXTURE_A_START + HOUR_MS, 100);
    await expectHighRunFailure(`
//@version=6
strategy("H4 F05", overlay=false)
if bar_index == 0
    strategy.entry("STOP_LIMIT", strategy.long, stop=101, limit=99)
`, [first.parent, second.parent], [...first.source, ...second.source], 'HIGH_UNSUPPORTED_ORDER_FEATURE');
  });

  it('F06 rejects trailing stops instead of leaving them silently pending', async () => {
    const first = flatHour(FIXTURE_A_START, 100);
    const second = flatHour(FIXTURE_A_START + HOUR_MS, 100);
    await expectHighRunFailure(`
//@version=6
strategy("H4 F06", overlay=false)
if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("TRAIL", "L", trail_points=10, trail_offset=5)
`, [first.parent, second.parent], [...first.source, ...second.source], 'HIGH_UNSUPPORTED_ORDER_FEATURE');
  });

  it('F07 rejects partial exits instead of publishing partial-fill accounting', async () => {
    const first = flatHour(FIXTURE_A_START, 100);
    const second = flatHour(FIXTURE_A_START + HOUR_MS, 100);
    await expectHighRunFailure(`
//@version=6
strategy("H4 F07", overlay=false)
if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("HALF", "L", limit=105, qty_percent=50)
`, [first.parent, second.parent], [...first.source, ...second.source], 'HIGH_UNSUPPORTED_ORDER_FEATURE');
  });

  it('rejects OCA order groups instead of filling siblings independently', async () => {
    const first = flatHour(FIXTURE_A_START, 100);
    const second = flatHour(FIXTURE_A_START + HOUR_MS, 100);
    await expectHighRunFailure(`
//@version=6
strategy("H4 OCA", overlay=false)
if bar_index == 0
    strategy.entry("UP", strategy.long, stop=101, oca_name="BREAKOUT", oca_type=strategy.oca.cancel)
    strategy.entry("DOWN", strategy.short, stop=99, oca_name="BREAKOUT", oca_type=strategy.oca.cancel)
`, [first.parent, second.parent], [...first.source, ...second.source], 'HIGH_UNSUPPORTED_ORDER_FEATURE');
  });

  it('rejects final-bar immediately=true instead of silently leaving the position open', async () => {
    const first = flatHour(FIXTURE_A_START, 100);
    const second = flatHour(FIXTURE_A_START + HOUR_MS, 120);
    await expectHighRunFailure(`
//@version=6
strategy("H4 immediate close", overlay=false)
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.close("L", immediately=true)
`, [first.parent, second.parent], [...first.source, ...second.source], 'HIGH_UNSUPPORTED_ORDER_FEATURE');
  });

  it('F08 stops when an intrabar price would require a margin call', async () => {
    const first = flatHour(FIXTURE_A_START, 100);
    const adverse = expandHour(FIXTURE_A_START + HOUR_MS, [
      [100, 100, 100, 100],
      [100, 250, 100, 200],
      [200, 200, 200, 200],
      [200, 200, 200, 200],
      [200, 200, 200, 200],
      [200, 200, 200, 200],
    ]);
    const error = await expectHighRunFailure(`
//@version=6
strategy("H4 F08", overlay=false, initial_capital=1000, default_qty_type=strategy.fixed, default_qty_value=5, margin_short=100)
if bar_index == 0
    strategy.entry("S", strategy.short)
`, [first.parent, adverse.parent], [...first.source, ...adverse.source], 'HIGH_MARGIN_CALL_UNSUPPORTED');
    expect(error.details).toMatchObject({ price: 250 });
  });

  it('stops when a margin breach happens before a stop flattens the position on the same replay point', async () => {
    const first = flatHour(FIXTURE_A_START, 100);
    const adverse = expandHour(FIXTURE_A_START + HOUR_MS, [
      [100, 100, 100, 100],
      [100, 100, 50, 50],
      [50, 50, 50, 50],
      [50, 50, 50, 50],
      [50, 50, 50, 50],
      [50, 50, 50, 50],
    ]);
    const error = await expectHighRunFailure(`
//@version=6
strategy("margin before stop", overlay=false, initial_capital=100, default_qty_type=strategy.fixed, default_qty_value=2, margin_long=50)
if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("SL", "L", stop=80)
`, [first.parent, adverse.parent], [...first.source, ...adverse.source], 'HIGH_MARGIN_CALL_UNSUPPORTED');
    expect(error.details).toMatchObject({
      price: 50,
      phase: 'before-order-fills',
      requiredMargin: 50,
    });
  });

  it('F09 clears an older successful result on start and keeps it cleared after failure', () => {
    const previous = { runId: 'old-result' } as BacktestResponse;
    const running = backtestResultAfter(previous, { type: 'run-started' });
    expect(running).toBeNull();
    expect(backtestResultAfter(running, { type: 'run-failed-or-stopped' })).toBeNull();
  });

  it('F10 terminates timeout/abort paths without returning a partial result', async () => {
    const oneHour = flatHour(FIXTURE_A_START, 100).parent;
    const payload: WorkerRequest = {
      source: '//@version=6\nstrategy("H4 F10")',
      candles: [oneHour],
      barIndexOffset: 0,
      market: {
        tickerId: 'HYPERLIQUID:BTCUSDC.P',
        symbol: 'BTC',
        timeframe: '1h',
        pineTimeframe: '60',
        mintick: 0.1,
        minContract: 0.00001,
      },
      execution: {
        initialCapital: 100_000,
        defaultOrderSizeValue: 1,
        defaultOrderSizeType: 'fixed',
        pyramiding: 1,
        commissionType: 'percent',
        commissionValue: 0,
        slippageTicks: 0,
      },
    };

    await expect(runPineWorker(payload, undefined, { timeoutMs: 0 }))
      .rejects.toThrow('Backtest exceeded the 0 ms worker limit.');

    const controller = new AbortController();
    controller.abort();
    await expect(runPineWorker(payload, controller.signal, { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'Backtest was stopped.' });
  });
});
