import { describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/server';
import { BinanceFuturesMarketListService } from '../apps/api/src/binance-futures-market-list';

const information = {
  symbols: [
    { symbol: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', marginAsset: 'USDT' },
    { symbol: 'HYPEUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', marginAsset: 'USDT' },
    { symbol: 'ETHUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', marginAsset: 'USDT' },
    { symbol: 'BTCUSDC', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDC', marginAsset: 'USDC' },
    { symbol: 'SOLUSDT', contractType: 'CURRENT_QUARTER', status: 'TRADING', quoteAsset: 'USDT', marginAsset: 'USDT' },
    { symbol: 'OLDUSDT', contractType: 'PERPETUAL', status: 'BREAK', quoteAsset: 'USDT', marginAsset: 'USDT' },
    { symbol: '龙虾USDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', marginAsset: 'USDT' },
  ],
};
const tickers = [
  { symbol: 'ETHUSDT', quoteVolume: '90.25' },
  { symbol: 'BTCUSDT', quoteVolume: '100.00' },
  { symbol: 'HYPEUSDT', quoteVolume: '100.00' },
  { symbol: 'BTCUSDC', quoteVolume: '999999' },
  { symbol: 'OLDUSDT', quoteVolume: '999999' },
];

function fixtureFetcher(): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    return Response.json(url.endsWith('/exchangeInfo') ? information : tickers);
  };
  return { fetcher: fetcher as typeof fetch, calls };
}

describe('Binance Futures market list', () => {
  it('sorts active USDT perpetuals by rolling quote turnover and caches the two public requests', async () => {
    const { fetcher, calls } = fixtureFetcher();
    let time = Date.parse('2026-09-25T12:00:00.000Z');
    const service = new BinanceFuturesMarketListService(fetcher, () => time);
    const first = await service.getTopMarkets();
    expect(first.sourceStatus).toBe('live');
    expect(first.markets.map((market) => [market.rank, market.symbol, market.quoteVolume24hUsdt]))
      .toEqual([[1, 'BTCUSDT', 100], [2, 'HYPEUSDT', 100], [3, 'ETHUSDT', 90.25]]);
    expect(first.eligibleMarketCount).toBe(3);
    expect(first.excludedUnsupportedCount).toBe(1);
    expect(first.rankedMarketCount).toBe(3);
    expect(first.missingMarketCount).toBe(0);
    expect(calls.sort()).toEqual([
      'https://fapi.binance.com/fapi/v1/exchangeInfo',
      'https://fapi.binance.com/fapi/v1/ticker/24hr',
    ]);
    time += 60_000;
    expect((await service.getTopMarkets()).sourceStatus).toBe('cached');
    expect(calls).toHaveLength(2);
  });

  it('returns at most 100 markets and shares an in-flight refresh', async () => {
    const symbols = Array.from({ length: 111 }, (_, index) => ({
      symbol: `M${String(index).padStart(3, '0')}USDT`, contractType: 'PERPETUAL', status: 'TRADING',
      quoteAsset: 'USDT', marginAsset: 'USDT',
    }));
    let calls = 0;
    const service = new BinanceFuturesMarketListService(async (input) => {
      calls += 1;
      return Response.json(String(input).endsWith('/exchangeInfo')
        ? { symbols }
        : symbols.map((item, index) => ({ symbol: item.symbol, quoteVolume: String(index) })));
    });
    const [one, two] = await Promise.all([service.getTopMarkets(), service.getTopMarkets()]);
    expect(one.markets).toHaveLength(100);
    expect(one.markets[0]?.symbol).toBe('M110USDT');
    expect(one.markets.at(-1)?.symbol).toBe('M011USDT');
    expect(two).toEqual(one);
    expect(calls).toBe(2);
  });

  it('labels a bounded old snapshot stale and refuses to fabricate a fresh result after an outage', async () => {
    const { fetcher } = fixtureFetcher();
    let time = Date.parse('2026-09-25T12:00:00.000Z');
    let fail = false;
    let calls = 0;
    const service = new BinanceFuturesMarketListService(async (input, init) => {
      calls += 1;
      if (fail) return new Response('upstream error', { status: 503 });
      return fetcher(input, init);
    }, () => time);
    const first = await service.getTopMarkets();
    time += 6 * 60_000;
    fail = true;
    const stale = await service.getTopMarkets();
    expect(stale.sourceStatus).toBe('stale');
    expect(stale.fetchedAt).toBe(first.fetchedAt);
    expect((await service.getTopMarkets()).sourceStatus).toBe('stale');
    expect(calls).toBe(3);
    time += 60 * 60_000;
    await expect(service.getTopMarkets()).rejects.toThrow('HTTP 503');
  });

  it('honours Binance rate-limit cooldown without spending a ticker request', async () => {
    const { fetcher } = fixtureFetcher();
    let time = Date.parse('2026-09-25T12:00:00.000Z');
    let rateLimited = false;
    let calls = 0;
    const service = new BinanceFuturesMarketListService(async (input, init) => {
      calls += 1;
      return rateLimited
        ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } })
        : fetcher(input, init);
    }, () => time);

    await service.getTopMarkets();
    expect(calls).toBe(2);
    time += 6 * 60_000;
    rateLimited = true;
    expect((await service.getTopMarkets()).sourceStatus).toBe('stale');
    expect(calls).toBe(3); // exchangeInfo failed; the 40-weight all-market ticker was not requested.
    time += 119_000;
    expect((await service.getTopMarkets()).sourceStatus).toBe('stale');
    expect(calls).toBe(3);
    time += 1_000;
    rateLimited = false;
    expect((await service.getTopMarkets()).sourceStatus).toBe('live');
    expect(calls).toBe(5);
  });

  it('keeps a banned IP quiet when Binance omits Retry-After', async () => {
    let time = Date.parse('2026-09-25T12:00:00.000Z');
    let calls = 0;
    const service = new BinanceFuturesMarketListService(async () => {
      calls += 1;
      return new Response('IP banned', { status: 418 });
    }, () => time);

    await expect(service.getTopMarkets()).rejects.toThrow('HTTP 418');
    expect(calls).toBe(1);
    time += 2 * 24 * 60 * 60_000;
    await expect(service.getTopMarkets()).rejects.toThrow('temporarily unavailable');
    expect(calls).toBe(1);
    time += 24 * 60 * 60_000;
    await expect(service.getTopMarkets()).rejects.toThrow('HTTP 418');
    expect(calls).toBe(2);
  });

  it('fails when an eligible ticker is missing or malformed', async () => {
    const service = new BinanceFuturesMarketListService(async (input) => Response.json(
      String(input).endsWith('/exchangeInfo') ? information : tickers.filter((item) => item.symbol !== 'BTCUSDT'),
    ));
    await expect(service.getTopMarkets()).rejects.toThrow('does not cover enough active');
  });

  it('keeps a top-100 snapshot with explicit incomplete coverage when another ticker is missing', async () => {
    const symbols = Array.from({ length: 101 }, (_, index) => ({
      symbol: `M${String(index).padStart(3, '0')}USDT`, contractType: 'PERPETUAL', status: 'TRADING',
      quoteAsset: 'USDT', marginAsset: 'USDT',
    }));
    const service = new BinanceFuturesMarketListService(async (input) => Response.json(
      String(input).endsWith('/exchangeInfo') ? { symbols }
        : symbols.slice(1).map((item, index) => ({ symbol: item.symbol, quoteVolume: String(index) })),
    ));
    const result = await service.getTopMarkets();
    expect(result.markets).toHaveLength(100);
    expect(result.eligibleMarketCount).toBe(101);
    expect(result.rankedMarketCount).toBe(100);
    expect(result.missingMarketCount).toBe(1);
  });

  it('serves the ranked snapshot through the API without browser caching', async () => {
    const { fetcher } = fixtureFetcher();
    const service = new BinanceFuturesMarketListService(fetcher);
    const app = await buildApp({ strategyCatalogDir: null, binanceMarketList: service });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/markets/binance-futures' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const payload = response.json();
      expect(payload).toMatchObject({ exchange: 'Binance', sourceStatus: 'live' });
      expect(payload.markets.map((market: { symbol: string }) => market.symbol))
        .toEqual(['BTCUSDT', 'HYPEUSDT', 'ETHUSDT']);
    } finally {
      await app.close();
    }
  });

  it('exposes a clear HTTP 503 when no trustworthy list can be loaded', async () => {
    const service = new BinanceFuturesMarketListService(async () => new Response('no', { status: 503 }));
    const app = await buildApp({ strategyCatalogDir: null, binanceMarketList: service });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/markets/binance-futures' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ kind: 'BINANCE_MARKET_LIST_UNAVAILABLE' });
    } finally {
      await app.close();
    }
  });
});
