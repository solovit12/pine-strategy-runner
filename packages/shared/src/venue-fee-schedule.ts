export const VENUE_FEE_SCHEDULE_SCHEMA_VERSION = 'venue-fee-schedule-v1' as const;

export type SupportedPerpetualVenue = 'hyperliquid' | 'lighter';

export interface VenueFeeScheduleV1 {
  readonly schemaVersion: typeof VENUE_FEE_SCHEDULE_SCHEMA_VERSION;
  readonly scheduleId: string;
  readonly venue: SupportedPerpetualVenue;
  readonly environment: 'mainnet';
  readonly marketType: 'perpetual';
  readonly accountProfile: string;
  /** Exact fraction of quote notional. 0.00015 means 0.015%. */
  readonly makerFeeRate: string;
  /** Exact fraction of quote notional. 0.00045 means 0.045%. */
  readonly takerFeeRate: string;
  readonly checkedAt: string;
  readonly sourceUrl: string;
  readonly historicalAssumption: true;
}

function freezeSchedule(schedule: VenueFeeScheduleV1): Readonly<VenueFeeScheduleV1> {
  return Object.freeze(schedule);
}

/**
 * Public base-tier assumptions used when the user has not supplied an
 * account-specific fee snapshot. They are deliberately versioned and dated:
 * current public fees are an assumption for a historical backtest, not proof
 * of the user's historical tier.
 */
export const HYPERLIQUID_BASE_PERPETUAL_FEES = freezeSchedule({
  schemaVersion: VENUE_FEE_SCHEDULE_SCHEMA_VERSION,
  scheduleId: 'hyperliquid-perpetual-base-2026-09-18',
  venue: 'hyperliquid',
  environment: 'mainnet',
  marketType: 'perpetual',
  accountProfile: 'base-tier',
  makerFeeRate: '0.00015',
  takerFeeRate: '0.00045',
  checkedAt: '2026-09-18T00:00:00.000Z',
  sourceUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees',
  historicalAssumption: true,
});

export const LIGHTER_STANDARD_PERPETUAL_FEES = freezeSchedule({
  schemaVersion: VENUE_FEE_SCHEDULE_SCHEMA_VERSION,
  scheduleId: 'lighter-perpetual-standard-2026-09-18',
  venue: 'lighter',
  environment: 'mainnet',
  marketType: 'perpetual',
  accountProfile: 'standard',
  makerFeeRate: '0',
  takerFeeRate: '0',
  checkedAt: '2026-09-18T00:00:00.000Z',
  sourceUrl: 'https://docs.lighter.xyz/trading/trading-fees',
  historicalAssumption: true,
});

export function defaultPerpetualFeeSchedule(
  venue: SupportedPerpetualVenue,
): Readonly<VenueFeeScheduleV1> {
  return venue === 'hyperliquid'
    ? HYPERLIQUID_BASE_PERPETUAL_FEES
    : LIGHTER_STANDARD_PERPETUAL_FEES;
}

export function feeRateFractionToPercent(rate: string): number {
  const parsed = Number(rate);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new RangeError('Fee rate fraction must be a finite value between zero and one.');
  }
  return parsed * 100;
}

export function defaultPaperTakerFeeRate(venue: SupportedPerpetualVenue): string {
  return defaultPerpetualFeeSchedule(venue).takerFeeRate;
}
