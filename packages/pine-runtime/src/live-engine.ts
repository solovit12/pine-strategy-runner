/**
 * Real-time Paper execution of an arbitrary Pine strategy.
 *
 * Pine is re-run from the same history origin after every closed bar. Bars
 * that closed before the Paper start keep the ordinary backtest emulator
 * (they only provide indicator/strategy state). From the start on, the
 * emulator is OFF: the only fills Pine sees are the real fills reported by
 * the Paper broker, injected at their executed price and time. After the
 * run, Pine's pending orders and open trades are exported for the broker.
 *
 * The engine never decides a fill itself and never consults backtest
 * results; it is deterministic for the same candles, settings and fills.
 */
import {
  Indicator, PineTS, restoreStrategyState, snapshotStrategyState, applyExternalStrategyFill,
  type StrategyBrokerReplayController, type StrategyExternalFill,
} from 'pinets';

import type { Candle } from '../../shared/src/contracts.js';
import { toPineSessionCandles } from './bar-index-origin.js';
import { UnsupportedPineFeatureError } from './pine-source-safety.js';
import { isChartSymbol } from './series-requests.js';
import { pineSymbolInfo, type PineSymbolMarket } from './symbol-info.js';
import { tradingViewStrategyDefaults } from './tradingview-defaults.js';

export interface PineLiveExecutionSettings {
  readonly initialCapital: number;
  readonly defaultOrderSizeValue: number;
  readonly defaultOrderSizeType: 'fixed' | 'cash' | 'percent_of_equity';
  readonly pyramiding: number;
  readonly commissionType: 'percent' | 'cash_per_contract' | 'cash_per_order';
  readonly commissionValue: number;
  readonly marginLongPercent?: number;
  readonly marginShortPercent?: number;
}

/** A fill reported by the Paper broker, in Pine terms. */
export interface PineLiveFill {
  readonly orderId: string;
  readonly category: 'entry' | 'exit';
  readonly price: number;
  /** Executed time, epoch ms. */
  readonly time: number;
  readonly leg?: 'market' | 'limit' | 'stop' | 'profit' | 'loss' | 'trail';
  /** Exits: Pine quantity this fill represents (default: the whole order). */
  readonly qty?: number;
  /** Exits of one trade: `${entryId}@${entryTime}` of the Pine trade. */
  readonly tradeKey?: string;
}

export interface PineLiveTrade {
  readonly key: string;
  readonly entryId: string;
  readonly side: 'long' | 'short';
  readonly qty: number;
  readonly entryPrice: number;
  /** Physical entry price used for profit/loss tick brackets. */
  readonly bracketEntryPrice: number;
  readonly entryTime: number;
  /** Opened before the Paper start (history emulator): never mirrored with real size. */
  readonly beforeStart: boolean;
}

/** Effect of filling a market-like order now, computed by Pine itself. */
export interface PineLiveOrderPlan {
  readonly accepted: boolean;
  readonly closes: ReadonlyArray<{ readonly tradeKey: string; readonly qty: number }>;
  readonly opensSide: 'long' | 'short' | null;
  readonly opensQty: number;
}

export interface PineLiveOrder {
  readonly id: string;
  readonly category: 'entry' | 'exit';
  readonly type: 'market' | 'limit' | 'stop' | 'stop-limit';
  /** Entries: order direction. Exits: resolved from the matching trades. */
  readonly side: 'long' | 'short' | null;
  readonly limit?: number;
  readonly stop?: number;
  readonly placedTime: number;
  readonly oca?: { readonly name: string; readonly type: 'cancel' | 'reduce' };
  // strategy.exit brackets
  readonly fromEntry?: string;
  readonly profitTicks?: number;
  readonly lossTicks?: number;
  readonly trailPrice?: number;
  readonly trailPointsTicks?: number;
  readonly trailOffsetTicks?: number;
  /** Remaining Pine quantity the exit may still close (null: all matching). */
  readonly qtyCap: number | null;
  readonly qtyPercent?: number;
  /** Trades this exit applies to, in Pine FIFO order. */
  readonly tradeKeys: readonly string[];
  /** Market-like orders (entries, close/close_all): what Pine would do on a fill now. */
  readonly plan?: PineLiveOrderPlan;
  readonly comment?: string;
}

export interface PineLiveFillOutcome {
  readonly fill: PineLiveFill;
  readonly applied: boolean;
  readonly reason?: string;
}

