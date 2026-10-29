import { describe, expect, it } from 'vitest';
import { Indicator, PineHistoryLimitError, PineTS } from 'pinets';

import { runPineWorker } from '../apps/api/src/worker-client.js';
import { toPineSessionCandles } from '../packages/pine-runtime/src/bar-index-origin.js';
import { normalizeStrategy } from '../packages/pine-runtime/src/normalize.js';
import { aggregateCandles, seriesWindow, type SeriesRequest } from '../packages/pine-runtime/src/series-requests.js';
import { pineSymbolInfo } from '../packages/pine-runtime/src/symbol-info.js';
import type { Candle, WorkerRequest } from '../packages/shared/src/contracts.js';

const M5 = 5 * 60_000;
const DAY = 24 * 60 * 60_000;
const START = Date.UTC(2026, 6, 29);
const market = {
  tickerId: 'BINANCE:BTCUSDT.P', symbol: 'BTCUSDT', exchange: 'Binance' as const, quoteCurrency: 'USDT' as const,
  timeframe: '5m' as const, pineTimeframe: '5', mintick: 0.1, minContract: 0.001,
};

/** A deterministic random walk of 5-minute candles. */
function fiveMinuteCandles(count: number): Candle[] {
  let seed = 7;
  let price = 60_000;
  return Array.from({ length: count }, (_, index) => {
    const open = price;
    const moves = Array.from({ length: 4 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return (seed / 2_147_483_648 - 0.5) * 0.004;
    });
    price = Math.round(price * (1 + moves[0]!) * 10) / 10;
    const openTime = START + index * M5;
    return {
      openTime, open, close: price,
      high: Math.max(open, price) * (1 + Math.abs(moves[1]!) / 2), low: Math.min(open, price) * (1 - Math.abs(moves[2]!) / 2),
      volume: 1 + Math.abs(moves[3]!) * 1_000, closeTime: openTime + M5 - 1,
      quoteAssetVolume: price, numberOfTrades: 10, takerBuyBaseAssetVolume: 0.5, takerBuyQuoteAssetVolume: price / 2, ignore: 0,
    };
  });
}

/** Daily candles of the same walk, as the API serves request.security. */
function dailySeries(candles: Candle[]) {
  return async (request: SeriesRequest) => {
    const window = seriesWindow(request);
    const inside = candles.filter((candle) => candle.openTime >= window.startInclusive && candle.openTime < window.endExclusive);
    return aggregateCandles(inside, DAY, DAY / M5, { allowSparse: true });
  };
}

function workerRequest(source: string, candles: Candle[]): WorkerRequest {
  return {
    source, candles, barIndexOffset: 0, market,
    execution: {
      initialCapital: 1_000, defaultOrderSizeValue: 10, defaultOrderSizeType: 'percent_of_equity', pyramiding: 1,
      commissionType: 'percent', commissionValue: 0.04, slippagePercent: 0.2, processOrdersOnClose: true,
    },
  };
}

/** The strategy's closed trades from an in-process PineTS run, optionally with a history limit. */
async function runInProcess(source: string, candles: Candle[], historyLimit?: number) {
  const input = toPineSessionCandles(candles);
  const series = dailySeries(candles);
  const provider = {
    async getMarketData(_tickerId: string, timeframe?: string, limit?: number, sDate?: number, eDate?: number) {
      if (!timeframe || timeframe === market.pineTimeframe) return input;
      const end = Math.min(eDate ?? Infinity, input.at(-1)!.closeTime);
      return toPineSessionCandles(await series({ timeframe, timeframeMs: DAY, startInclusive: sDate, endExclusive: end, limit }));
    },
    async getSymbolInfo() { return pineSymbolInfo(market); },
    configure() {},
  };
  const pine = new PineTS(provider as never, market.tickerId, market.pineTimeframe);
  if (historyLimit !== undefined) {
    pine.setHistoryLimit(historyLimit);
    pine.setPlotHistory(false);
  }
  // The worker's settings for workerRequest(), so both runs trade alike.
  const indicator = new Indicator(source);
  const { execution } = workerRequest(source, candles);
  Object.assign(indicator.prop, {
    initial_capital: execution.initialCapital, default_qty_type: execution.defaultOrderSizeType,
    default_qty_value: execution.defaultOrderSizeValue, pyramiding: execution.pyramiding,
    commission_type: execution.commissionType, commission_value: execution.commissionValue,
    slippage: 0, slippage_percent: execution.slippagePercent, process_orders_on_close: execution.processOrdersOnClose,
    calc_on_order_fills: false, calc_on_every_tick: false, backtest_fill_limits_assumption: 0, use_bar_magnifier: false,
  });
  const context = await pine.run(indicator) as unknown as { strategy: Parameters<typeof normalizeStrategy>[0] };
  return normalizeStrategy(context.strategy);
}

