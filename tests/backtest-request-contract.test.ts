import { describe, expect, it } from 'vitest';
import { BacktestRequestSchema } from '../packages/shared/src/contracts';

const base = {
  source: '//@version=6\nstrategy("x")',
  exchange: 'Hyperliquid' as const,
  marketType: 'Perpetual' as const,
  symbol: 'BTC',
  timeframe: '1h' as const,
  dateRange: { start: '2026-09-01', end: '2026-09-07' },
  initialCapital: 100_000,
  baseCurrency: 'USDC' as const,
  defaultOrderSizeValue: 1,
  defaultOrderSizeType: 'fixed' as const,
  pyramiding: 1,
  commissionType: 'percent' as const,
  commissionValue: 0.1,
  slippageTicks: 0,
};

const binanceBase = {
  ...base,
  exchange: 'Binance' as const,
  symbol: 'BTCUSDT',
  baseCurrency: 'USDT' as const,
};

describe('BacktestRequest minute detailization contract', () => {
  it('requires an explicit user commission for Binance Futures without a fixed venue default', () => {
    expect(BacktestRequestSchema.safeParse({ ...binanceBase, commissionValue: undefined }).success).toBe(false);
    const zeroFee = BacktestRequestSchema.parse({ ...binanceBase, commissionValue: 0 });
    expect(zeroFee.feeModel).toBe('manual');
    expect(zeroFee.commissionValue).toBe(0);
    expect(BacktestRequestSchema.safeParse({ ...binanceBase, feeModel: 'venue_default_all_taker_v1' }).success).toBe(false);
    expect(BacktestRequestSchema.safeParse({ ...binanceBase, baseCurrency: 'USDC' }).success).toBe(false);
  });
  it('does not impose the old 69-day product limit in the shared request contract', () => {
    expect(BacktestRequestSchema.safeParse({ ...binanceBase, dateRange: { start: '2026-09-01', end: '2026-11-08' } }).success).toBe(true);
    expect(BacktestRequestSchema.safeParse({ ...binanceBase, dateRange: { start: '2025-09-01', end: '2026-08-31' } }).success).toBe(true);
  });
  it('defaults to the venue all-taker fee model', () => {
    expect(BacktestRequestSchema.parse(base).feeModel).toBe('venue_default_all_taker_v1');
  });

  it('keeps an explicit manual fee model for controlled comparisons', () => {
    expect(BacktestRequestSchema.parse({ ...base, feeModel: 'manual' }).feeModel).toBe('manual');
  });

  it('rejects an impossible manual percentage above 100%', () => {
    expect(BacktestRequestSchema.safeParse({
      ...base,
      feeModel: 'manual',
      commissionValue: 100.0001,
    }).success).toBe(false);
  });

  it('normalizes omitted detailization to High above 1m', () => {
    expect(BacktestRequestSchema.parse(base).barDetailization).toBe('high');
  });

  it('normalizes omitted detailization to Default at 1m', () => {
    expect(BacktestRequestSchema.parse({ ...base, timeframe: '1m' }).barDetailization).toBe('default');
  });

  it('does not let callers bypass minute replay above 1m', () => {
    expect(BacktestRequestSchema.safeParse({ ...base, barDetailization: 'default' }).success).toBe(false);
  });

  it('does not accept meaningless High detailization at 1m', () => {
    expect(BacktestRequestSchema.safeParse({ ...base, timeframe: '1m', barDetailization: 'high' }).success).toBe(false);
  });

  it('requires complete Monday-to-Sunday UTC ranges for 1w', () => {
    expect(BacktestRequestSchema.safeParse({
      ...base,
      timeframe: '1w',
      dateRange: { start: '2026-09-07', end: '2026-09-13' },
    }).success).toBe(true);
    expect(BacktestRequestSchema.safeParse({
      ...base,
      timeframe: '1w',
      dateRange: { start: '2026-09-08', end: '2026-09-14' },
    }).success).toBe(false);
  });
});
