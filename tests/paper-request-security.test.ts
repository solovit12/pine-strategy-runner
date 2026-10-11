import { afterEach, describe, expect, it } from 'vitest';

import { PineLiveClient } from '../apps/api/src/paper-execution/pine-live-client.js';
import type { SeriesRequest } from '../packages/pine-runtime/src/series-requests.js';
import type { Candle } from '../packages/shared/src/contracts.js';

const M15 = 15 * 60_000;
const H = 60 * 60_000;
const t0 = Date.UTC(2026, 9, 1);
const bar = (openTime: number, durationMs: number, close: number): Candle => ({
  openTime, open: close, high: close + 1, low: close - 1, close, volume: 1, closeTime: openTime + durationMs - 1,
  quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0,
});
// The chart starts mid-hour (00:30); its 15m close k is 1000 + k.
const chart = Array.from({ length: 20 }, (_, k) => bar(t0 + 30 * 60_000 + k * M15, M15, 1000 + k));
const market = { tickerId: 'LIGHTER:BTCUSDC.P', symbol: 'BTC', exchange: 'Lighter' as const, quoteCurrency: 'USDC' as const,
  mintick: 0.01, minContract: 0.001, pineTimeframe: '15' };
const execution = { initialCapital: 10_000, defaultOrderSizeValue: 1, defaultOrderSizeType: 'fixed' as const,
  pyramiding: 1, commissionType: 'percent' as const, commissionValue: 0 };
const source = `//@version=6
strategy("Paper security", overlay=true)
h = request.security(syminfo.tickerid, "60", close)
if barstate.islast
    strategy.entry(str.tostring(h), strategy.long)
`;

let client: PineLiveClient | null = null;
afterEach(() => { client?.close(); client = null; });

describe('Paper request.security', () => {
  it('loads the history once and builds newer hours from the chart without showing the open hour', async () => {
    const requests: SeriesRequest[] = [];
    client = new PineLiveClient(source, execution, chart.at(-1)!.closeTime + 1, undefined, async (_key, request) => {
      requests.push(request);
      // Hours before the chart's first full hour; the 00:00 hour is only half covered by the chart.
      return Array.from({ length: 5 }, (_, i) => bar(request.endExclusive - (5 - i) * H, H, 500 + i));
    });
    await client.ready();
    await client.addTrack('lighter:BTC', market, chart.slice(0, 19));
    const first = await client.run('lighter:BTC', [], []);
    // Last closed bar 04:45-05:00 completes the 04:00 hour, whose last 15m close is 1000 + 17.
    expect(first.result.orders.map((order) => order.id)).toEqual(['1017']);
    // The next bar (05:00-05:15) starts a new hour that is still open: the value stays.
    const second = await client.run('lighter:BTC', [chart[19]!], []);
    expect(second.result.orders.map((order) => order.id)).toEqual(['1017']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ timeframe: '60', timeframeMs: H, endExclusive: t0 + H });
  });

  it('refuses another symbol and a timeframe below the chart in Paper', async () => {
    const run = async (script: string) => {
      const local = new PineLiveClient(script, execution, chart.at(-1)!.closeTime + 1, undefined, async () => []);
      try {
        await local.ready();
        await local.addTrack('lighter:BTC', market, chart);
        return await local.run('lighter:BTC', [], []).then(() => 'ok', (error: Error) => error.message);
      } finally { local.close(); }
    };
    expect(await run(source.replace('syminfo.tickerid', '"LIGHTER:ETHUSDC.P"'))).toContain('request.security for another symbol');
    expect(await run(source.replace('"60"', '"5"'))).toContain('only multiples of the chart timeframe');
  });
});
