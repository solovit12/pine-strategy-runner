import { describe, expect, it } from 'vitest';
import { StartPaperExperimentSchema } from '../packages/shared/src/paper-experiment-contracts';
import { PaperStrategySettingsSchema } from '../packages/shared/src/strategy-catalog-contracts';

const tracks = [
  { venue: 'Hyperliquid' as const, market: 'HYPE' as const },
  { venue: 'Lighter' as const, market: 'HYPE' as const },
];

const legacy = {
  timeframe: '1h' as const,
  tracks,
  capitalPerTrack: 5000,
  targetOrderValue: 500,
  hyperliquidFeePercent: 0,
  lighterFeePercent: 0,
};

const sharedV1 = {
  accountModel: 'venue_shared_v1' as const,
  timeframe: '1h' as const,
  tracks,
  capitalPerVenue: 10000,
  orderSizePercentOfRealizedEquity: 10 as const,
  hyperliquidFeePercent: 0,
  lighterFeePercent: 0,
};

const sharedV2 = {
  accountModel: 'venue_shared_v2' as const,
  timeframe: '1h' as const,
  tracks,
  capitalPerVenue: 10000,
  orderSizePercentOfRealizedEquity: 10 as const,
  hyperliquidMakerEntryFeePercent: 0.01,
  hyperliquidTakerExitFeePercent: 0.035,
  lighterMakerEntryFeePercent: 0,
  lighterTakerExitFeePercent: 0.02,
};

const startRequest = (settings: unknown) => ({
  strategyId: '11111111-1111-4111-8111-111111111111',
  version: 2,
  sourceSha256: 'a'.repeat(64),
  settings,
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
});

describe('Paper fee-split settings V2', () => {
  it('keeps both old draft formats readable without admitting them as launch requests', () => {
    expect(PaperStrategySettingsSchema.safeParse(legacy).success).toBe(true);
    expect(PaperStrategySettingsSchema.safeParse(sharedV1).success).toBe(true);
    expect(StartPaperExperimentSchema.safeParse(startRequest(legacy)).success).toBe(false);
    expect(StartPaperExperimentSchema.safeParse(startRequest(sharedV1)).success).toBe(false);
  });

  it('keeps four independent fees, including explicit zero, in a launch request', () => {
    const parsed = StartPaperExperimentSchema.parse(startRequest(sharedV2));
    expect(parsed.settings).toEqual(sharedV2);
    expect(parsed.settings.hyperliquidMakerEntryFeePercent).not.toBe(parsed.settings.hyperliquidTakerExitFeePercent);
  });

  it('allows incomplete V2 drafts but rejects missing, invalid and ambiguous launch fees', () => {
    const draft = { ...sharedV2, lighterTakerExitFeePercent: null };
    expect(PaperStrategySettingsSchema.safeParse(draft).success).toBe(true);
    expect(StartPaperExperimentSchema.safeParse(startRequest(draft)).success).toBe(false);
    expect(PaperStrategySettingsSchema.safeParse({ ...sharedV2, lighterTakerExitFeePercent: -1 }).success).toBe(false);
    expect(PaperStrategySettingsSchema.safeParse({ ...sharedV2, hyperliquidMakerEntryFeePercent: 101 }).success).toBe(false);
    expect(PaperStrategySettingsSchema.safeParse({ ...sharedV2, hyperliquidFeePercent: 0 }).success).toBe(false);
  });

  it('accepts ten different pilot markets per venue but refuses an eleventh', () => {
    const tracks = ['SOL', 'HYPE', 'ZEC', 'XRP', 'LIT', 'SUI', 'NEAR', 'DOGE', 'ENA', 'AAVE'].flatMap(market => [
      { venue: 'Hyperliquid', market }, { venue: 'Lighter', market },
    ]);
    expect(StartPaperExperimentSchema.safeParse(startRequest({ ...sharedV2, tracks })).success).toBe(true);
    expect(StartPaperExperimentSchema.safeParse(startRequest({
      ...sharedV2, tracks: [...tracks, { venue: 'Hyperliquid', market: 'BTC' }],
    })).success).toBe(false);
  });
});
