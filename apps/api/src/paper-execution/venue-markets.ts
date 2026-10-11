/**
 * Public market catalogs and closed candles for any Lighter / Hyperliquid
 * USDC perpetual. Used by generic Pine Paper runs: the strategy evaluates on
 * the same venue's own candles that its orders execute against.
 */
import { parse as parseLosslessJson } from 'lossless-json';

import { BACKTEST_TIMEFRAME_MS, type BacktestTimeframe, type Candle } from '../../../../packages/shared/src/contracts.js';
import {
  HYPERLIQUID_HIP3_DEXES, PAPER_MARKET_SYMBOL_PATTERN, hip3FeeMultiplier,
} from '../../../../packages/shared/src/strategy-catalog-contracts.js';
import { checkPublicRateLimit } from './public-rate-limit.js';

export type PaperVenueKey = 'lighter' | 'hyperliquid';

export interface VenueMarket {
  readonly venue: PaperVenueKey;
  readonly market: string;
  /** Lighter numeric market id; the coin name on Hyperliquid. */
  readonly marketId: string;
  readonly sizeStep: number;
  readonly minBaseQuantity: number;
  readonly minQuote: number;
  /** Lighter: fixed tick. Hyperliquid: null (5 significant figures, see pineMintick). */
  readonly priceStep: number | null;
  readonly maxPriceDecimals: number;
  /** HIP-3 market: its fee relative to the user's ordinary Hyperliquid fee (1 otherwise). */
  readonly feeMultiplier: number;
}

