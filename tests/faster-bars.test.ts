import { describe, expect, it, vi } from 'vitest';
import { fetchVenueVolumes } from '../apps/api/src/paper-execution/venue-markets';
import { SETTLE_MS, candleRevisionMessage } from '../apps/api/src/paper-execution/pine-paper-factory';
import type { Candle } from '../packages/shared/src/contracts';

const candle = (openTime: number, high: number): Candle => ({
  openTime, open: 10, high, low: 9, close: 9.5, volume: 1, closeTime: openTime + 59_999,
  quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0,
});

describe('faster closed bars', () => {
  it('reads a closed bar well before the former fixed 2 s wait', () => {
    expect(SETTLE_MS.hyperliquid).toBeLessThanOrEqual(500);
    expect(SETTLE_MS.lighter).toBeLessThanOrEqual(1_000);
  });

  it('starts several Lighter requests together instead of one per 1.1 s', async () => {
    const started: number[] = [];
    const fetchImpl = vi.fn(async () => {
      started.push(Date.now());
      return new Response(JSON.stringify({ code: 200, order_book_details: [] }), { status: 200 });
    });
    await Promise.all(Array.from({ length: 5 }, () => fetchVenueVolumes('lighter', { fetchImpl: fetchImpl as typeof fetch })));
    expect(started).toHaveLength(5);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(500);
  });

  it('notes a candle the venue revised after the strategy used it', () => {
    expect(candleRevisionMessage(candle(0, 11), candle(0, 11))).toBeNull();
    expect(candleRevisionMessage(candle(0, 11), candle(0, 11.5)))
      .toBe('Candle 1970-01-01T00:00:00.000Z was revised by the venue after the strategy used it: high 11 -> 11.5.');
  });
});