// Shaped like a strategy port of "Gann Angles With Volatility" (pbghosh): daily closes through
// request.security with lookahead, one-line helper functions called many times per bar, helper
// functions that build and loop over an array on every bar, and many plots.
const GANN_SHAPED = `//@version=5
strategy("Gann-shaped levels", overlay=true)
dOpen = request.security(syminfo.tickerid, "D", open, lookahead=barmerge.lookahead_on)
dHigh = request.security(syminfo.tickerid, "D", high[1], lookahead=barmerge.lookahead_on)
dLow = request.security(syminfo.tickerid, "D", low[1], lookahead=barmerge.lookahead_on)
c1 = request.security(syminfo.tickerid, "D", close[1], lookahead=barmerge.lookahead_on)
c2 = request.security(syminfo.tickerid, "D", close[2], lookahead=barmerge.lookahead_on)
c3 = request.security(syminfo.tickerid, "D", close[3], lookahead=barmerge.lookahead_on)
c4 = request.security(syminfo.tickerid, "D", close[4], lookahead=barmerge.lookahead_on)
c5 = request.security(syminfo.tickerid, "D", close[5], lookahead=barmerge.lookahead_on)
c6 = request.security(syminfo.tickerid, "D", close[6], lookahead=barmerge.lookahead_on)
c7 = request.security(syminfo.tickerid, "D", close[7], lookahead=barmerge.lookahead_on)
c8 = request.security(syminfo.tickerid, "D", close[8], lookahead=barmerge.lookahead_on)
c9 = request.security(syminfo.tickerid, "D", close[9], lookahead=barmerge.lookahead_on)
c10 = request.security(syminfo.tickerid, "D", close[10], lookahead=barmerge.lookahead_on)
base = dOpen > dHigh or dOpen < dLow ? dOpen : c1
r1 = math.log(base / c2)
r2 = math.log(c2 / c3)
r3 = math.log(c3 / c4)
r4 = math.log(c4 / c5)
r5 = math.log(c5 / c6)
r6 = math.log(c6 / c7)
r7 = math.log(c7 / c8)
r8 = math.log(c8 / c9)
r9 = math.log(c9 / c10)
totLn = r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8 + r9
totLnSqr = r1 * r1 + r2 * r2 + r3 * r3 + r4 * r4 + r5 * r5 + r6 * r6 + r7 * r7 + r8 * r8 + r9 * r9
sq = math.sqrt(math.sqrt(totLnSqr / 9 - math.pow(totLn / 9, 2)) * base)
up(b, angle) => b + math.pow(sq + angle / 180, 2) * angle / 180
down(b, angle) => b - math.pow(sq - angle / 180, 2) * angle / 180
buyAbove = up(base, 15.0)
sellBelow = down(base, 15.0)
res1 = up(base, 45.0)
sup1 = down(base, 45.0)
h1 = up(base, 86.25)
l1 = down(base, 86.25)
res2 = up(h1, 45.0)
sup2 = down(l1, 45.0)
h2 = up(h1, 86.25)
l2 = down(l1, 86.25)
res3 = up(h2, 45.0)
sup3 = down(l2, 45.0)
h3 = up(h2, 86.25)
l3 = down(l2, 86.25)
res4 = up(h3, 45.0)
sup4 = down(l3, 45.0)
h4 = up(h3, 86.25)
l4 = down(l3, 86.25)
res5 = up(h4, 45.0)
sup5 = down(l4, 45.0)
crossedUp() =>
    levels = array.from(res1, res2, res3, res4, res5)
    hit = false
    for i = 0 to array.size(levels) - 1
        lvl = array.get(levels, i)
        if open < lvl and close > lvl
            hit := true
    hit
crossedDown() =>
    levels = array.from(sup1, sup2, sup3, sup4, sup5)
    hit = false
    for i = 0 to array.size(levels) - 1
        lvl = array.get(levels, i)
        if open > lvl and close < lvl
            hit := true
    hit
if close > buyAbove and crossedUp() and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
    strategy.exit("Long exit", "Long", stop=low, limit=res5)
if close < sellBelow and crossedDown() and strategy.position_size == 0
    strategy.entry("Short", strategy.short)
    strategy.exit("Short exit", "Short", stop=high, limit=sup5)
plot(buyAbove, "Buy Above")
plot(sellBelow, "Sell Below")
plot(res1, "Res 1")
plot(res2, "Res 2")
plot(res3, "Res 3")
plot(res4, "Res 4")
plot(res5, "Res 5")
plot(sup1, "Sup 1")
plot(sup2, "Sup 2")
plot(sup3, "Sup 3")
plot(sup4, "Sup 4")
plot(sup5, "Sup 5")
plot(h1, "H1")
plot(h2, "H2")
plot(h3, "H3")
plot(h4, "H4")
plot(l1, "L1")
plot(l2, "L2")
plot(l3, "L3")
plot(l4, "L4")
plot(base, "Base")
plot(sq, "Sq")
plot(totLn, "Ln")
plot(totLnSqr, "Ln2")
plot(dOpen, "Day open")
`;

