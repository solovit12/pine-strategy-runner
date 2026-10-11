import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Indicator, PineTS } from 'pinets';
import { FrozenCsvMarketDataProvider } from './fixtures/frozen-csv-provider.js';
import { applyBarIndexOffset } from '../packages/pine-runtime/src/bar-index-origin.js';
import { normalizeStrategy } from '../packages/pine-runtime/src/normalize.js';
import { tradingViewStrategyDefaults } from '../packages/pine-runtime/src/tradingview-defaults.js';
import type { BacktestMetrics, Candle, NormalizedTrade } from '../packages/shared/src/contracts.js';

interface ExpectedSummary {
  id: string;
  strategyFile: string;
  pyramiding: number;
  netProfit: number;
  commissionPaid: number;
  maxDrawdownIntrabar: number;
  totalTrades: number;
  winners: number;
  winRatePercent: number;
  longTrades: number;
  shortTrades: number;
}

interface ExpectedTrade {
  direction: 'long' | 'short';
  entryTimeUtc: string;
  exitTimeUtc: string;
  entrySignal: string;
  exitSignal: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  netPnl: number;
  commission: number;
  durationBars: number;
}

const dataBase = 'binance-btcusdt-1h-20170817T040000Z-20260901T020000Z';
const provider = new FrozenCsvMarketDataProvider(
  fileURLToPath(new URL(`./fixtures/qualification/data/${dataBase}.csv`, import.meta.url)),
  fileURLToPath(new URL(`./fixtures/qualification/data/${dataBase}.metadata.json`, import.meta.url)),
);

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function selectedCandles(candles: Candle[], start: string, endInclusive: string): Candle[] {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endExclusive = Date.parse(`${endInclusive}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000;
  return candles.filter((candle) => candle.openTime >= startMs && candle.openTime < endExclusive);
}

async function runDefault(
  source: string,
  candles: Candle[],
  options: { quantity: number; pyramiding: number; commissionPercent: number; barIndexOffset?: number },
): Promise<{ metrics: BacktestMetrics; trades: NormalizedTrade[] }> {
  const defaults = tradingViewStrategyDefaults(source);
  const strategy = new Indicator(source);
  strategy.prop.initial_capital = 100_000;
  strategy.prop.default_qty_type = 'fixed';
  strategy.prop.default_qty_value = options.quantity;
  strategy.prop.pyramiding = options.pyramiding;
  strategy.prop.commission_type = 'percent';
  strategy.prop.commission_value = options.commissionPercent;
  strategy.prop.slippage = 0;
  if (defaults.marginLongPercent !== undefined) strategy.prop.margin_long = defaults.marginLongPercent;
  if (defaults.marginShortPercent !== undefined) strategy.prop.margin_short = defaults.marginShortPercent;
  strategy.prop.calc_on_order_fills = false;
  strategy.prop.calc_on_every_tick = false;
  strategy.prop.backtest_fill_limits_assumption = 0;
  strategy.prop.process_orders_on_close = false;
  strategy.prop.use_bar_magnifier = false;

  const input = applyBarIndexOffset(candles, options.barIndexOffset ?? 0);
  const pine = new PineTS(input as never, 'BINANCE:BTCUSDT', '60');
  const context = await pine.run(strategy) as any;
  return normalizeStrategy(context.strategy);
}

describe('H3 Default runtime regression', () => {
  let candles: Candle[];
  let summaries: ExpectedSummary[];
  let expectedTrades: Map<string, ExpectedTrade[]>;

  beforeAll(async () => {
    candles = (await provider.getSnapshot()).candles;
    summaries = JSON.parse(await readFile(
      new URL('./fixtures/qualification/expected/tradingview-summary.json', import.meta.url),
      'utf8',
    )).reports;
    const tradeReports = JSON.parse(await readFile(
      new URL('./fixtures/qualification/expected/tradingview-trades.json', import.meta.url),
      'utf8',
    )).reports as Array<{ id: string; trades: ExpectedTrade[] }>;
    expectedTrades = new Map(tradeReports.map((report) => [report.id, report.trades]));
  });

  it('R07 keeps the frozen Q01-Q07 Default summaries and trade ledgers unchanged', async () => {
    // The qualification suite intentionally keeps the complete public history:
    // Pine indicators warm up before START_TIME and Q07's global bar_index
    // origin is part of its explicit compatibility metadata.
    const window = candles;

    for (const expected of summaries) {
      const source = await readFile(
        new URL(`./fixtures/qualification/strategies/${expected.strategyFile.split('/').at(-1)}`, import.meta.url),
        'utf8',
      );
      const actual = await runDefault(source, window, {
        quantity: 0.01,
        pyramiding: expected.pyramiding,
        commissionPercent: 0.1,
        barIndexOffset: expected.id === 'Q07' ? 12 : 0,
      });

      expect(round2(actual.metrics.netProfit), `${expected.id} net PnL`).toBe(expected.netProfit);
      expect(round2(actual.metrics.commissionPaid), `${expected.id} commission`).toBe(expected.commissionPaid);
      expect(round2(actual.metrics.maxDrawdown), `${expected.id} max drawdown`).toBe(expected.maxDrawdownIntrabar);
      expect(actual.metrics.totalTrades, `${expected.id} trades`).toBe(expected.totalTrades);
      expect(round2(actual.metrics.winRatePercent), `${expected.id} win rate`).toBe(expected.winRatePercent);
      expect(actual.metrics.longTrades, `${expected.id} long trades`).toBe(expected.longTrades);
      expect(actual.metrics.shortTrades, `${expected.id} short trades`).toBe(expected.shortTrades);

      const wantedTrades = expectedTrades.get(expected.id) ?? [];
      expect(actual.trades, `${expected.id} normalized trade count`).toHaveLength(wantedTrades.length);
      actual.trades.forEach((trade, index) => {
        const wanted = wantedTrades[index]!;
        expect(trade.side, `${expected.id} trade ${index + 1} side`).toBe(wanted.direction);
        expect(trade.entryTime, `${expected.id} trade ${index + 1} entry time`).toBe(wanted.entryTimeUtc);
        expect(trade.exitTime, `${expected.id} trade ${index + 1} exit time`).toBe(wanted.exitTimeUtc);
        expect(trade.entrySignal, `${expected.id} trade ${index + 1} entry signal`).toBe(wanted.entrySignal);
        expect(trade.exitSignal, `${expected.id} trade ${index + 1} exit signal`).toBe(wanted.exitSignal);
        expect(trade.entryPrice, `${expected.id} trade ${index + 1} entry price`).toBeCloseTo(wanted.entryPrice, 8);
        // Q05 has eight documented one-tick (0.01 USDT) differences from TradingView.
        expect(Math.abs(trade.exitPrice - wanted.exitPrice), `${expected.id} trade ${index + 1} exit price`).toBeLessThanOrEqual(0.011);
        expect(trade.size, `${expected.id} trade ${index + 1} size`).toBeCloseTo(wanted.quantity, 12);
        expect(round2(trade.pnl), `${expected.id} trade ${index + 1} PnL`).toBe(wanted.netPnl);
        expect(round2(trade.commission), `${expected.id} trade ${index + 1} commission`).toBe(wanted.commission);
        expect(trade.durationBars, `${expected.id} trade ${index + 1} duration`).toBe(wanted.durationBars);
      });
    }
  }, 60_000);

  it('R07 keeps the frozen Q08 Default regression unchanged', async () => {
    const source = await readFile(
      new URL('./fixtures/qualification/strategies/08-high-low-channel.pine', import.meta.url),
      'utf8',
    );
    const expected = JSON.parse(await readFile(
      new URL('./fixtures/qualification/expected/high-low-channel-regression.json', import.meta.url),
      'utf8',
    )).frozenLocalRegression;
    const window = selectedCandles(candles, '2025-01-01', '2026-09-01');
    const actual = await runDefault(source, window, {
      quantity: 1,
      pyramiding: 1,
      commissionPercent: 0,
    });

    expect(actual.metrics.netProfit).toBeCloseTo(expected.netProfit, 8);
    expect(actual.metrics.openProfit).toBeCloseTo(expected.openProfit, 8);
    expect(actual.metrics.totalProfit).toBeCloseTo(expected.totalProfit, 8);
    expect(actual.metrics.maxDrawdown).toBeCloseTo(expected.maxDrawdown, 8);
    expect(actual.metrics.totalTrades).toBe(expected.totalTrades);
    expect(actual.metrics.winRatePercent).toBeCloseTo(expected.winRatePercent, 8);
  }, 60_000);
});
