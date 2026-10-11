import {
  BACKTEST_TIMEFRAME_MS,
  type BacktestTimeframe,
  type Candle,
} from '../../shared/src/contracts.js';

export interface HistoricalMarketDataQuery {
  symbol: string;
  interval: BacktestTimeframe;
  startInclusive: number;
  endExclusive: number;
  signal?: AbortSignal;
}

export interface HistoricalTradeRecoveryRangeProvenance {
  startInclusive: number;
  endExclusive: number;
  pages: number;
  rawRows: number;
  acceptedTrades: number;
  requestIds: string[];
  tradesSha256: string;
}

export interface HistoricalCandleRecoveryProvenance {
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
  ranges: HistoricalTradeRecoveryRangeProvenance[];
}

export interface HistoricalMarketDataResult {
  candles: Candle[];
  provenance: {
    provider: '0xArchive' | 'Binance Futures';
    venue: 'hyperliquid' | 'binance';
    symbol: string;
    interval: BacktestTimeframe;
    fetchedAt: string;
    pages: number;
    rawRows: number;
    sha256: string;
    /** Present only when missing native 1m candles were reconstructed and validated. */
    recovery?: HistoricalCandleRecoveryProvenance | null;
  };
}

export interface HistoricalInstrumentResult {
  symbol: string;
  szDecimals: number;
  /** Exchange price filter; kept distinct from Hyperliquid's quantity-derived mintick. */
  priceTickSize?: number;
  quantityStepSize?: number;
  minQuantity?: number;
  maxLeverage: number | null;
  isActive: boolean;
  instrumentType: 'perp' | 'spot' | null;
  provenance: {
    provider: '0xArchive' | 'Binance Futures';
    venue: 'hyperliquid' | 'binance';
    requestId: string | null;
    fetchedAt: string;
  };
}

export interface HistoricalMarketDataProvider {
  getCandles(query: HistoricalMarketDataQuery): Promise<HistoricalMarketDataResult>;
  getInstrument(symbol: string, signal?: AbortSignal): Promise<HistoricalInstrumentResult>;
}

export function timeframeToMs(timeframe: BacktestTimeframe): number {
  const milliseconds = BACKTEST_TIMEFRAME_MS[timeframe];
  if (milliseconds === undefined) {
    throw new Error(`Unsupported historical timeframe: ${String(timeframe)}`);
  }
  return milliseconds;
}
