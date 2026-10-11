import { canonicalCandlesSha256 } from './high-detailization.js';
import { timeframeToMs, type HistoricalMarketDataProvider, type HistoricalMarketDataQuery } from './historical-market-data-provider.js';
import type { BacktestTimeframe, Candle } from '../../shared/src/contracts.js';

export const BINANCE_FUTURES_BASE_URL = 'https://fapi.binance.com';
export const BINANCE_FUTURES_KLINE_PAGE_LIMIT = 1_500;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 15_000;
const MAX_TOTAL_RETRY_DELAY_MS = 15_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
// Binance weekly candles begin on Monday UTC, unlike the Unix epoch's Thursday.
const MONDAY_OFFSET_MS = 4 * DAY_MS;

export type BinanceFuturesFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface BinanceFuturesHistoricalProviderOptions {
  fetcher?: BinanceFuturesFetcher;
  clock?: () => Date;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function symbolName(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{3,32}$/.test(value)) {
    throw new Error('A Binance USD-M futures symbol such as BTCUSDT is required.');
  }
  return value.toUpperCase();
}

function aligned(timestamp: number, interval: BacktestTimeframe, durationMs: number): boolean {
  return interval === '1w'
    ? (timestamp - MONDAY_OFFSET_MS) % WEEK_MS === 0
    : timestamp % durationMs === 0;
}

