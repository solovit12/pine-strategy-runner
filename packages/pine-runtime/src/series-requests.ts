import type { BacktestTimeframe, Candle } from '../../shared/src/contracts.js';
import { BACKTEST_TIMEFRAME_MS } from '../../shared/src/contracts.js';

/**
 * request.security / request.security_lower_tf of the chart's own symbol on another
 * timeframe. The Pine engine asks its data source for those candles; the worker
 * forwards the request to the API, which loads them from the same exchange.
 * Another symbol is refused instead of silently returning the chart's candles.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEK_MS = 7 * DAY_MS;
/** Exchange weeks start on Monday 00:00 UTC; 1970-01-01 was a Thursday. */
const WEEK_OFFSET_MS = 4 * DAY_MS;

/** Most candles one request may load, so a script cannot exhaust the server. */
export const MAX_SERIES_REQUEST_CANDLES = 250_000;

export interface SeriesRequest {
  /** Pine timeframe string, e.g. "240", "D", "W". */
  readonly timeframe: string;
  readonly timeframeMs: number;
  /** Inclusive start, or undefined when only a bar count is known. */
  readonly startInclusive?: number;
  /** Exclusive end: the close of the chart's last bar. */
  readonly endExclusive: number;
  /** Bars ending at endExclusive, used when there is no start. */
  readonly limit?: number;
}

export class SeriesRequestError extends Error {
  readonly kind = 'unsupported-feature' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SeriesRequestError';
  }
}

/** Duration of a Pine timeframe string, or null for one this service cannot serve. */
export function pineTimeframeMs(timeframe: string): number | null {
  const value = timeframe.trim().toUpperCase();
  if (/^\d+$/.test(value)) {
    const minutes = Number(value);
    // Intraday bars must tile a UTC day to stay aligned with the exchange's bars.
    return minutes > 0 && DAY_MS % (minutes * MINUTE_MS) === 0 ? minutes * MINUTE_MS : null;
  }
  if (value === 'D' || value === '1D') return DAY_MS;
  if (value === 'W' || value === '1W') return WEEK_MS;
  return null;
}

/** Ticker without exchange prefix, perpetual suffix or chart-type modifier. */
export function plainSymbol(ticker: string): string {
  const withoutPrefix = ticker.includes(':') ? ticker.slice(ticker.indexOf(':') + 1) : ticker;
  return withoutPrefix.split(';')[0]!.replace(/\.P$/i, '').trim().toUpperCase();
}

export function isChartSymbol(requested: string | undefined, chartSymbol: string): boolean {
  return !requested || plainSymbol(requested) === plainSymbol(chartSymbol);
}

function alignDown(timestamp: number, durationMs: number): number {
  const offset = durationMs === WEEK_MS ? WEEK_OFFSET_MS : 0;
  return Math.floor((timestamp - offset) / durationMs) * durationMs + offset;
}

/** Exchange interval to load and how many of its candles form one requested candle. */
export function seriesSourcePlan(timeframeMs: number): { interval: BacktestTimeframe; factor: number } {
  const intervals = Object.entries(BACKTEST_TIMEFRAME_MS) as Array<[BacktestTimeframe, number]>;
  const native = intervals.find(([, ms]) => ms === timeframeMs);
  if (native) return { interval: native[0], factor: 1 };
  const base = intervals
    .filter(([, ms]) => ms < timeframeMs && timeframeMs % ms === 0 && ms <= DAY_MS)
    .sort(([, a], [, b]) => b - a)[0];
  if (!base) throw new SeriesRequestError(`The ${timeframeMs / MINUTE_MS}-minute timeframe cannot be built from exchange candles.`);
  return { interval: base[0], factor: timeframeMs / base[1] };
}

/** The candle window to load: whole requested bars that closed by the chart's end. */
export function seriesWindow(request: SeriesRequest): { startInclusive: number; endExclusive: number } {
  const endExclusive = alignDown(request.endExclusive, request.timeframeMs);
  const bars = request.limit && request.limit > 0 ? request.limit : 1_000;
  const startInclusive = request.startInclusive === undefined
    ? endExclusive - bars * request.timeframeMs
    : alignDown(request.startInclusive, request.timeframeMs);
  if (endExclusive <= startInclusive) {
    throw new SeriesRequestError(`No complete ${request.timeframe} bar ends inside the selected period.`);
  }
  return { startInclusive, endExclusive };
}

export interface AggregateOptions {
  /**
   * A bar may lack source candles: an exchange makes none for a quiet interval, and the
   * bar in progress holds only the candles closed so far (its close time stays the full
   * bar's, so lookahead_off still reads the previous bar).
   */
  readonly allowSparse?: boolean;
}

/** Joins consecutive exchange candles into candles of the requested timeframe. */
export function aggregateCandles(source: readonly Candle[], timeframeMs: number, factor: number, options: AggregateOptions = {}): Candle[] {
  if (factor === 1) return [...source];
  const groups = new Map<number, Candle[]>();
  for (const candle of source) {
    const start = alignDown(candle.openTime, timeframeMs);
    const group = groups.get(start);
    if (group) group.push(candle);
    else groups.set(start, [candle]);
  }
  const result: Candle[] = [];
  for (const [openTime, parts] of [...groups].sort(([a], [b]) => a - b)) {
    if (parts.length !== factor && !options.allowSparse) {
      throw new SeriesRequestError('Exchange candles are missing inside a requested bar; the run was stopped instead of filling the gap.');
    }
    const sum = (key: keyof Candle) => parts.reduce((total, part) => total + Number(part[key] ?? 0), 0);
    result.push({
      openTime,
      open: parts[0]!.open,
      high: Math.max(...parts.map((part) => part.high)),
      low: Math.min(...parts.map((part) => part.low)),
      close: parts.at(-1)!.close,
      volume: sum('volume'),
      closeTime: openTime + timeframeMs - 1,
      quoteAssetVolume: sum('quoteAssetVolume'),
      numberOfTrades: sum('numberOfTrades'),
      takerBuyBaseAssetVolume: sum('takerBuyBaseAssetVolume'),
      takerBuyQuoteAssetVolume: sum('takerBuyQuoteAssetVolume'),
      ignore: 0,
    });
  }
  return result;
}

/** Every requested bar present, in order, without gaps. */
export function assertCompleteSeries(candles: readonly Candle[], window: { startInclusive: number; endExclusive: number }, timeframeMs: number): void {
  const expected = Math.round((window.endExclusive - window.startInclusive) / timeframeMs);
  const continuous = candles.every((candle, index) => candle.openTime === window.startInclusive + index * timeframeMs);
  if (candles.length !== expected || !continuous) {
    throw new SeriesRequestError(`Exchange history for the requested timeframe has ${expected - candles.length} missing bars; the run was stopped instead of filling the gap.`);
  }
}