export interface PineLiveRunResult {
  /** Exclusive end (ms) of the last closed bar that Pine evaluated. */
  readonly barCloseMs: number;
  readonly lastClose: number;
  readonly positionSize: number;
  readonly trades: PineLiveTrade[];
  readonly orders: PineLiveOrder[];
  readonly fillOutcomes: PineLiveFillOutcome[];
  readonly closedTradesSinceStart: number;
  readonly netProfitSinceStart: number;
  readonly unsupported: string[];
}

export interface PineLiveRunInput {
  readonly source: string;
  readonly market: PineSymbolMarket & { readonly pineTimeframe: string };
  readonly execution: PineLiveExecutionSettings;
  /** Closed candles in exchange convention (inclusive closeTime), ascending, gap-free. */
  readonly candles: readonly Candle[];
  /** Paper start, epoch ms. Bars ending at or before it use the history emulator. */
  readonly startMs: number;
  /** Real fills, any order; applied in time order inside their bars. */
  readonly fills: readonly PineLiveFill[];
  /** Candles of another timeframe for request.security; absent means unsupported. */
  readonly series?: (tickerId: string | undefined, timeframe: string, limit?: number) => Promise<readonly Candle[]>;
}

const EPS = 1e-9;

export function pineTradeKey(trade: { entry_id: string; entry_time: number }): string {
  return `${trade.entry_id}@${trade.entry_time}`;
}

function sideOf(size: number): 'long' | 'short' { return size > 0 ? 'long' : 'short'; }

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function runPineLive(input: PineLiveRunInput): Promise<PineLiveRunResult> {
  if (input.candles.length === 0) throw new Error('Pine live run needs at least one closed candle.');
  const candles = toPineSessionCandles([...input.candles]);
  const symbolInfo = pineSymbolInfo(input.market);
  let seriesFailure: Error | null = null;
  // PineTS never settles a run whose secondary load failed; that failure ends the run.
  let failRun: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => { failRun = reject; });
  failed.catch(() => undefined);
  const source = {
    async getMarketData(tickerId?: string, timeframe?: string, limit?: number) {
      const chartSymbol = isChartSymbol(tickerId, input.market.symbol) || isChartSymbol(tickerId, input.market.tickerId);
      if (chartSymbol && (!timeframe || timeframe === input.market.pineTimeframe)) return candles;
      try {
        if (!input.series) throw new UnsupportedPineFeatureError('request.security');
        return toPineSessionCandles([...await input.series(tickerId, timeframe!, limit)]);
      } catch (error) {
        seriesFailure ??= error instanceof Error ? error : new Error(String(error));
        failRun(seriesFailure);
        throw error;
      }
    },
    async getSymbolInfo() { return symbolInfo; },
    configure() {},
  };
  const pine = new PineTS(source as never, input.market.tickerId, input.market.pineTimeframe);
  const indicator = new Indicator(input.source);
  const defaults = tradingViewStrategyDefaults(input.source);
  const execution = input.execution;
  indicator.prop.initial_capital = execution.initialCapital;
  indicator.prop.default_qty_type = execution.defaultOrderSizeType;
  indicator.prop.default_qty_value = execution.defaultOrderSizeValue;
  indicator.prop.pyramiding = execution.pyramiding;
  indicator.prop.commission_type = execution.commissionType;
  indicator.prop.commission_value = execution.commissionValue;
  // Real fills carry their own price; synthetic slippage is meaningless here.
  indicator.prop.slippage = 0;
  indicator.prop.slippage_percent = 0;
  const marginLong = execution.marginLongPercent ?? defaults.marginLongPercent;
  const marginShort = execution.marginShortPercent ?? defaults.marginShortPercent;
  if (marginLong !== undefined) indicator.prop.margin_long = marginLong;
  if (marginShort !== undefined) indicator.prop.margin_short = marginShort;
  indicator.prop.calc_on_order_fills = false;
  indicator.prop.calc_on_every_tick = false;
  indicator.prop.backtest_fill_limits_assumption = 0;
  indicator.prop.process_orders_on_close = false;
  indicator.prop.use_bar_magnifier = false;

  const fills = [...input.fills].sort((left, right) => left.time - right.time);
  const outcomes: PineLiveFillOutcome[] = [];
  let fillIndex = 0;
  let strategyRef: any;
  let netProfitAtStart: number | null = null;
  let closedAtStart: number | null = null;

  pine.setStrategyBrokerReplayHook((controller: StrategyBrokerReplayController) => {
    strategyRef = controller.strategyState;
    const bar = currentBar(controller);
    if (bar.closeTime <= input.startMs) {
      controller.processDefault();
      return;
    }
    if (netProfitAtStart === null) {
      netProfitAtStart = strategyRef.netprofit;
      closedAtStart = strategyRef.closedtrades.length;
    }
    while (fillIndex < fills.length && fills[fillIndex]!.time < bar.openTime) {
      outcomes.push({ fill: fills[fillIndex]!, applied: false, reason: 'before_bar' });
      fillIndex += 1;
    }
    while (fillIndex < fills.length && fills[fillIndex]!.time < bar.closeTime) {
      const fill = fills[fillIndex]!;
      fillIndex += 1;
      const external: StrategyExternalFill = {
        orderId: fill.orderId, category: fill.category, price: fill.price, time: fill.time,
        ...(fill.leg === undefined ? {} : { leg: fill.leg }),
        ...(fill.qty === undefined ? {} : { qty: fill.qty }),
      };
      if (fill.tradeKey !== undefined) {
        const trade = strategyRef?.opentrades.find((candidate: any) => pineTradeKey(candidate) === fill.tradeKey);
        if (!trade) {
          outcomes.push({ fill, applied: false, reason: 'trade_not_open' });
          continue;
        }
        (external as { tradeId?: string }).tradeId = trade.id;
      }
      const result = controller.applyExternalFill(external);
      outcomes.push({ fill, applied: result.applied, ...(result.reason ? { reason: result.reason } : {}) });
    }
  });
  const context = await Promise.race([pine.run(indicator), failed]) as unknown as { strategy?: any; idx: number };
  // The engine does not always pass a failed secondary load on; never trade on a run without it.
  if (seriesFailure) throw seriesFailure;
  if (!context.strategy) throw new Error('The Pine script did not declare a strategy. Use strategy(...), not indicator(...).');
  while (fillIndex < fills.length) {
    outcomes.push({ fill: fills[fillIndex]!, applied: false, reason: 'after_last_bar' });
    fillIndex += 1;
  }
  return exportState(context, input, candles, outcomes, netProfitAtStart, closedAtStart);

  function currentBar(controller: StrategyBrokerReplayController) {
    const candle = candles[controller.parentBarIndex];
    if (!candle) throw new Error('Pine live hook bar is outside the candle input.');
    return candle;
  }
}