const LIGHTER_DETAILS_URL = 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?filter=perp';
const LIGHTER_CANDLES_URL = 'https://mainnet.zklighter.elliot.ai/api/v1/candles';
const HYPERLIQUID_URL = 'https://api.hyperliquid.xyz/info';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * Public request budget per rolling minute, below each venue's published IP limit so that
 * several markets can be requested at once when a bar closes. Lighter allows 60 requests per
 * minute without an account (https://apidocs.lighter.xyz/docs/rate-limits); Hyperliquid 1200
 * weight per minute, a small candle or info request weighing about 20.
 */
const BUDGET: Record<PaperVenueKey, { readonly max: number; readonly windowMs: number }> = {
  lighter: { max: 45, windowMs: 60_000 }, hyperliquid: { max: 40, windowMs: 60_000 },
};
const LIGHTER_PAGE = 500;
const HYPERLIQUID_PAGE = 5_000;
const MARKET_RE = /^[A-Za-z0-9]{1,20}$/;
const HYPERLIQUID_MARKET_RE = PAPER_MARKET_SYMBOL_PATTERN; // own markets plus `dex:NAME` HIP-3 markets

type FetchImpl = typeof fetch;

export interface VenueDataOptions {
  readonly fetchImpl?: FetchImpl;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

/** Request start times per venue within the rolling window (shared by the whole process). */
const sentAt: Record<PaperVenueKey, number[]> = { lighter: [], hyperliquid: [] };
const slotQueues: Record<PaperVenueKey, Promise<unknown>> = { lighter: Promise.resolve(), hyperliquid: Promise.resolve() };

/** Takes a slot of the venue's per-minute budget (waiting if spent); requests then run concurrently. */
async function paced<T>(venue: PaperVenueKey, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const slot = slotQueues[venue].catch(() => undefined).then(async () => {
    const { max, windowMs } = BUDGET[venue];
    for (;;) {
      signal?.throwIfAborted();
      const now = Date.now();
      const sent = sentAt[venue];
      while (sent.length && sent[0]! <= now - windowMs) sent.shift();
      if (sent.length < max) { sent.push(now); return; }
      await new Promise(resolve => setTimeout(resolve, sent[0]! + windowMs - now + 5));
    }
  });
  slotQueues[venue] = slot;
  await slot;
  signal?.throwIfAborted();
  return task();
}

async function requestJson(venue: PaperVenueKey, url: string, init: RequestInit, label: string,
  options: VenueDataOptions): Promise<unknown> {
  return paced(venue, async () => {
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    const response = await (options.fetchImpl ?? fetch)(url, { ...init, signal });
    await checkPublicRateLimit(response, label);
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw new Error(`${label} response is too large.`);
    let parsed: unknown = parseLosslessJson(text, null, (value) => value);
    // Lighter has been observed wrapping its JSON body in a JSON string.
    if (typeof parsed === 'string') parsed = parseLosslessJson(parsed, null, (value) => value);
    return parsed;
  }, options.signal);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function num(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a number.`);
  return parsed;
}

function decimals(value: unknown, label: string, max = 12): number {
  const parsed = num(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`${label} is out of range.`);
  return parsed;
}

const step = (places: number) => Number(`1e-${places}`);

export async function fetchVenueCatalog(venue: PaperVenueKey, options: VenueDataOptions = {}): Promise<VenueMarket[]> {
  if (venue === 'lighter') {
    const body = record(await requestJson('lighter', LIGHTER_DETAILS_URL, { method: 'GET', headers: { accept: 'application/json' } },
      'Lighter markets', options), 'Lighter markets');
    if (String(body.code) !== '200' || !Array.isArray(body.order_book_details)) throw new Error('Lighter market list is invalid.');
    const markets: VenueMarket[] = [];
    for (const item of body.order_book_details) {
      const row = record(item, 'Lighter market');
      if (row.market_type !== 'perp' || row.status !== 'active' || typeof row.symbol !== 'string' || !MARKET_RE.test(row.symbol)) continue;
      const config = row.market_config && typeof row.market_config === 'object' ? row.market_config as Record<string, unknown> : {};
      if (config.hidden === true || config.force_reduce_only === true) continue;
      const priceDecimals = decimals(row.supported_price_decimals, `${row.symbol} price decimals`);
      const sizeDecimals = decimals(row.supported_size_decimals, `${row.symbol} size decimals`);
      markets.push({
        venue, market: row.symbol, marketId: String(num(row.market_id, `${row.symbol} id`)),
        sizeStep: step(sizeDecimals), minBaseQuantity: num(row.min_base_amount, `${row.symbol} min base`),
        minQuote: num(row.min_quote_amount, `${row.symbol} min quote`),
        priceStep: step(priceDecimals), maxPriceDecimals: priceDecimals, feeMultiplier: 1,
      });
    }
    return markets.sort((a, b) => a.market.localeCompare(b.market));
  }
  const markets: VenueMarket[] = [];
  // Hyperliquid's own perpetuals, then each listed HIP-3 deployer (names come prefixed, e.g. `xyz:NVDA`).
  for (const dex of [null, ...HYPERLIQUID_HIP3_DEXES]) {
    const label = dex ? `Hyperliquid ${dex} markets` : 'Hyperliquid markets';
    const body = record(await requestJson('hyperliquid', HYPERLIQUID_URL, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(dex ? { type: 'meta', dex } : { type: 'meta' }) },
    label, options), label);
    if (!Array.isArray(body.universe)) throw new Error(`${label} list is invalid.`);
    if (dex && body.collateralToken !== undefined && String(body.collateralToken) !== '0') continue; // USDC only
    for (const item of body.universe) {
      const row = record(item, 'Hyperliquid market');
      if (typeof row.name !== 'string' || !HYPERLIQUID_MARKET_RE.test(row.name) || row.isDelisted === true) continue;
      if ((row.name.startsWith(`${dex}:`)) !== Boolean(dex)) continue;
      const sizeDecimals = decimals(row.szDecimals, `${row.name} szDecimals`, 6);
      const feeMultiplier = dex
        ? hip3FeeMultiplier(row.deployerFeeScale === undefined ? 1 : num(row.deployerFeeScale, `${row.name} fee scale`),
          row.growthMode === 'enabled')
        : 1;
      markets.push({
        venue, market: row.name, marketId: row.name, sizeStep: step(sizeDecimals), minBaseQuantity: step(sizeDecimals),
        minQuote: 10, priceStep: null, maxPriceDecimals: 6 - sizeDecimals, feeMultiplier,
      });
    }
  }
  return markets.sort((a, b) => a.market.localeCompare(b.market));
}

/** 24-hour traded volume in USD per market, for ordering the market picker (not used by execution). */
export async function fetchVenueVolumes(venue: PaperVenueKey, options: VenueDataOptions = {}): Promise<Record<string, number>> {
  const volumes: Record<string, number> = {};
  const add = (market: unknown, volume: unknown) => {
    const value = typeof volume === 'number' ? volume : typeof volume === 'string' ? Number(volume) : NaN;
    if (typeof market === 'string' && HYPERLIQUID_MARKET_RE.test(market) && Number.isFinite(value) && value >= 0) volumes[market] = value;
  };
  if (venue === 'lighter') {
    const body = record(await requestJson('lighter', LIGHTER_DETAILS_URL, { method: 'GET', headers: { accept: 'application/json' } },
      'Lighter volumes', options), 'Lighter volumes');
    if (!Array.isArray(body.order_book_details)) throw new Error('Lighter volume list is invalid.');
    for (const item of body.order_book_details) {
      const row = record(item, 'Lighter market');
      add(row.symbol, row.daily_quote_token_volume);
    }
    return volumes;
  }
  for (const dex of [null, ...HYPERLIQUID_HIP3_DEXES]) {
    const body = await requestJson('hyperliquid', HYPERLIQUID_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }) }, 'Hyperliquid volumes', options);
    if (!Array.isArray(body) || body.length !== 2 || !Array.isArray(body[1])) throw new Error('Hyperliquid volume list is invalid.');
    const universe = record(body[0], 'Hyperliquid meta').universe;
    if (!Array.isArray(universe) || universe.length !== body[1].length) throw new Error('Hyperliquid volume list is invalid.');
    universe.forEach((item, index) => add(record(item, 'Hyperliquid market').name, record(body[1][index], 'Hyperliquid context').dayNtlVlm));
  }
  return volumes;
}

/** Pine syminfo.mintick: the venue tick near the given price. */
export function pineMintick(market: VenueMarket, price: number): number {
  if (market.priceStep !== null) return market.priceStep;
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${market.market}: price is needed for the Hyperliquid tick.`);
  // Hyperliquid: at most 5 significant figures and maxPriceDecimals places.
  const exponent = Math.floor(Math.log10(price)) - 4;
  const places = Math.min(market.maxPriceDecimals, Math.max(0, -exponent));
  return exponent >= 0 ? 10 ** exponent : step(places);
}

const INTERVAL: Record<BacktestTimeframe, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w',
};

function candle(openTime: number, frameMs: number, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown, label: string): Candle {
  const open = num(o, `${label} open`); const high = num(h, `${label} high`);
  const low = num(l, `${label} low`); const close = num(c, `${label} close`);
  if (!(low > 0) || low > Math.min(open, close) || high < Math.max(open, close)) throw new Error(`${label} OHLC is invalid.`);
  const volume = v === undefined ? 0 : num(v, `${label} volume`);
  return { openTime, open, high, low, close, volume, closeTime: openTime + frameMs - 1,
    quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0 };
}

/**
 * Closed candles with openTime in [fromMs, toMs) whose bar has ended by `now`.
 * Venues omit intervals without trades; such gaps are kept (as on TradingView).
 */
export async function fetchClosedCandles(market: VenueMarket, timeframe: BacktestTimeframe, fromMs: number, toMs: number,
  options: VenueDataOptions = {}): Promise<Candle[]> {
  const frameMs = BACKTEST_TIMEFRAME_MS[timeframe];
  const now = (options.now ?? Date.now)();
  const end = Math.min(toMs, Math.floor(now / frameMs) * frameMs); // first open time that is not closed yet
  const start = Math.ceil(fromMs / frameMs) * frameMs;
  const rows = new Map<number, Candle>();
  if (start >= end) return [];
  const label = `${market.venue}/${market.market} ${timeframe}`;
  if (market.venue === 'hyperliquid') {
    for (let pageStart = start; pageStart < end; pageStart += HYPERLIQUID_PAGE * frameMs) {
      const pageEnd = Math.min(end, pageStart + HYPERLIQUID_PAGE * frameMs);
      const page = await requestJson('hyperliquid', HYPERLIQUID_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'candleSnapshot', req: { coin: market.marketId, interval: INTERVAL[timeframe],
          startTime: pageStart, endTime: pageEnd - 1 } }) }, `${label} candles`, options);
      if (!Array.isArray(page)) throw new Error(`${label} candles are invalid.`);
      for (const item of page) {
        const row = record(item, label);
        const openTime = num(row.t, `${label} t`);
        if (openTime % frameMs !== 0 || openTime < pageStart || openTime >= pageEnd) continue;
        rows.set(openTime, candle(openTime, frameMs, row.o, row.h, row.l, row.c, row.v, label));
      }
    }
  } else {
    let pageEnd = end;
    while (pageEnd > start) {
      const count = Math.min(LIGHTER_PAGE, Math.ceil((pageEnd - start) / frameMs));
      const pageStart = Math.max(start, pageEnd - count * frameMs);
      const url = new URL(LIGHTER_CANDLES_URL);
      url.searchParams.set('market_id', market.marketId);
      url.searchParams.set('resolution', INTERVAL[timeframe]);
      url.searchParams.set('start_timestamp', String(pageStart));
      url.searchParams.set('end_timestamp', String(pageEnd - 1));
      url.searchParams.set('count_back', String(count));
      url.searchParams.set('set_timestamp_to_end', 'true');
      const body = record(await requestJson('lighter', url.toString(), { method: 'GET', headers: { accept: 'application/json' } },
        `${label} candles`, options), label);
      if (String(body.code) !== '200' || !Array.isArray(body.c)) throw new Error(`${label} candles are invalid.`);
      for (const item of body.c) {
        const row = record(item, label);
        const openTime = num(row.t, `${label} t`);
        if (openTime % frameMs !== 0 || openTime < pageStart || openTime >= pageEnd) continue;
        rows.set(openTime, candle(openTime, frameMs, row.o, row.h, row.l, row.c, row.v, label));
      }
      pageEnd = pageStart;
    }
  }
  return [...rows.values()].sort((a, b) => a.openTime - b.openTime);
}
