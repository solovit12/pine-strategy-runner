import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiResponseError, createPaperExperiment, listPaperExperiments, loadPaperCapabilities, loadStrategyCatalogCapabilities } from '../apps/web/src/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('Paper browser API', () => {
  it('reads catalog availability before offering strategy storage', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await loadStrategyCatalogCapabilities()).toEqual({ enabled: false });
    expect(fetch).toHaveBeenCalledWith('/api/strategy-catalog/capabilities', { signal: undefined });
  });

  it('reads admission and server history without inventing a run', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ available: false, reason: 'Adapter not qualified', maxTracksPerVenue: 10, maxTracksPerExperiment: 20, maxConcurrentExperiments: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ experiments: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    expect((await loadPaperCapabilities()).available).toBe(false);
    expect(await listPaperExperiments()).toEqual([]);
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/paper/capabilities', { signal: undefined });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/paper-experiments', { signal: undefined });
  });

  it('pins a saved version and keeps a server rejection visible', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ kind: 'PAPER_UNAVAILABLE', error: 'Paper admission is disabled' }), { status: 422 }));
    vi.stubGlobal('fetch', fetch);
    const input = {
      strategyId: '3b2da9ee-a4d6-4d64-b5af-a82678360611', version: 4,
      sourceSha256: 'a'.repeat(64), idempotencyKey: '8b563bb7-551d-4e38-bce3-a9419ea9a5b8',
      settings: {
        accountModel: 'venue_shared_v2' as const,
        timeframe: '1h' as const,
        tracks: [{ venue: 'Hyperliquid' as const, market: 'HYPE' as const }, { venue: 'Lighter' as const, market: 'HYPE' as const }],
        capitalPerVenue: 10_000, orderSizePercentOfRealizedEquity: 10 as const,
        hyperliquidMakerEntryFeePercent: 0, hyperliquidTakerExitFeePercent: 0,
        lighterMakerEntryFeePercent: 0, lighterTakerExitFeePercent: 0,
      },
    };

    await expect(createPaperExperiment(input)).rejects.toMatchObject({
      name: ApiResponseError.name,
      message: 'Paper admission is disabled',
      status: 422,
      kind: 'PAPER_UNAVAILABLE',
    });
    expect(fetch).toHaveBeenCalledWith('/api/paper-experiments', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
  });
});
