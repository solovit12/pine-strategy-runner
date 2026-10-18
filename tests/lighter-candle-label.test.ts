import { afterEach, describe, expect, it } from 'vitest';

import { fetchClosedCandles, lighterCandleLabel, resetLighterCandleLabel, type VenueMarket } from '../apps/api/src/paper-execution/venue-markets.js';

/** Lighter labels its candles by the start of the period at some times and by the end at others. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 17, 10, 0, 1); // one second after 10:00 UTC
const sol: VenueMarket = { venue: 'lighter', market: 'SOL', marketId: '2', sizeStep: 0.001, minBaseQuantity: 0.001,
  minQuote: 10, priceStep: 0.01, maxPriceDecimals: 2, feeMultiplier: 1 };
// The true hourly candles, keyed by the start of their hour; prices make the hour obvious.
const hours = [7, 8, 9].map(h => ({ start: Date.UTC(2026, 9, 17, h), o: h * 10, h: h * 10 + 5, l: h * 10 - 5, c: h * 10 + 1 }));
// Trades of the last three finished minutes; the last trade of each minute sets its candle's close.
const minutes = [3, 2, 1].map(back => ({ start: NOW - NOW % MINUTE - back * MINUTE, last: 100 + back }));

function lighter(label: 'start' | 'end') {
  const shift = (frame: number) => (label === 'end' ? frame : 0);
  const requests: URL[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname.endsWith('/recentTrades')) {
      return json({ code: 200, trades: minutes.flatMap(m => [
        { timestamp: m.start + 5_000, price: String(m.last - 0.5) }, { timestamp: m.start + 50_000, price: String(m.last) }]) });
    }
    const resolution = url.searchParams.get('resolution');
    const from = Number(url.searchParams.get('start_timestamp'));
    const to = Number(url.searchParams.get('end_timestamp'));
    const rows = resolution === '1m'
      ? minutes.map(m => ({ t: m.start + shift(MINUTE), o: m.last - 0.5, h: m.last, l: m.last - 0.5, c: m.last, v: 1 }))
      : hours.map(x => ({ t: x.start + shift(HOUR), o: x.o, h: x.h, l: x.l, c: x.c, v: 1 }));
    return json({ code: 200, c: rows.filter(row => row.t >= from && row.t <= to) });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

afterEach(() => resetLighterCandleLabel());

describe('Lighter candle labels', () => {
  for (const label of ['start', 'end'] as const) {
    it(`reads candles labeled by the ${label} of their period with the right open times`, async () => {
      const { fetchImpl } = lighter(label);
      expect(await lighterCandleLabel('2', { fetchImpl, now: () => NOW })).toBe(label);
      resetLighterCandleLabel();
      const candles = await fetchClosedCandles(sol, '1h', Date.UTC(2026, 9, 17, 7), NOW + HOUR, { fetchImpl, now: () => NOW });
      // 07:00, 08:00 and 09:00 are closed at 10:00:01; every candle keeps its own prices.
      expect(candles.map(c => [new Date(c.openTime).toISOString().slice(11, 16), c.open, c.close]))
        .toEqual([['07:00', 70, 71], ['08:00', 80, 81], ['09:00', 90, 91]]);
    });
  }

  it('keeps the last reading when there is no evidence', async () => {
    const quiet = (async (input: string | URL) => new Response(JSON.stringify(
      String(input).includes('recentTrades') ? { code: 200, trades: [] } : { code: 200, c: [] }), { status: 200 })) as typeof fetch;
    expect(await lighterCandleLabel('2', { fetchImpl: lighter('end').fetchImpl, now: () => NOW })).toBe('end');
    expect(await lighterCandleLabel('2', { fetchImpl: quiet, now: () => NOW + 31_000 })).toBe('end');
    resetLighterCandleLabel();
    expect(await lighterCandleLabel('2', { fetchImpl: quiet, now: () => NOW })).toBe('start'); // documented default
  });
});
