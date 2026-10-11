import { z } from 'zod';

import type { VenueFeeScheduleV1 } from './venue-fee-schedule.js';

export const CandleSchema = z.object({
  openTime: z.number().int(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  closeTime: z.number().int(),
  quoteAssetVolume: z.number(),
  numberOfTrades: z.number().int(),
  takerBuyBaseAssetVolume: z.number(),
  takerBuyQuoteAssetVolume: z.number(),
  ignore: z.number(),
});

export type Candle = z.infer<typeof CandleSchema>;

const UtcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, 'Invalid UTC date');

export const BacktestDateRangeSchema = z.object({
  start: UtcDateSchema,
  end: UtcDateSchema,
});

export const DefaultOrderSizeTypeSchema = z.enum(['fixed', 'cash', 'percent_of_equity']);
export const CommissionTypeSchema = z.enum(['percent', 'cash_per_contract', 'cash_per_order']);
export const BacktestFeeModelSchema = z.enum(['venue_default_all_taker_v1', 'manual']);
export const BarDetailizationSchema = z.enum(['default', 'high']);
export const BacktestTimeframeSchema = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']);

export type BacktestTimeframe = z.infer<typeof BacktestTimeframeSchema>;

export const BACKTEST_TIMEFRAME_MS: Readonly<Record<BacktestTimeframe, number>> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

export const PINE_TIMEFRAME: Readonly<Record<BacktestTimeframe, string>> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
  '1w': 'W',
};

const BacktestRequestInputSchema = z.object({
  source: z.string().min(1).max(200_000),
  exchange: z.enum(['Binance', 'Hyperliquid']),
  marketType: z.literal('Perpetual'),
  symbol: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid market symbol'),
  timeframe: BacktestTimeframeSchema,
  barIndexOffset: z.number().int().min(0).max(10_000).default(0),
  dateRange: BacktestDateRangeSchema,
  initialCapital: z.number().finite().positive().max(1_000_000_000_000),
  baseCurrency: z.enum(['USDC', 'USDT']).optional(),
  defaultOrderSizeValue: z.number().finite().positive().max(1_000_000_000_000),
  defaultOrderSizeType: DefaultOrderSizeTypeSchema,
  pyramiding: z.number().int().min(0).max(100),
  feeModel: BacktestFeeModelSchema.optional(),
  commissionType: CommissionTypeSchema,
  commissionValue: z.number().finite().min(0).max(1_000_000_000_000),
  marginLongPercent: z.number().finite().min(0).max(100).optional(),
  marginShortPercent: z.number().finite().min(0).max(100).optional(),
  slippageTicks: z.number().int().min(0).max(1_000_000),
  barDetailization: BarDetailizationSchema.optional(),
  calcOnOrderFills: z.literal(false).default(false),
  calcOnEveryTick: z.literal(false).default(false),
  calcOnEveryHistoryTick: z.literal(false).default(false),
  limitOrderVerificationTicks: z.literal(0).default(0),
  processOrdersOnClose: z.literal(false).default(false),
}).superRefine((value, context) => {
  if (value.exchange === 'Binance') {
    if (value.baseCurrency !== undefined && value.baseCurrency !== 'USDT') {
      context.addIssue({ code: 'custom', path: ['baseCurrency'], message: 'Binance USD-M perpetual backtests use USDT' });
    }
    if (value.feeModel === 'venue_default_all_taker_v1') {
      context.addIssue({ code: 'custom', path: ['feeModel'], message: 'Enter the commission explicitly for Binance data' });
    }
  } else if (value.baseCurrency !== undefined && value.baseCurrency !== 'USDC') {
    context.addIssue({ code: 'custom', path: ['baseCurrency'], message: 'Hyperliquid perpetual backtests use USDC' });
  }
  if (value.dateRange.start > value.dateRange.end) {
    context.addIssue({ code: 'custom', path: ['dateRange', 'end'], message: 'End date must not be before start date' });
  }
  if (value.commissionType === 'percent' && value.commissionValue > 100) {
    context.addIssue({
      code: 'custom',
      path: ['commissionValue'],
      message: 'Percent commission must be between zero and 100',
    });
  }
  const expectedDetailization = value.timeframe === '1m' ? 'default' : 'high';
  if (value.barDetailization !== undefined && value.barDetailization !== expectedDetailization) {
    context.addIssue({
      code: 'custom',
      path: ['barDetailization'],
      message: value.timeframe === '1m'
        ? '1m uses the native minute OHLC path because no sub-minute source is available'
        : 'Timeframes above 1m require automatic minute replay',
    });
  }
  if (value.timeframe === '1w') {
    const start = Date.parse(`${value.dateRange.start}T00:00:00.000Z`);
    const end = Date.parse(`${value.dateRange.end}T00:00:00.000Z`);
    const dayMs = 24 * 60 * 60 * 1_000;
    const selectedDays = Math.round((end - start) / dayMs) + 1;
    if (new Date(start).getUTCDay() !== 1 || new Date(end).getUTCDay() !== 0 || selectedDays % 7 !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['dateRange'],
        message: '1w ranges must start on Monday, end on Sunday, and contain complete UTC weeks',
      });
    }
  }
});

