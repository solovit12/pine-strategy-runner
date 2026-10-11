import { describe, expect, it, vi } from 'vitest';
import { fetchVenueCatalog, fetchVenueVolumes } from '../apps/api/src/paper-execution/venue-markets';
import { PineLivePaperSettingsV1Schema, hip3Dex, hip3FeeMultiplier } from '../packages/shared/src/strategy-catalog-contracts';
import { feeMultiplierLabel } from '../apps/web/src/components/PaperScreens';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('Hyperliquid HIP-3 (xyz) markets', () => {
  it('computes the HIP-3 fee multiplier from the deployer scale and growth mode', () => {
    expect(hip3FeeMultiplier(1, true)).toBeCloseTo(0.2);
    expect(hip3FeeMultiplier(0.5, false)).toBeCloseTo(1.5);
    expect(hip3FeeMultiplier(2, false)).toBeCloseTo(4);
    expect(hip3Dex('xyz:NVDA')).toBe('xyz');
    expect(hip3Dex('HYPE')).toBeNull();
    expect(feeMultiplierLabel(0.2)).toBe('fee ×0.2');
    expect(feeMultiplierLabel(1)).toBe('');
  });

  it('lists xyz markets after Hyperliquid own markets, with their fee, skipping delisted ones', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.dex === 'xyz') {
        return json({ collateralToken: 0, universe: [
          { name: 'xyz:NVDA', szDecimals: 3, deployerFeeScale: '1.0', growthMode: 'enabled' },
          { name: 'xyz:GOLD', szDecimals: 4, deployerFeeScale: '0.5' },
          { name: 'xyz:VIX', szDecimals: 2, isDelisted: true },
        ] });
      }
      return json({ universe: [{ name: 'HYPE', szDecimals: 2 }, { name: 'kPEPE', szDecimals: 0 }] });
    });
    const markets = await fetchVenueCatalog('hyperliquid', { fetchImpl: fetchImpl as typeof fetch });
    expect(markets.map((market) => market.market)).toEqual(['HYPE', 'kPEPE', 'xyz:GOLD', 'xyz:NVDA']);
    const nvda = markets.find((market) => market.market === 'xyz:NVDA')!;
    expect(nvda).toMatchObject({ marketId: 'xyz:NVDA', maxPriceDecimals: 3, sizeStep: 0.001 });
    expect(nvda.feeMultiplier).toBeCloseTo(0.2);
    expect(markets.find((market) => market.market === 'xyz:GOLD')!.feeMultiplier).toBeCloseTo(1.5);
    expect(markets.find((market) => market.market === 'HYPE')!.feeMultiplier).toBe(1);
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ type: 'meta' }, { type: 'meta', dex: 'xyz' }]);
  });

  it('includes xyz volumes for ordering the picker', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.dex === 'xyz'
        ? json([{ universe: [{ name: 'xyz:NVDA' }] }, [{ dayNtlVlm: '165700000.5' }]])
        : json([{ universe: [{ name: 'BTC' }] }, [{ dayNtlVlm: '3500000000' }]]);
    });
    expect(await fetchVenueVolumes('hyperliquid', { fetchImpl: fetchImpl as typeof fetch }))
      .toEqual({ BTC: 3_500_000_000, 'xyz:NVDA': 165_700_000.5 });
  });

  it('accepts xyz markets on Hyperliquid only', () => {
    const settings = {
      accountModel: 'pine_live_v1', timeframe: '1h', capitalPerVenue: 10_000, orderSizePercent: 10,
      hyperliquidMakerFeePercent: 0.015, hyperliquidTakerFeePercent: 0.045, lighterMakerFeePercent: 0, lighterTakerFeePercent: 0,
    };
    expect(PineLivePaperSettingsV1Schema.safeParse({ ...settings, tracks: [{ venue: 'Hyperliquid', market: 'xyz:NVDA' }] }).success).toBe(true);
    const lighter = PineLivePaperSettingsV1Schema.safeParse({ ...settings, tracks: [{ venue: 'Lighter', market: 'xyz:NVDA' }] });
    expect(lighter.success).toBe(false);
    expect(JSON.stringify(lighter.error?.issues)).toContain('exist only on Hyperliquid');
    expect(PineLivePaperSettingsV1Schema.safeParse({ ...settings, tracks: [{ venue: 'Hyperliquid', market: 'XYZ:NVDA' }] }).success).toBe(false);
  });
});
