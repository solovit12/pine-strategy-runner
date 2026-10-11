import { describe, expect, it } from 'vitest';

import {
  HYPERLIQUID_BASE_PERPETUAL_FEES,
  LIGHTER_STANDARD_PERPETUAL_FEES,
  defaultPaperTakerFeeRate,
  defaultPerpetualFeeSchedule,
  feeRateFractionToPercent,
} from '../packages/shared/src/venue-fee-schedule.js';

describe('venue fee schedules', () => {
  it('pins the public Hyperliquid base perpetual maker/taker rates', () => {
    expect(HYPERLIQUID_BASE_PERPETUAL_FEES).toMatchObject({
      venue: 'hyperliquid',
      accountProfile: 'base-tier',
      makerFeeRate: '0.00015',
      takerFeeRate: '0.00045',
      historicalAssumption: true,
    });
    expect(feeRateFractionToPercent(HYPERLIQUID_BASE_PERPETUAL_FEES.makerFeeRate)).toBe(0.015);
    expect(feeRateFractionToPercent(HYPERLIQUID_BASE_PERPETUAL_FEES.takerFeeRate)).toBe(0.045);
  });

  it('pins the public Lighter Standard perpetual zero-fee profile', () => {
    expect(LIGHTER_STANDARD_PERPETUAL_FEES).toMatchObject({
      venue: 'lighter',
      accountProfile: 'standard',
      makerFeeRate: '0',
      takerFeeRate: '0',
      historicalAssumption: true,
    });
    expect(defaultPaperTakerFeeRate('lighter')).toBe('0');
  });

  it('routes the two venues without sharing or mutating a schedule', () => {
    expect(defaultPerpetualFeeSchedule('hyperliquid')).toBe(HYPERLIQUID_BASE_PERPETUAL_FEES);
    expect(defaultPerpetualFeeSchedule('lighter')).toBe(LIGHTER_STANDARD_PERPETUAL_FEES);
    expect(Object.isFrozen(defaultPerpetualFeeSchedule('hyperliquid'))).toBe(true);
    expect(Object.isFrozen(defaultPerpetualFeeSchedule('lighter'))).toBe(true);
  });

  it('rejects malformed fraction rates', () => {
    expect(() => feeRateFractionToPercent('-0.1')).toThrow(/between zero and one/);
    expect(() => feeRateFractionToPercent('1.0001')).toThrow(/between zero and one/);
    expect(() => feeRateFractionToPercent('not-a-number')).toThrow(/between zero and one/);
  });
});