export const BacktestRequestSchema = BacktestRequestInputSchema.transform((value) => ({
  ...value,
  baseCurrency: (value.baseCurrency ?? (value.exchange === 'Binance' ? 'USDT' : 'USDC')) as 'USDT' | 'USDC',
  feeModel: (value.feeModel ?? (value.exchange === 'Binance' ? 'manual' : 'venue_default_all_taker_v1')) as 'manual' | 'venue_default_all_taker_v1',
  barDetailization: (value.timeframe === '1m' ? 'default' : 'high') as 'default' | 'high',
}));

export type BacktestRequest = z.infer<typeof BacktestRequestSchema>;

export interface NormalizedTrade {
  number: number;
  side: 'long' | 'short';
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  commission: number;
  durationBars: number;
  entrySignal: string;
  exitSignal: string;
}

export interface BacktestMetrics {
  initialCapital: number;
  endingEquity: number;
  netProfit: number;
  openProfit: number;
  totalProfit: number;
  netProfitPercent: number;
  totalProfitPercent: number;
  totalTrades: number;
  winRatePercent: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  profitFactor: number | null;
  averageTrade: number;
  longTrades: number;
  shortTrades: number;
  commissionPaid: number;
}

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface HighReplayBar extends Candle {
  parentBarIndex: number;
  replayBarIndex: number;
}

export interface HighReplayTick {
  parentBarIndex: number;
  replayBarIndex: number;
  stage: 'open' | 'firstExtreme' | 'secondExtreme' | 'close';
  sequence: number;
  sourceOpenTime: number;
  price: number;
  priceTicks: number;
}

export interface HighReplayPayload {
  replayBars: HighReplayBar[];
  replayTicks: HighReplayTick[];
  deriveTicksFromBars?: boolean;
}

export interface ReferenceComparison {
  status: 'MATCH' | 'DIFFERENT' | 'NOT_APPLICABLE';
  reference: string | null;
  mismatchCount: number;
  details: string[];
}

export interface HistoricalCandleRecoveryEvidence {
  version: '0xarchive-archived-trades-1m-v2';
  source: '0xArchive archived trades';
  endpoint: string;
  coverageFloor: string;
  requestedMissingTimestamps: number[];
  recoveredTimestamps: number[];
  noTradeTimestamps: number[];
  validatedNativeTimestamps: number[];
  pages: number;
  rawRows: number;
  acceptedTrades: number;
  requestIds: string[];
  tradesSha256: string;
  recoveredCandlesSha256: string;
  nativeCandlesSha256: string;
  ranges: Array<{
    startInclusive: number;
    endExclusive: number;
    pages: number;
    rawRows: number;
    acceptedTrades: number;
    requestIds: string[];
    tradesSha256: string;
  }>;
}

