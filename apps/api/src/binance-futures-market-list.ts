import type {
  BinanceFuturesMarketList,
  BinanceFuturesMarketOption,
} from '../../../packages/shared/src/binance-market-list-contracts.js';

const BASE_URL = 'https://fapi.binance.com';
const FRESH_MS = 5 * 60_000;
const MAX_STALE_MS = 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
const RATE_LIMIT_FALLBACK_MS = 5 * 60_000;
const IP_BAN_FALLBACK_MS = 3 * 24 * 60 * 60_000;
// Keep the picker inside the current backtest form's exact-symbol grammar.
const SYMBOL_PATTERN = /^[A-Z0-9]+USDT$/;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function retryAfterMilliseconds(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = Math.ceil(seconds * 1_000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

function tradingUsdtPerpetuals(payload: unknown): { symbols: Set<string>; excludedUnsupportedCount: number } {
  if (!record(payload) || !Array.isArray(payload.symbols)) {
    throw new Error('Binance Futures exchange information is invalid.');
  }
  const symbols = new Set<string>();
  let excludedUnsupportedCount = 0;
  for (const item of payload.symbols) {
    if (!record(item) || item.status !== 'TRADING' || item.contractType !== 'PERPETUAL'
      || item.quoteAsset !== 'USDT' || item.marginAsset !== 'USDT') continue;
    if (typeof item.symbol !== 'string' || !SYMBOL_PATTERN.test(item.symbol)) {
      excludedUnsupportedCount += 1;
      continue;
    }
    if (symbols.has(item.symbol)) throw new Error('Binance Futures exchange information contains a duplicate symbol.');
    symbols.add(item.symbol);
  }
  if (symbols.size === 0) throw new Error('Binance Futures returned no trading USDT perpetual markets.');
  return { symbols, excludedUnsupportedCount };
}

function rankedMarkets(payload: unknown, eligible: Set<string>): { markets: BinanceFuturesMarketOption[]; rankedMarketCount: number } {
  if (!Array.isArray(payload)) throw new Error('Binance Futures 24-hour ticker list is invalid.');
  const volumes = new Map<string, number>();
  for (const item of payload) {
    if (!record(item) || typeof item.symbol !== 'string' || !eligible.has(item.symbol)) continue;
    if (volumes.has(item.symbol)) throw new Error('Binance Futures 24-hour ticker contains a duplicate symbol.');
    if (typeof item.quoteVolume !== 'string'
      || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(item.quoteVolume)) continue;
    const volume = Number(item.quoteVolume);
    if (!Number.isFinite(volume)) continue;
    volumes.set(item.symbol, volume);
  }
  if (volumes.size < Math.min(100, eligible.size)) {
    throw new Error('Binance Futures 24-hour ticker does not cover enough active USDT perpetual markets.');
  }
  const markets = [...volumes.entries()]
    .sort(([leftSymbol, leftVolume], [rightSymbol, rightVolume]) => rightVolume - leftVolume || leftSymbol.localeCompare(rightSymbol))
    .slice(0, 100)
    .map(([symbol, quoteVolume24hUsdt], index) => ({ rank: index + 1, symbol, quoteVolume24hUsdt }));
  return { markets, rankedMarketCount: volumes.size };
}

export class BinanceFuturesMarketListService {
  private snapshot: BinanceFuturesMarketList | null = null;
  private fetchedAtMs = 0;
  private retryAfterMs = 0;
  private inFlight: Promise<BinanceFuturesMarketList> | null = null;

  constructor(
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getTopMarkets(): Promise<BinanceFuturesMarketList> {
    const current = this.now();
    const age = current - this.fetchedAtMs;
    if (this.snapshot && age >= 0 && age < FRESH_MS) {
      return { ...this.snapshot, sourceStatus: 'cached' };
    }
    if (this.inFlight) return this.inFlight;
    if (current < this.retryAfterMs) {
      if (this.snapshot && age >= 0 && age < MAX_STALE_MS) {
        return { ...this.snapshot, sourceStatus: 'stale' };
      }
      throw new Error('Binance Futures market list is temporarily unavailable.');
    }
    this.inFlight = this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh(): Promise<BinanceFuturesMarketList> {
    try {
      const information = await this.getJson(`${BASE_URL}/fapi/v1/exchangeInfo`);
      const { symbols: eligible, excludedUnsupportedCount } = tradingUsdtPerpetuals(information);
      const ticker = await this.getJson(`${BASE_URL}/fapi/v1/ticker/24hr`);
      const { markets, rankedMarketCount } = rankedMarkets(ticker, eligible);
      const fetchedAtMs = this.now();
      const result: BinanceFuturesMarketList = {
        exchange: 'Binance',
        marketType: 'Perpetual',
        quoteAsset: 'USDT',
        ranking: 'rolling_24h_quote_volume',
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        sourceStatus: 'live',
        eligibleMarketCount: eligible.size,
        excludedUnsupportedCount,
        rankedMarketCount,
        missingMarketCount: eligible.size - rankedMarketCount,
        markets,
      };
      this.snapshot = result;
      this.fetchedAtMs = fetchedAtMs;
      this.retryAfterMs = 0;
      return result;
    } catch (error) {
      this.retryAfterMs = Math.max(this.retryAfterMs, this.now() + RETRY_AFTER_FAILURE_MS);
      const age = this.now() - this.fetchedAtMs;
      if (this.snapshot && age >= 0 && age < MAX_STALE_MS) {
        return { ...this.snapshot, sourceStatus: 'stale' };
      }
      throw error;
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (response.status === 429 || response.status === 418) {
        const nowMs = this.now();
        const retryAfterMs = retryAfterMilliseconds(response.headers.get('retry-after'), nowMs);
        const fallbackMs = response.status === 418 ? IP_BAN_FALLBACK_MS : RATE_LIMIT_FALLBACK_MS;
        const delayMs = retryAfterMs === null ? fallbackMs : Math.max(RETRY_AFTER_FAILURE_MS, retryAfterMs);
        this.retryAfterMs = Math.max(this.retryAfterMs, nowMs + delayMs);
      }
      throw new Error(`Binance Futures market list returned HTTP ${response.status}.`);
    }
    return response.json() as Promise<unknown>;
  }
}
