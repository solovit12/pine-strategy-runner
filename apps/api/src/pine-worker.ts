import { Indicator, PineTS } from 'pinets';
import { applyBarIndexOffset, toPineSessionCandles } from '../../../packages/pine-runtime/src/bar-index-origin.js';
import { attachHighBrokerReplay } from '../../../packages/pine-runtime/src/high-execution.js';
import { HighSafetyError } from '../../../packages/pine-runtime/src/high-safety.js';
import { explainPineRuntimeError, PineCodeError, pineCodeError } from '../../../packages/pine-runtime/src/pine-errors.js';
import { normalizeStrategy } from '../../../packages/pine-runtime/src/normalize.js';
import { pineSymbolInfo } from '../../../packages/pine-runtime/src/symbol-info.js';
import { UnsupportedPineFeatureError } from '../../../packages/pine-runtime/src/pine-source-safety.js';
import {
  isChartSymbol,
  pineTimeframeMs,
  SeriesRequestError,
  type SeriesRequest,
} from '../../../packages/pine-runtime/src/series-requests.js';
import { tradingViewStrategyDefaults } from '../../../packages/pine-runtime/src/tradingview-defaults.js';
import { BACKTEST_TIMEFRAME_MS, type Candle, type WorkerFailure, type WorkerRequest, type WorkerResponse } from '../../../packages/shared/src/contracts.js';

let handled = false;
let replied = false;
/** A failed request.security load; the run must not report results built without it. */
let seriesFailure: Error | null = null;

function errorKind(error: unknown, messageText: string): WorkerFailure['error']['kind'] {
  return error instanceof HighSafetyError
    ? error.kind
    : error instanceof PineCodeError
      ? error.kind
    : error instanceof UnsupportedPineFeatureError || error instanceof SeriesRequestError
      ? error.kind
      : /parse|syntax|token|declaration/i.test(messageText) ? 'compile' : 'runtime';
}

function reply(response: WorkerResponse): void {
  if (replied) return;
  replied = true;
  process.send?.(response, () => process.disconnect());
}

// The engine loads secondary series without awaiting every promise; a failed load
// must still end the run with its own message instead of a crash.
process.on('unhandledRejection', (reason) => {
  const error = seriesFailure ?? (reason instanceof Error ? reason : new Error(String(reason)));
  reply({ ok: false, error: { message: error.message.slice(0, 2_000), kind: errorKind(error, error.message) } });
});

/** Candles of other timeframes are loaded by the API process (request.security). */
export interface SeriesRequestMessage { type: 'series-request'; id: number; request: SeriesRequest }
export interface SeriesResponseMessage { type: 'series-response'; id: number; candles?: Candle[]; error?: string }
const pendingSeries = new Map<number, { resolve: (candles: Candle[]) => void; reject: (error: Error) => void }>();
let nextSeriesId = 0;

function requestSeries(request: SeriesRequest): Promise<Candle[]> {
  const id = ++nextSeriesId;
  return new Promise((resolve, reject) => {
    pendingSeries.set(id, { resolve, reject });
    process.send?.({ type: 'series-request', id, request } satisfies SeriesRequestMessage);
  });
}