function exportState(
  context: { strategy?: any; idx: number },
  input: PineLiveRunInput,
  candles: readonly Candle[],
  fillOutcomes: PineLiveFillOutcome[],
  netProfitAtStart: number | null,
  closedAtStart: number | null,
): PineLiveRunResult {
  const strategy = context.strategy;
  const last = candles[candles.length - 1]!;
  const trades: PineLiveTrade[] = strategy.opentrades.map((trade: any) => ({
    key: pineTradeKey(trade),
    entryId: trade.entry_id,
    side: sideOf(trade.size),
    qty: Math.abs(trade.size),
    entryPrice: trade.entry_price,
    bracketEntryPrice: trade._bracket_entry ?? trade.entry_price,
    entryTime: trade.entry_time,
    beforeStart: trade.entry_time < input.startMs,
  }));
  const unsupported: string[] = [];
  const orders: PineLiveOrder[] = [];
  // Plans simulate fills on the live ledger and roll back; iterate a stable
  // copy and look each order up again after every rollback.
  const pendingIds: Array<{ id: string; category: string }> = strategy.pending_orders
    .filter((order: any) => order.status === 'pending')
    .map((order: any) => ({ id: order.id, category: order.category ?? 'entry' }));
  for (const ref of pendingIds) {
    const order = strategy.pending_orders.find((candidate: any) =>
      candidate.id === ref.id && (candidate.category ?? 'entry') === ref.category && candidate.status === 'pending');
    if (!order) throw new Error(`Pine live export lost pending order ${ref.id}.`);
    const category: 'entry' | 'exit' = order.category ?? 'entry';
    const matching = category === 'exit'
      ? strategy.opentrades.filter((trade: any) => matchesExit(order, trade))
      : [];
    const conditional = category === 'exit' && (
      order.profit !== undefined || order.loss !== undefined || order.limit !== undefined || order.stop !== undefined
      || order.trail_price !== undefined || order.trail_points !== undefined);
    const ocaType = order.oca_type === 'cancel' || order.oca_type === 'reduce' ? order.oca_type : undefined;
    const remaining = (order as any)._replay_remaining_qty as number | undefined;
    const qtyCap = remaining !== undefined ? remaining : order.qty > 0 ? order.qty : null;
    const side = category === 'entry'
      ? (order.direction > 0 ? 'long' : 'short')
      : matching.length > 0 ? sideOf(matching[0].size) : null;
    if ((order.trail_price !== undefined || order.trail_points !== undefined) && order.trail_offset === undefined) {
      unsupported.push(`${order.id}: trailing stop without trail_offset`);
    }
    const exported: PineLiveOrder = {
      id: order.id,
      category,
      type: order.type,
      side,
      ...(finite(order.limit) === undefined ? {} : { limit: order.limit }),
      ...(finite(order.stop) === undefined ? {} : { stop: order.stop }),
      placedTime: order.time,
      ...(order.oca_name && ocaType ? { oca: { name: order.oca_name, type: ocaType } } : {}),
      ...(category === 'exit' && order.from_entry ? { fromEntry: order.from_entry } : {}),
      ...(finite(order.profit) === undefined ? {} : { profitTicks: order.profit }),
      ...(finite(order.loss) === undefined ? {} : { lossTicks: order.loss }),
      ...(finite(order.trail_price) === undefined ? {} : { trailPrice: order.trail_price }),
      ...(finite(order.trail_points) === undefined ? {} : { trailPointsTicks: order.trail_points }),
      ...(finite(order.trail_offset) === undefined ? {} : { trailOffsetTicks: order.trail_offset }),
      qtyCap,
      ...(finite(order.qty_percent) === undefined ? {} : { qtyPercent: order.qty_percent }),
      tradeKeys: matching.map((trade: any) => pineTradeKey(trade)),
      ...(order.comment ? { comment: String(order.comment) } : {}),
    };
    orders.push(category === 'entry' || !conditional
      ? { ...exported, plan: simulatePlan(context, order, last.close, last.closeTime) }
      : exported);
  }
  return {
    barCloseMs: last.closeTime,
    lastClose: last.close,
    positionSize: strategy.position_size,
    trades,
    orders,
    fillOutcomes,
    closedTradesSinceStart: closedAtStart === null ? 0 : strategy.closedtrades.length - closedAtStart,
    netProfitSinceStart: netProfitAtStart === null ? 0 : strategy.netprofit - netProfitAtStart,
    unsupported,
  };
}

