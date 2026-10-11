export interface BinanceFuturesMarketOption {
  rank: number;
  symbol: string;
  quoteVolume24hUsdt: number;
}

export interface BinanceFuturesMarketList {
  exchange: 'Binance';
  marketType: 'Perpetual';
  quoteAsset: 'USDT';
  ranking: 'rolling_24h_quote_volume';
  fetchedAt: string;
  sourceStatus: 'live' | 'cached' | 'stale';
  eligibleMarketCount: number;
  excludedUnsupportedCount: number;
  rankedMarketCount: number;
  missingMarketCount: number;
  markets: BinanceFuturesMarketOption[];
}