process.on('message', async (message: WorkerRequest | SeriesResponseMessage) => {
  if ('type' in message && message.type === 'series-response') {
    const pending = pendingSeries.get(message.id);
    pendingSeries.delete(message.id);
    if (message.candles) pending?.resolve(message.candles);
    else pending?.reject(new SeriesRequestError(message.error ?? 'Candles for request.security are unavailable.'));
    return;
  }
  if (handled) return;
  handled = true;
  let response: WorkerResponse;
  try {
    message = message as WorkerRequest;
    const input = toPineSessionCandles(applyBarIndexOffset(
      message.candles,
      message.barIndexOffset,
      BACKTEST_TIMEFRAME_MS[message.market.timeframe],
    ));
    const symbolInfo = pineSymbolInfo(message.market);
    const chartEnd = input.at(-1)?.closeTime ?? 0;
    // PineTS never settles a run whose secondary load failed; that failure ends the run.
    let failRun: (error: Error) => void = () => undefined;
    const failed = new Promise<never>((_, reject) => { failRun = reject; });
    failed.catch(() => undefined);
    const market = message.market;
    const source = {
      async getMarketData(tickerId?: string, timeframe?: string, limit?: number, sDate?: number, eDate?: number) {
        try {
          const chartSymbol = isChartSymbol(tickerId, market.symbol) || isChartSymbol(tickerId, market.tickerId);
          if (chartSymbol && (!timeframe || timeframe === market.pineTimeframe)) return input;
          if (!chartSymbol) throw new UnsupportedPineFeatureError(`request.security for another symbol (${tickerId})`);
          const timeframeMs = pineTimeframeMs(timeframe!);
          if (timeframeMs === null) throw new UnsupportedPineFeatureError(`request.security on the "${timeframe}" timeframe`);
          const candles = await requestSeries({
            timeframe: timeframe!, timeframeMs, startInclusive: sDate, endExclusive: Math.min(eDate ?? chartEnd, chartEnd), limit,
          });
          return toPineSessionCandles(candles);
        } catch (error) {
          seriesFailure ??= error instanceof Error ? error : new Error(String(error));
          failRun(seriesFailure);
          throw error;
        }
      },
      async getSymbolInfo() { return symbolInfo; },
      configure() {},
    };
    // A code mistake is explained before the engine reads the declaration, which would
    // otherwise report it as "[Indicator.prop] unknown key".
    const codeError = pineCodeError(message.source);
    if (codeError) throw codeError;
    const pine = new PineTS(source as never, message.market.tickerId, message.market.pineTimeframe);
    const strategy = new Indicator(message.source);
    const defaults = tradingViewStrategyDefaults(message.source);
    strategy.prop.initial_capital = message.execution.initialCapital;
    strategy.prop.default_qty_type = message.execution.defaultOrderSizeType;
    strategy.prop.default_qty_value = message.execution.defaultOrderSizeValue;
    strategy.prop.pyramiding = message.execution.pyramiding;
    strategy.prop.commission_type = message.execution.commissionType;
    strategy.prop.commission_value = message.execution.commissionValue;
    // The form's percent replaces the script's own slippage ticks.
    strategy.prop.slippage = 0;
    strategy.prop.slippage_percent = message.execution.slippagePercent;
    const appliedLegacyLongMargin = message.execution.marginLongPercent === undefined && defaults.marginLongPercent !== undefined;
    const appliedLegacyShortMargin = message.execution.marginShortPercent === undefined && defaults.marginShortPercent !== undefined;
    if (message.execution.marginLongPercent !== undefined) strategy.prop.margin_long = message.execution.marginLongPercent;
    else if (defaults.marginLongPercent !== undefined) strategy.prop.margin_long = defaults.marginLongPercent;
    if (message.execution.marginShortPercent !== undefined) strategy.prop.margin_short = message.execution.marginShortPercent;
    else if (defaults.marginShortPercent !== undefined) strategy.prop.margin_short = defaults.marginShortPercent;
    // PineTS exposes these properties but does not implement their
    // execution loops yet. Force the supported model so the report is honest.
    // process_orders_on_close is the script's own choice: PineTS fills those
    // orders at the bar close, after the minute replay of earlier orders.
    strategy.prop.calc_on_order_fills = false;
    strategy.prop.calc_on_every_tick = false;
    strategy.prop.backtest_fill_limits_assumption = 0;
    if (message.execution.processOrdersOnClose !== undefined) {
      strategy.prop.process_orders_on_close = message.execution.processOrdersOnClose;
    }
    strategy.prop.use_bar_magnifier = message.highReplay !== undefined;
    const highExecution = message.highReplay
      ? attachHighBrokerReplay(pine, message.highReplay, {
          retainAudit: false,
          deriveTicksFromBars: message.highReplay.deriveTicksFromBars === true,
          deriveTickSize: message.market.mintick,
        })
      : undefined;
    const context = await Promise.race([pine.run(strategy), failed]) as unknown as { strategy?: unknown };
    if (seriesFailure) throw seriesFailure;
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
        slippagePercent: Number(strategy.prop.slippage_percent),
        processOrdersOnClose: strategy.prop.process_orders_on_close === true,
        legacyMarginDefaultsApplied: appliedLegacyLongMargin || appliedLegacyShortMargin,
      },
    };
  } catch (caught) {
    const error = seriesFailure ?? explainPineRuntimeError(caught, (message as WorkerRequest).source ?? '') ?? caught;
    const messageText = error instanceof Error ? error.message : String(error);
    response = { ok: false, error: { message: messageText.slice(0, 2_000), kind: errorKind(error, messageText) } };
  }
  reply(response);
});