function matchesExit(order: any, trade: any): boolean {
  if (order._intended_trade_ids && !order._intended_trade_ids.includes(trade.id)) return false;
  return !order.from_entry || trade.entry_id === order.from_entry;
}

/** Ask Pine what a fill of this order at the last close would do, then roll back. */
function simulatePlan(context: { strategy?: any }, order: any, price: number, time: number): PineLiveOrderPlan {
  const strategy = context.strategy;
  const snapshot = snapshotStrategyState(strategy);
  const before = new Map<string, { trade: any; qty: number }>(
    strategy.opentrades.map((trade: any) => [pineTradeKey(trade), { trade, qty: Math.abs(trade.size) }]));
  try {
    const result = applyExternalStrategyFill(context, {
      orderId: order.id, category: order.category ?? 'entry', price, time,
    });
    if (!result.applied) return { accepted: false, closes: [], opensSide: null, opensQty: 0 };
    const after = new Map<string, number>(strategy.opentrades.map((trade: any) => [pineTradeKey(trade), Math.abs(trade.size)]));
    const closes: Array<{ tradeKey: string; qty: number }> = [];
    for (const [key, entry] of before) {
      const left = after.get(key) ?? 0;
      if (entry.qty - left > EPS) closes.push({ tradeKey: key, qty: entry.qty - left });
    }
    let opensSide: 'long' | 'short' | null = null;
    let opensQty = 0;
    for (const trade of strategy.opentrades) {
      const key = pineTradeKey(trade);
      if (!before.has(key)) {
        opensSide = sideOf(trade.size);
        opensQty += Math.abs(trade.size);
      }
    }
    return { accepted: true, closes, opensSide, opensQty };
  } finally {
    restoreStrategyState(strategy, snapshot);
  }
}
