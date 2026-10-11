import { describe, expect, it } from 'vitest';
import type { NormalizedTrade } from '../packages/shared/src/contracts';
import { buildTradeMarkers } from '../apps/web/src/lib/chart-markers';

function trade(overrides: Partial<NormalizedTrade>): NormalizedTrade {
  return {
    number: 1,
    side: 'long',
    entryTime: '2026-01-01T00:00:00.000Z',
    exitTime: '2026-01-02T00:00:00.000Z',
    entryPrice: 100,
    exitPrice: 101,
    size: 1,
    pnl: 1,
    pnlPercent: 1,
    commission: 0,
    durationBars: 24,
    entrySignal: 'Long',
    exitSignal: 'Short',
    ...overrides,
  };
}

describe('chart markers', () => {
  it('combines a same-bar reversal into the TradingView-style signed order marker', () => {
    const markers = buildTradeMarkers([
      trade({}),
      trade({
        number: 2,
        side: 'short',
        entryTime: '2026-01-02T00:00:00.000Z',
        exitTime: '2026-01-03T00:00:00.000Z',
      }),
    ]);

    expect(markers.map((marker) => marker.text)).toEqual(['LONG +1', 'SHORT −2', 'EXIT']);
    expect(markers[1]).toMatchObject({ position: 'aboveBar', shape: 'arrowDown' });
  });
});