// Reads a script variable 5,200 bars back, past the worker's 5,000-bar history limit.
const DEEP_LOOKBACK = `//@version=5
strategy("Deep lookback", overlay=true)
level = close * 1
farMove = level[5200] - level[5201]
if farMove > 0 and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
if farMove < 0
    strategy.close("Long")
`;

describe('Pine history limit', () => {
  it('runs a Gann-shaped strategy over 26,000 5-minute bars in a 160 MB worker heap', async () => {
    // 2026-07-29..2026-10-29, as in the run that ran out of memory. With every bar of every
    // series and plot kept this script needs more than 256 MB.
    const candles = fiveMinuteCandles(92 * 288);
    const result = await runPineWorker(workerRequest(GANN_SHAPED, candles), undefined, {
      memoryMb: 160, timeoutMs: 120_000, loadSeries: dailySeries(candles),
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.trades.length).toBeGreaterThan(50);
  }, 180_000);

  it('gives the same trades with a short history as with the whole history', async () => {
    const candles = fiveMinuteCandles(20 * 288);
    const whole = await runInProcess(GANN_SHAPED, candles);
    const limited = await runInProcess(GANN_SHAPED, candles, 100);
    expect(whole.trades.length).toBeGreaterThan(10);
    expect(limited).toEqual(whole);
  });

  it('stops on a read of a dropped bar instead of returning na', async () => {
    const source = `//@version=5
strategy("Lookback 150", overlay=true)
level = close * 1
if level[150] > 0 and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
`;
    // Before bar 150 the read is simply before the first bar: na, no error.
    await expect(runInProcess(source, fiveMinuteCandles(140), 100)).resolves.toBeDefined();
    const error = await runInProcess(source, fiveMinuteCandles(400), 100).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PineHistoryLimitError);
    expect(error).toMatchObject({ lookback: 150, limit: 100 });
  });

  it('finds pivots of a script variable after its oldest bars were dropped', async () => {
    const source = `//@version=5
strategy("Pivots", overlay=true)
level = (high + low) / 2
ph = ta.pivothigh(level, 3, 3)
pl = ta.pivotlow(level, 3, 3)
if not na(pl) and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
if not na(ph)
    strategy.close("Long")
`;
    const candles = fiveMinuteCandles(1_500);
    const whole = await runInProcess(source, candles);
    expect(whole.trades.length).toBeGreaterThan(20);
    expect(await runInProcess(source, candles, 100)).toEqual(whole);
  });

  it('runs a script that reads past the limit again with its whole history', async () => {
    // Enough bars for the worker to drop history before the script reads 5,200 bars back.
    const candles = fiveMinuteCandles(7_000);
    const expected = await runInProcess(DEEP_LOOKBACK, candles);
    expect(expected.trades.length).toBeGreaterThan(5);
    const result = await runPineWorker(workerRequest(DEEP_LOOKBACK, candles), undefined, { timeoutMs: 120_000 });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.trades).toEqual(expected.trades);
  }, 180_000);
});
