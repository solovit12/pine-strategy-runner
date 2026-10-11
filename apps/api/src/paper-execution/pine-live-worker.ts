/**
 * Isolated process that re-runs one Paper run's Pine strategy after each
 * closed bar (see packages/pine-runtime/src/live-engine.ts). The API process
 * never executes user Pine code itself.
 */
import type { Candle } from '../../../../packages/shared/src/contracts.js';
import {
  runPineLive,
  type PineLiveExecutionSettings,
  type PineLiveFill,
} from '../../../../packages/pine-runtime/src/live-engine.js';
import type { PineSymbolMarket } from '../../../../packages/pine-runtime/src/symbol-info.js';
import { UnsupportedPineFeatureError } from '../../../../packages/pine-runtime/src/pine-source-safety.js';
import {
  aggregateCandles,
  isChartSymbol,
  pineTimeframeMs,
  SeriesRequestError,
  type SeriesRequest,
} from '../../../../packages/pine-runtime/src/series-requests.js';

/** Bars of request.security history loaded once per timeframe before the chart's own candles. */
export const SERIES_HISTORY_BARS = 1_000;

export type PineLiveWorkerRequest =
  | { readonly type: 'init'; readonly source: string; readonly execution: PineLiveExecutionSettings; readonly startMs: number }
  | { readonly type: 'track'; readonly key: string; readonly market: PineSymbolMarket & { readonly pineTimeframe: string };
    readonly candles: readonly Candle[] }
  | { readonly type: 'run'; readonly id: number; readonly key: string; readonly append: readonly Candle[];
    readonly fills: readonly PineLiveFill[] }
  | { readonly type: 'series-response'; readonly id: number; readonly candles?: readonly Candle[]; readonly error?: string };

export type PineLiveWorkerResponse =
  | { readonly type: 'ready' }
  | { readonly type: 'result'; readonly id: number; readonly key: string;
    readonly result: Awaited<ReturnType<typeof runPineLive>>; readonly durationMs: number }
  | { readonly type: 'error'; readonly id: number | null; readonly message: string }
  | { readonly type: 'series-request'; readonly id: number; readonly key: string; readonly request: SeriesRequest };

interface TrackState {
  market: PineSymbolMarket & { pineTimeframe: string };
  candles: Candle[];
  fills: PineLiveFill[];
  /** request.security history per timeframe, ending where the chart's candles take over. */
  series: Map<string, readonly Candle[]>;
}

const pendingSeries = new Map<number, { resolve: (candles: readonly Candle[]) => void; reject: (error: Error) => void }>();
let nextSeriesId = 0;

function requestSeries(key: string, request: SeriesRequest): Promise<readonly Candle[]> {
  const id = ++nextSeriesId;
  return new Promise((resolve, reject) => {
    pendingSeries.set(id, { resolve, reject });
    send({ type: 'series-request', id, key, request });
  });
}

/**
 * A higher timeframe of the chart's own symbol: history loaded once from the exchange,
 * then built from the chart's closed candles, so each bar close needs no extra request.
 * The bar in progress holds only closed chart candles, as on a TradingView chart.
 */
async function trackSeries(key: string, state: TrackState, tickerId: string | undefined, timeframe: string, limit?: number): Promise<readonly Candle[]> {
  if (!isChartSymbol(tickerId, state.market.symbol) && !isChartSymbol(tickerId, state.market.tickerId)) {
    throw new UnsupportedPineFeatureError(`request.security for another symbol (${tickerId})`);
  }
  const chartMs = pineTimeframeMs(state.market.pineTimeframe);
  const timeframeMs = pineTimeframeMs(timeframe);
  if (!chartMs || !timeframeMs || timeframeMs < chartMs || timeframeMs % chartMs !== 0) {
    throw new UnsupportedPineFeatureError(`request.security on the "${timeframe}" timeframe in Paper (only multiples of the chart timeframe)`);
  }
  const first = state.candles[0]!.openTime;
  const boundary = nextBoundary(first - 1, timeframeMs);
  let history = state.series.get(timeframe);
  if (!history) {
    history = await requestSeries(key, { timeframe, timeframeMs, endExclusive: boundary, limit: limit ?? SERIES_HISTORY_BARS });
    state.series.set(timeframe, history);
  }
  const recent = aggregateCandles(state.candles.filter((candle) => candle.openTime >= boundary), timeframeMs, timeframeMs / chartMs,
    { allowSparse: true });
  return [...history, ...recent];
}

/** The first bar boundary of `timeframeMs` after `timestamp` (Monday-based for weeks). */
function nextBoundary(timestamp: number, timeframeMs: number): number {
  const offset = timeframeMs === 7 * 86_400_000 ? 4 * 86_400_000 : 0;
  return Math.floor((timestamp - offset) / timeframeMs) * timeframeMs + offset + timeframeMs;
}

let init: Extract<PineLiveWorkerRequest, { type: 'init' }> | null = null;
const tracks = new Map<string, TrackState>();
let chain: Promise<void> = Promise.resolve();

function send(message: PineLiveWorkerResponse): void {
  process.send?.(message);
}

async function handle(message: Exclude<PineLiveWorkerRequest, { type: 'series-response' }>): Promise<void> {
  if (message.type === 'init') {
    init = message;
    send({ type: 'ready' });
    return;
  }
  if (!init) throw new Error('Pine live worker is not initialized.');
  if (message.type === 'track') {
    tracks.set(message.key, { market: message.market, candles: [...message.candles], fills: [], series: new Map() });
    return;
  }
  const state = tracks.get(message.key);
  if (!state) throw new Error(`Unknown Pine live track ${message.key}.`);
  for (const candle of message.append) {
    const last = state.candles.at(-1);
    if (last && candle.openTime <= last.openTime) continue; // already known
    state.candles.push(candle);
  }
  state.fills.push(...message.fills);
  const started = Date.now();
  const result = await runPineLive({
    source: init.source, market: state.market, execution: init.execution,
    candles: state.candles, startMs: init.startMs, fills: state.fills,
    series: (tickerId, timeframe, limit) => trackSeries(message.key, state, tickerId, timeframe, limit),
  });
  send({ type: 'result', id: message.id, key: message.key, result, durationMs: Date.now() - started });
}

// A failed request.security load is reported by its run; it must not end the worker.
process.on('unhandledRejection', () => undefined);

process.on('message', (message: PineLiveWorkerRequest) => {
  if (message.type === 'series-response') {
    const pending = pendingSeries.get(message.id);
    pendingSeries.delete(message.id);
    if (message.candles) pending?.resolve(message.candles);
    else pending?.reject(new SeriesRequestError(message.error ?? 'Candles for request.security are unavailable.'));
    return;
  }
  chain = chain.then(() => handle(message)).catch((error: unknown) => {
    send({ type: 'error', id: message.type === 'run' ? message.id : null,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) });
  });
});
process.on('disconnect', () => process.exit(0));
