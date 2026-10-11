import { Indicator, PineTS } from 'pinets';
import { applyBarIndexOffset, toPineSessionCandles } from '../../../packages/pine-runtime/src/bar-index-origin.js';
import { attachHighBrokerReplay } from '../../../packages/pine-runtime/src/high-execution.js';
import { HighSafetyError } from '../../../packages/pine-runtime/src/high-safety.js';
import { normalizeStrategy } from '../../../packages/pine-runtime/src/normalize.js';
import { pineSymbolInfo } from '../../../packages/pine-runtime/src/symbol-info.js';
import {
  assertNoUnsupportedExternalSeries,
  UnsupportedPineFeatureError,
} from '../../../packages/pine-runtime/src/pine-source-safety.js';
import { tradingViewStrategyDefaults } from '../../../packages/pine-runtime/src/tradingview-defaults.js';
import { BACKTEST_TIMEFRAME_MS, type WorkerRequest, type WorkerResponse } from '../../../packages/shared/src/contracts.js';

let handled = false;

process.on('message', async (message: WorkerRequest) => {
  if (handled) return;
  handled = true;
  let response: WorkerResponse;
  try {
    assertNoUnsupportedExternalSeries(message.source);
    const input = toPineSessionCandles(applyBarIndexOffset(
      message.candles,
      message.barIndexOffset,
      BACKTEST_TIMEFRAME_MS[message.market.timeframe],
    ));
    const symbolInfo = pineSymbolInfo(message.market);
    const source = {
      async getMarketData() { return input; },
      async getSymbolInfo() { return symbolInfo; },
      configure() {},
    };
    const pine = new PineTS(source as never, message.market.tickerId, message.market.pineTimeframe);
    const strategy = new Indicator(message.source);
    const defaults = tradingViewStrategyDefaults(message.source);
    strategy.prop.initial_capital = message.execution.initialCapital;
    strategy.prop.default_qty_type = message.execution.defaultOrderSizeType;
    strategy.prop.default_qty_value = message.execution.defaultOrderSizeValue;
    strategy.prop.pyramiding = message.execution.pyramiding;
    strategy.prop.commission_type = message.execution.commissionType;
    strategy.prop.commission_value = message.execution.commissionValue;
    strategy.prop.slippage = message.execution.slippageTicks;
    const appliedLegacyLongMargin = message.execution.marginLongPercent === undefined && defaults.marginLongPercent !== undefined;
    const appliedLegacyShortMargin = message.execution.marginShortPercent === undefined && defaults.marginShortPercent !== undefined;
    if (message.execution.marginLongPercent !== undefined) strategy.prop.margin_long = message.execution.marginLongPercent;
    else if (defaults.marginLongPercent !== undefined) strategy.prop.margin_long = defaults.marginLongPercent;
    if (message.execution.marginShortPercent !== undefined) strategy.prop.margin_short = message.execution.marginShortPercent;
    else if (defaults.marginShortPercent !== undefined) strategy.prop.margin_short = defaults.marginShortPercent;
    // PineTS 0.9.33 exposes these properties but does not implement their
    // execution loops yet. Force the supported model so the report is honest.
    strategy.prop.calc_on_order_fills = false;
    strategy.prop.calc_on_every_tick = false;
    strategy.prop.backtest_fill_limits_assumption = 0;
    strategy.prop.process_orders_on_close = false;
    strategy.prop.use_bar_magnifier = message.highReplay !== undefined;
    const highExecution = message.highReplay
      ? attachHighBrokerReplay(pine, message.highReplay, {
          retainAudit: false,
          deriveTicksFromBars: message.highReplay.deriveTicksFromBars === true,
          deriveTickSize: message.market.mintick,
        })
      : undefined;
    const context = await pine.run(strategy) as unknown as { strategy?: unknown };
    highExecution?.assertFinalPendingOrdersSupported();
    if (!context.strategy) throw new Error('The Pine script did not declare a strategy. Use strategy(...), not indicator(...).');
    response = {
      ok: true,
      ...normalizeStrategy(context.strategy as Parameters<typeof normalizeStrategy>[0]),
      resourceUsage: {
        maxRssKb: process.resourceUsage().maxRSS,
      },
      execution: {
        pineVersion: defaults.pineVersion,
        marginLongPercent: Number(strategy.prop.margin_long),
        marginShortPercent: Number(strategy.prop.margin_short),
        defaultOrderSizeValue: Number(strategy.prop.default_qty_value),
        defaultOrderSizeType: strategy.prop.default_qty_type as 'fixed' | 'cash' | 'percent_of_equity',
        pyramiding: Number(strategy.prop.pyramiding),
        commissionType: strategy.prop.commission_type as 'percent' | 'cash_per_contract' | 'cash_per_order',
        commissionValue: Number(strategy.prop.commission_value),
        slippageTicks: Number(strategy.prop.slippage),
        legacyMarginDefaultsApplied: appliedLegacyLongMargin || appliedLegacyShortMargin,
      },
    };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const kind = error instanceof HighSafetyError
      ? error.kind
      : error instanceof UnsupportedPineFeatureError
        ? error.kind
      : /parse|syntax|token|declaration/i.test(messageText) ? 'compile' : 'runtime';
    response = { ok: false, error: { message: messageText.slice(0, 2_000), kind } };
  }
  process.send?.(response, () => process.disconnect());
});
