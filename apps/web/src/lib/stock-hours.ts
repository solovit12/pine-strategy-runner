/** Hyperliquid HIP-3 markets of trade.xyz: stocks, indices and commodities, e.g. xyz:NVDA. */
export const isXyzMarket = (market: string): boolean => market.startsWith('xyz:');

export type HomeMarketState = 'open' | 'closed-hours' | 'weekend';

/**
 * Regular US stock session: 9:30–16:00 New York time, Monday to Friday (the browser's time
 * zone data handles daylight saving). Exchange holidays are not known here.
 */
export function usStockMarketState(nowMs: number): HomeMarketState {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'weekend';
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60 ? 'open' : 'closed-hours';
}