export interface BacktestResponse {
  runId: string;
  runtime: { name: 'PineTS'; version: '0.9.33'; isolatedProcess: true };
  data: {
    provider: '0xArchive' | 'Binance Futures';
    venue: 'hyperliquid' | 'binance';
    marketType: 'perpetual';
    symbol: string;
    tradingViewTicker: string;
    timeframe: BacktestTimeframe;
    bars: number;
    firstBar: string;
    lastBar: string;
    missingBars: number;
    fetchedPages: number;
    rawRows: number;
    sha256: string;
    recovery: HistoricalCandleRecoveryEvidence | null;
    barIndexOffset: number;
    instrument: {
      sizeDecimals: number;
      mintick: number;
      minContract: number;
      maxLeverage: number | null;
      mintickModel: 'hyperliquid-minimum-increment-v1' | 'binance-futures-price-filter-v1';
    };
    intrabar: null | {
      source: '0xArchive Hyperliquid candles' | 'Binance Futures candles';
      sourceTimeframe: '1m';
      replayTimeframe: '1m';
      bars1m: number;
      replayBars: number;
      replayTicks: number;
      missingBars1m: number;
      sourceSha256: string;
      aggregateSha256: string;
      fetchedPages: number;
      recovery: HistoricalCandleRecoveryEvidence | null;
    };
  };
  configuration: {
    dateRange: { start: string; end: string };
    initialCapital: number;
    baseCurrency: 'USDC' | 'USDT';
    defaultOrderSizeValue: number;
    defaultOrderSizeType: 'fixed' | 'cash' | 'percent_of_equity';
    pyramiding: number;
    feeModel: 'venue_default_all_taker_v1' | 'manual';
    feeSchedule: VenueFeeScheduleV1 | null;
    liquidityAssumption: 'all_taker' | 'uniform_manual';
    commissionType: 'percent' | 'cash_per_contract' | 'cash_per_order';
    commissionValue: number;
    pineVersion: 5 | 6 | null;
    marginLongPercent: number;
    marginShortPercent: number;
    slippageTicks: number;
    barDetailization: 'default' | 'high';
    executionModelVersion: 'default-v2' | 'minute-replay-v1';
    chartTimeframe: BacktestTimeframe;
    scriptExecution: ['on_bar_close'];
    orderExecutionDelay: 'one_tick';
    calcOnOrderFills: false;
    calcOnEveryTick: false;
    calcOnEveryHistoryTick: false;
    limitOrderVerificationTicks: 0;
    processOrdersOnClose: false;
    timezone: 'UTC';
  };
  metrics: BacktestMetrics;
  trades: NormalizedTrade[];
  chart: { candles: ChartCandle[] };
  comparison: ReferenceComparison;
  durationMs: number;
  warnings: string[];
}

export interface PresetResponse {
  id: 'BN01';
  name: string;
  source: string;
  sourceSha256: string;
  configuration: {
    exchange: 'Binance';
    marketType: 'Perpetual';
    symbol: string;
    timeframe: BacktestTimeframe;
    dateRange: { start: string; end: string };
    initialCapital: number;
    baseCurrency: 'USDT';
    defaultOrderSizeValue: number;
    defaultOrderSizeType: 'fixed' | 'cash' | 'percent_of_equity';
    pyramiding: number;
    feeModel: 'manual';
    feeSchedule: null;
    liquidityAssumption: 'uniform_manual';
    commissionType: 'percent';
    commissionValue: null;
    slippageTicks: number;
    timezone: 'UTC';
  };
}

export interface WorkerRequest {
  source: string;
  candles: Candle[];
  barIndexOffset: number;
  market: {
    tickerId: string;
    symbol: string;
    exchange?: 'Binance' | 'Hyperliquid';
    quoteCurrency?: 'USDT' | 'USDC';
    timeframe: BacktestTimeframe;
    pineTimeframe: string;
    mintick: number;
    minContract: number;
  };
  highReplay?: HighReplayPayload;
  execution: {
    initialCapital: number;
    defaultOrderSizeValue: number;
    defaultOrderSizeType: 'fixed' | 'cash' | 'percent_of_equity';
    pyramiding: number;
    commissionType: 'percent' | 'cash_per_contract' | 'cash_per_order';
    commissionValue: number;
    marginLongPercent?: number;
    marginShortPercent?: number;
    slippageTicks: number;
  };
}

export interface WorkerSuccess {
  ok: true;
  metrics: BacktestMetrics;
  trades: NormalizedTrade[];
  resourceUsage: {
    /** Peak resident set size reported by Node's process.resourceUsage(). */
    maxRssKb: number;
  };
  execution: {
    pineVersion: 5 | 6 | null;
    marginLongPercent: number;
    marginShortPercent: number;
    defaultOrderSizeValue: number;
    defaultOrderSizeType: 'fixed' | 'cash' | 'percent_of_equity';
    pyramiding: number;
    commissionType: 'percent' | 'cash_per_contract' | 'cash_per_order';
    commissionValue: number;
    slippageTicks: number;
    legacyMarginDefaultsApplied: boolean;
  };
}

export interface WorkerFailure {
  ok: false;
  error: {
    message: string;
    kind:
      | 'compile'
      | 'runtime'
      | 'worker'
      | 'unsupported-feature'
      | 'HIGH_UNSUPPORTED_SYMBOL'
      | 'HIGH_UNSUPPORTED_TIMEFRAME'
      | 'HIGH_UNSUPPORTED_BAR_INDEX_OFFSET'
      | 'HIGH_UNSUPPORTED_SCRIPT_EXECUTION'
      | 'HIGH_UNSUPPORTED_ORDER_FEATURE'
      | 'HIGH_MARGIN_CALL_UNSUPPORTED';
  };
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;
