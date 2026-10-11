import { describe, expect, it, vi } from 'vitest';

import {
  BINANCE_FUTURES_KLINE_PAGE_LIMIT,
  BinanceFuturesHistoricalProvider,
  type BinanceFuturesFetcher,
  type BinanceFuturesHistoricalProviderOptions,
} from '../packages/market-data/src/binance-futures-historical-provider.js';
import { canonicalCandlesSha256 } from '../packages/market-data/src/high-detailization.js';

const MINUTE_MS = 60_000;
const START = Date.parse('2026-09-01T00:00:00.000Z');
const FIXED_CLOCK = () => new Date('2026-09-20T12:00:00.000Z');

function kline(openTime: number, intervalMs = MINUTE_MS, overrides: Record<number, unknown> = {}): unknown[] {
  const row: unknown[] = [
    openTime, '100.0', '105.0', '95.0', '102.0', '10.0',
    openTime + intervalMs - 1, '1000.0', 4, '5.0', '500.0', '0',
  ];
  for (const [index, value] of Object.entries(overrides)) row[Number(index)] = value;
  return row;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

function provider(
  fetcher: BinanceFuturesFetcher,
  options: Omit<BinanceFuturesHistoricalProviderOptions, 'fetcher' | 'clock'> = {},
): BinanceFuturesHistoricalProvider {
  return new BinanceFuturesHistoricalProvider({ fetcher, clock: FIXED_CLOCK, ...options });
}

describe('BinanceFuturesHistoricalProvider', () => {
  it('uses public USD-M klines, paginates precisely and records normalized provenance', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn<BinanceFuturesFetcher>(async (input, init) => {
      expect(init?.headers).toBeUndefined();
      const url = new URL(String(input));
      calls.push(url);
      const start = Number(url.searchParams.get('startTime'));
      const count = Number(url.searchParams.get('limit'));
      return json(Array.from({ length: count }, (_, index) => kline(start + index * MINUTE_MS)));
    });
    const result = await provider(fetcher).getCandles({
      symbol: 'btcusdt', interval: '1m', startInclusive: START,
      endExclusive: START + (BINANCE_FUTURES_KLINE_PAGE_LIMIT + 2) * MINUTE_MS,
    });
    expect(result.candles).toHaveLength(1_502);
    expect(result.candles[0]?.openTime).toBe(START);
    expect(result.candles.at(-1)?.openTime).toBe(START + 1_501 * MINUTE_MS);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.origin).toBe('https://fapi.binance.com');
    expect(calls[0]?.pathname).toBe('/fapi/v1/klines');
    expect(calls[0]?.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(calls[0]?.searchParams.get('interval')).toBe('1m');
    expect(calls[0]?.searchParams.get('limit')).toBe('1500');
    expect(calls[0]?.searchParams.get('endTime')).toBe(String(START + 1_500 * MINUTE_MS - 1));
    expect(calls[1]?.searchParams.get('startTime')).toBe(String(START + 1_500 * MINUTE_MS));
    expect(calls[1]?.searchParams.get('limit')).toBe('2');
    expect(calls[1]?.searchParams.get('endTime')).toBe(String(START + 1_502 * MINUTE_MS - 1));
    expect(result.provenance).toMatchObject({
      provider: 'Binance Futures', venue: 'binance', symbol: 'BTCUSDT',
      interval: '1m', pages: 2, rawRows: 1_502, recovery: null,
      fetchedAt: '2026-09-20T12:00:00.000Z',
    });
    expect(result.provenance.sha256).toBe(canonicalCandlesSha256(result.candles));
  });

  it('treats 1,500 as a page size and can page one query beyond 100,000 candles', async () => {
    const longStart = Date.parse('2026-01-01T00:00:00.000Z');
    const candleCount = 100_001;
    const calls: URL[] = [];
    const fetcher = vi.fn<BinanceFuturesFetcher>(async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      const pageStart = Number(url.searchParams.get('startTime'));
      const count = Number(url.searchParams.get('limit'));
      return json(Array.from({ length: count }, (_, index) => kline(pageStart + index * MINUTE_MS)));
    });
    const result = await provider(fetcher).getCandles({
      symbol: 'BTCUSDT',
      interval: '1m',
      startInclusive: longStart,
      endExclusive: longStart + candleCount * MINUTE_MS,
    });
    expect(result.candles).toHaveLength(candleCount);
    expect(result.provenance.pages).toBe(Math.ceil(candleCount / BINANCE_FUTURES_KLINE_PAGE_LIMIT));
    expect(calls).toHaveLength(Math.ceil(candleCount / BINANCE_FUTURES_KLINE_PAGE_LIMIT));
    expect(calls.at(-1)?.searchParams.get('limit')).toBe('1001');
  });

  it('rejects missing, duplicate, unordered and malformed candles rather than hiding gaps', async () => {
    const query = {
      symbol: 'BTCUSDT', interval: '1m' as const,
      startInclusive: START, endExclusive: START + 3 * MINUTE_MS,
    };
    for (const rows of [
      [kline(START), kline(START + 2 * MINUTE_MS)],
      [kline(START), kline(START), kline(START + 2 * MINUTE_MS)],
      [kline(START + MINUTE_MS), kline(START), kline(START + 2 * MINUTE_MS)],
      [kline(START), kline(START + MINUTE_MS, MINUTE_MS, { 6: START + 2 * MINUTE_MS }), kline(START + 2 * MINUTE_MS)],
      [kline(START), kline(START + MINUTE_MS, MINUTE_MS, { 2: '90' }), kline(START + 2 * MINUTE_MS)],
    ]) {
      await expect(provider(async () => json(rows)).getCandles(query)).rejects.toThrow();
    }
    await expect(provider(async () => json([])).getCandles(query)).rejects.toThrow(/empty/i);
  });

  it('rejects unfinished bars and non-aligned ranges', async () => {
    const fetcher = vi.fn<BinanceFuturesFetcher>(async () => json([]));
    const data = provider(fetcher);
    const baseline = { symbol: 'BTCUSDT', interval: '1m' as const, startInclusive: START };
    await expect(data.getCandles({ ...baseline, endExclusive: START + 1 })).rejects.toThrow(/boundaries/i);
    await expect(data.getCandles({ ...baseline, endExclusive: Date.parse('2026-09-20T12:01:00Z') }))
      .rejects.toThrow(/unfinished/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('supports Monday-aligned Binance weekly bars but rejects Thursday-aligned ranges', async () => {
    const monday = Date.parse('2026-09-07T00:00:00.000Z');
    const weekMs = 7 * 24 * 60 * MINUTE_MS;
    const fetcher = vi.fn<BinanceFuturesFetcher>(async () => json([kline(monday, weekMs)]));
    const data = provider(fetcher);
    const result = await data.getCandles({
      symbol: 'BTCUSDT', interval: '1w', startInclusive: monday, endExclusive: monday + weekMs,
    });
    expect(result.candles).toHaveLength(1);
    await expect(data.getCandles({
      symbol: 'BTCUSDT', interval: '1w', startInclusive: monday + 3 * 24 * 60 * MINUTE_MS,
      endExclusive: monday + weekMs + 3 * 24 * 60 * MINUTE_MS,
    })).rejects.toThrow(/boundaries/i);
  });

  it('retries transient errors within a bound, but never retries a hard 400 error', async () => {
    const fetcher = vi.fn<BinanceFuturesFetcher>()
      .mockResolvedValueOnce(json({ code: -1003 }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(json([kline(START)]));
    const query = { symbol: 'BTCUSDT', interval: '1m' as const,
      startInclusive: START, endExclusive: START + MINUTE_MS };
    expect((await provider(fetcher).getCandles(query)).candles).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const hardError = vi.fn<BinanceFuturesFetcher>(async () => json({ code: -1121 }, 400));
    await expect(provider(hardError).getCandles(query)).rejects.toThrow(/HTTP 400/);
    expect(hardError).toHaveBeenCalledTimes(1);
    const longRetry = vi.fn<BinanceFuturesFetcher>(async () => json({}, 429, { 'retry-after': '60' }));
    await expect(provider(longRetry).getCandles(query)).rejects.toThrow(/bounded wait/);
    expect(longRetry).toHaveBeenCalledTimes(1);
    const missingRetryAfter = vi.fn<BinanceFuturesFetcher>(async () => json({}, 429));
    await expect(provider(missingRetryAfter).getCandles(query)).rejects.toThrow(/without a usable Retry-After/);
    expect(missingRetryAfter).toHaveBeenCalledTimes(1);
  });

  it('recovers from a transient HTTP 502 by retrying the exact same page', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn<BinanceFuturesFetcher>(async (input) => {
      urls.push(String(input));
      return urls.length === 1 ? json({}, 502) : json([kline(START)]);
    });
    const result = await provider(fetcher).getCandles({
      symbol: 'BTCUSDT', interval: '1m', startInclusive: START,
      endExclusive: START + MINUTE_MS,
    });
    expect(result.candles).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(urls[1]).toBe(urls[0]);
  });

  it('stops after five transient attempts and reports the exhausted HTTP status', async () => {
    const fetcher = vi.fn<BinanceFuturesFetcher>(async () => json({}, 503, { 'retry-after': '0' }));
    await expect(provider(fetcher).getCandles({
      symbol: 'BTCUSDT', interval: '1m', startInclusive: START,
      endExclusive: START + MINUTE_MS,
    })).rejects.toThrow(/HTTP 503 after 5 attempts/);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('caps the combined Retry-After delay for one request at 15 seconds', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<BinanceFuturesFetcher>(async () => json({}, 503, { 'retry-after': '10' }));
      const pending = provider(fetcher).getCandles({
        symbol: 'BTCUSDT', interval: '1m', startInclusive: START,
        endExclusive: START + MINUTE_MS,
      });
      const rejected = expect(pending).rejects.toThrow(/bounded 15000 ms total wait/);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a transport failure but not permanent or malformed responses', async () => {
    const query = {
      symbol: 'BTCUSDT', interval: '1m' as const,
      startInclusive: START, endExclusive: START + MINUTE_MS,
    };
    const transport = vi.fn<BinanceFuturesFetcher>()
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockResolvedValueOnce(json([kline(START)]));
    expect((await provider(transport).getCandles(query)).candles).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);

    for (const status of [400, 418, 422, 501, 505]) {
      const permanent = vi.fn<BinanceFuturesFetcher>(async () => json({}, status));
      await expect(provider(permanent).getCandles(query)).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(permanent).toHaveBeenCalledTimes(1);
    }

    const malformed = vi.fn<BinanceFuturesFetcher>(async () => new Response('{', { status: 200 }));
    await expect(provider(malformed).getCandles(query)).rejects.toThrow(/invalid JSON/);
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-progress retry delay without sending another request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<BinanceFuturesFetcher>(async () => json({}, 502));
    const pending = provider(fetcher).getCandles({
      symbol: 'BTCUSDT', interval: '1m', startInclusive: START,
      endExclusive: START + MINUTE_MS, signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('cancelled during retry')), 10);
    await expect(pending).rejects.toThrow(/cancelled during retry/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves cancellation that arrives while a non-success response body is being read', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<BinanceFuturesFetcher>(async () => new Response(new ReadableStream({
      start(stream) {
        setTimeout(() => {
          stream.enqueue(new TextEncoder().encode('{}'));
          stream.close();
        }, 20);
      },
    }), { status: 502 }));
    const pending = provider(fetcher).getCandles({
      symbol: 'BTCUSDT', interval: '1m', startInclusive: START,
      endExclusive: START + MINUTE_MS, signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('cancelled while reading response')), 5);
    await expect(pending).rejects.toThrow(/cancelled while reading response/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honours caller cancellation without retry', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const fetcher = vi.fn<BinanceFuturesFetcher>(async () => json([kline(START)]));
    await expect(provider(fetcher).getCandles({
      symbol: 'BTCUSDT', interval: '1m', startInclusive: START,
      endExclusive: START + MINUTE_MS, signal: controller.signal,
    })).rejects.toThrow(/cancelled/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('loads exact USDT perpetual filters from public exchangeInfo', async () => {
    const fetcher = vi.fn<BinanceFuturesFetcher>(async (input) => {
      expect(new URL(String(input)).pathname).toBe('/fapi/v1/exchangeInfo');
      return json({ symbols: [{
        symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL',
        quoteAsset: 'USDT', quantityPrecision: 3,
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.10' },
          { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        ],
      }, { symbol: 'ETHUSDT' }] });
    });
    const instrument = await provider(fetcher).getInstrument('BTCUSDT');
    expect(instrument).toMatchObject({
      symbol: 'BTCUSDT', szDecimals: 3, priceTickSize: 0.1,
      quantityStepSize: 0.001, minQuantity: 0.001, maxLeverage: null,
      isActive: true, instrumentType: 'perp',
      provenance: { provider: 'Binance Futures', venue: 'binance' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not accept a spot or different quote instrument as a perpetual', async () => {
    const fetcher = vi.fn<BinanceFuturesFetcher>(async () => json({ symbols: [{
      symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDC',
      filters: [],
    }] }));
    await expect(provider(fetcher).getInstrument('BTCUSDT')).rejects.toThrow(/not a USDT perpetual/);
  });
});