function lastClosedBoundary(nowMs: number, interval: BacktestTimeframe, durationMs: number): number {
  return interval === '1w'
    ? Math.floor((nowMs - MONDAY_OFFSET_MS) / WEEK_MS) * WEEK_MS + MONDAY_OFFSET_MS
    : Math.floor(nowMs / durationMs) * durationMs;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Binance Futures returned an invalid ${field}.`);
  }
  return value;
}

function decimal(value: unknown, field: string, positive = false): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Binance Futures returned an invalid ${field}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
    throw new Error(`Binance Futures returned an invalid ${field}.`);
  }
  return parsed;
}

function parseKline(value: unknown, durationMs: number): Candle {
  if (!Array.isArray(value) || value.length !== 12) {
    throw new Error('Binance Futures returned an invalid kline row.');
  }
  const openTime = timestamp(value[0], 'candle open time');
  const open = decimal(value[1], 'open price', true);
  const high = decimal(value[2], 'high price', true);
  const low = decimal(value[3], 'low price', true);
  const close = decimal(value[4], 'close price', true);
  const volume = decimal(value[5], 'base volume');
  const closeTime = timestamp(value[6], 'candle close time');
  const quoteAssetVolume = decimal(value[7], 'quote volume');
  const numberOfTrades = timestamp(value[8], 'trade count');
  const takerBuyBaseAssetVolume = decimal(value[9], 'taker buy base volume');
  const takerBuyQuoteAssetVolume = decimal(value[10], 'taker buy quote volume');
  const ignore = decimal(value[11], 'ignored field');

  if (closeTime !== openTime + durationMs - 1
    || low > high || open < low || open > high || close < low || close > high
    || takerBuyBaseAssetVolume > volume || takerBuyQuoteAssetVolume > quoteAssetVolume) {
    throw new Error(`Binance Futures returned an invalid candle at ${openTime}.`);
  }
  return {
    openTime, open, high, low, close, volume, closeTime, quoteAssetVolume,
    numberOfTrades, takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume, ignore,
  };
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function retryDelayMilliseconds(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1));
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429
    || status === 500 || status === 502 || status === 503 || status === 504;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Binance Futures request aborted.'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function decimalPlaces(value: string): number {
  const fraction = value.split('.')[1]?.replace(/0+$/, '') ?? '';
  return fraction.length;
}

function exchangeFilter(filters: unknown, kind: string): Record<string, unknown> {
  if (!Array.isArray(filters)) throw new Error('Binance Futures returned invalid exchange filters.');
  const matches = filters.filter((filter) => isRecord(filter) && filter.filterType === kind);
  if (matches.length !== 1) throw new Error(`Binance Futures did not provide exactly one ${kind} filter.`);
  return matches[0] as Record<string, unknown>;
}

/** Public historical candles for Binance USD-M perpetuals; never sends an API key. */
export class BinanceFuturesHistoricalProvider implements HistoricalMarketDataProvider {
  readonly #fetcher: BinanceFuturesFetcher;
  readonly #clock: () => Date;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;

  constructor(options: BinanceFuturesHistoricalProviderOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error('Binance Futures timeout must be a positive integer.');
    }
    if (options.maxAttempts !== undefined && (!Number.isSafeInteger(options.maxAttempts)
      || options.maxAttempts < 1 || options.maxAttempts > 5)) {
      throw new Error('Binance Futures attempts must be between one and five.');
    }
    const baseUrl = new URL(options.baseUrl ?? BINANCE_FUTURES_BASE_URL);
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/'
      || (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost')) {
      throw new Error('Binance Futures base URL must be a plain HTTPS origin.');
    }
    this.#fetcher = options.fetcher ?? globalThis.fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#baseUrl = baseUrl.origin;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async getCandles(query: HistoricalMarketDataQuery) {
    const symbol = symbolName(query.symbol);
    const durationMs = timeframeToMs(query.interval);
    const { startInclusive, endExclusive } = query;
    if (!Number.isSafeInteger(startInclusive) || !Number.isSafeInteger(endExclusive)
      || startInclusive < 0 || startInclusive >= endExclusive
      || !aligned(startInclusive, query.interval, durationMs)
      || !aligned(endExclusive, query.interval, durationMs)) {
      throw new Error('Binance Futures candle range must use complete UTC timeframe boundaries.');
    }
    const expectedCount = (endExclusive - startInclusive) / durationMs;
    if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
      throw new Error('Binance Futures candle request has an invalid candle count.');
    }
    const fetchedAt = this.#clock();
    const nowMs = fetchedAt.getTime();
    if (!Number.isSafeInteger(nowMs)
      || endExclusive > lastClosedBoundary(nowMs, query.interval, durationMs)) {
      throw new Error('Binance Futures candle request includes an unfinished candle.');
    }
    query.signal?.throwIfAborted();

    const candles: Candle[] = [];
    let pages = 0;
    let rawRows = 0;
    let cursor = startInclusive;
    while (cursor < endExclusive) {
      query.signal?.throwIfAborted();
      const limit = Math.min(BINANCE_FUTURES_KLINE_PAGE_LIMIT, (endExclusive - cursor) / durationMs);
      const url = new URL('/fapi/v1/klines', this.#baseUrl);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('interval', query.interval);
      url.searchParams.set('startTime', String(cursor));
      // Bound each request to this page as well as setting `limit`. This keeps
      // long histories inside Binance's per-request time-window rules instead
      // of presenting the entire multi-month query to every page request.
      url.searchParams.set('endTime', String(cursor + limit * durationMs - 1));
      url.searchParams.set('limit', String(limit));
      const payload = await this.#getJson(url, query.signal);
      if (!Array.isArray(payload) || payload.length === 0 || payload.length > limit) {
        throw new Error(`Binance Futures returned an empty or oversized candle page at ${cursor}.`);
      }
      pages += 1;
      rawRows += payload.length;
      for (const row of payload) {
        const candle = parseKline(row, durationMs);
        if (candle.openTime !== cursor) {
          throw new Error(`Binance Futures candle gap, duplicate, or wrong order at ${cursor}.`);
        }
        candles.push(candle);
        cursor += durationMs;
      }
    }
    if (candles.length !== expectedCount) {
      throw new Error('Binance Futures returned incomplete historical coverage.');
    }
    return {
      candles,
      provenance: {
        provider: 'Binance Futures' as const,
        venue: 'binance' as const,
        symbol,
        interval: query.interval,
        fetchedAt: fetchedAt.toISOString(),
        pages,
        rawRows,
        sha256: canonicalCandlesSha256(candles),
        recovery: null,
      },
    };
  }

  async getInstrument(symbolInput: string, signal?: AbortSignal) {
    const symbol = symbolName(symbolInput);
    const url = new URL('/fapi/v1/exchangeInfo', this.#baseUrl);
    url.searchParams.set('symbol', symbol);
    const payload = await this.#getJson(url, signal);
    if (!isRecord(payload) || !Array.isArray(payload.symbols)) {
      throw new Error(`Binance Futures did not return one instrument for ${symbol}.`);
    }
    // exchangeInfo currently returns the full symbol list even with ?symbol=BTCUSDT.
    const matches = payload.symbols.filter((entry) => isRecord(entry) && entry.symbol === symbol);
    if (matches.length !== 1) {
      throw new Error(`Binance Futures did not return one instrument for ${symbol}.`);
    }
    const instrument = matches[0];
    if (!isRecord(instrument) || instrument.symbol !== symbol
      || instrument.contractType !== 'PERPETUAL' || instrument.quoteAsset !== 'USDT') {
      throw new Error(`Binance Futures instrument ${symbol} is not a USDT perpetual.`);
    }
    const priceFilter = exchangeFilter(instrument.filters, 'PRICE_FILTER');
    const lotFilter = exchangeFilter(instrument.filters, 'LOT_SIZE');
    const priceTickSize = decimal(priceFilter.tickSize, 'price tick size', true);
    const quantityStepSize = decimal(lotFilter.stepSize, 'quantity step size', true);
    const minQuantity = decimal(lotFilter.minQty, 'minimum quantity', true);
    const minimumSteps = minQuantity / quantityStepSize;
    if (minQuantity < quantityStepSize || Math.abs(minimumSteps - Math.round(minimumSteps)) > 1e-9) {
      throw new Error('Binance Futures returned inconsistent quantity filters.');
    }
    const szDecimals = decimalPlaces(lotFilter.stepSize as string);
    if (szDecimals > 18 || (instrument.quantityPrecision !== undefined
      && (!Number.isSafeInteger(instrument.quantityPrecision)
        || (instrument.quantityPrecision as number) < szDecimals))) {
      throw new Error('Binance Futures returned inconsistent quantity precision.');
    }
    const fetchedAt = this.#clock();
    if (!Number.isSafeInteger(fetchedAt.getTime())) {
      throw new Error('Binance Futures instrument clock returned an invalid time.');
    }
    return {
      symbol,
      szDecimals,
      maxLeverage: null,
      isActive: instrument.status === 'TRADING',
      instrumentType: 'perp' as const,
      priceTickSize,
      quantityStepSize,
      minQuantity,
      provenance: {
        provider: 'Binance Futures' as const,
        venue: 'binance' as const,
        requestId: null,
        fetchedAt: fetchedAt.toISOString(),
      },
    };
  }

  async #getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    let body = '';
    let totalRetryDelayMs = 0;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      let response: Response;
      try {
        response = await this.#fetcher(url, { signal: requestSignal });
        body = await response.text();
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt === this.#maxAttempts) {
          throw new Error(`Binance Futures request failed after ${attempt} attempts.`, { cause: error });
        }
        const waitMs = retryDelayMilliseconds(attempt);
        if (totalRetryDelayMs + waitMs > MAX_TOTAL_RETRY_DELAY_MS) {
          throw new Error('Binance Futures transport retries exceed the bounded 15000 ms total wait.', { cause: error });
        }
        totalRetryDelayMs += waitMs;
        await delay(waitMs, signal);
        continue;
      }
      signal?.throwIfAborted();
      if (response.ok) {
        try {
          return JSON.parse(body) as unknown;
        } catch {
          throw new Error('Binance Futures returned invalid JSON.');
        }
      }
      const retryable = retryableHttpStatus(response.status);
      if (!retryable || attempt === this.#maxAttempts) {
        throw new Error(
          `Binance Futures request failed with HTTP ${response.status} after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'}.`,
        );
      }
      const retryAfterMs = response.status === 429 || response.status === 503
        ? retryAfterMilliseconds(response.headers.get('retry-after'))
        : null;
      if (response.status === 429 && retryAfterMs === null) {
        throw new Error('Binance Futures returned HTTP 429 without a usable Retry-After; the run stopped to avoid escalating the IP rate-limit violation.');
      }
      const waitMs = retryAfterMs ?? retryDelayMilliseconds(attempt);
      if (waitMs > MAX_RETRY_DELAY_MS) {
        throw new Error(
          `Binance Futures HTTP ${response.status} retry exceeds the bounded wait of ${MAX_RETRY_DELAY_MS} ms.`,
        );
      }
      if (totalRetryDelayMs + waitMs > MAX_TOTAL_RETRY_DELAY_MS) {
        throw new Error(
          `Binance Futures HTTP ${response.status} retries exceed the bounded ${MAX_TOTAL_RETRY_DELAY_MS} ms total wait.`,
        );
      }
      totalRetryDelayMs += waitMs;
      await delay(waitMs, signal);
    }
    throw new Error('Binance Futures request attempts exhausted.');
  }
}
