export interface PineSymbolMarket {
  readonly tickerId: string;
  readonly symbol: string;
  readonly exchange?: 'Binance' | 'Hyperliquid' | 'Lighter';
  readonly quoteCurrency?: 'USDT' | 'USDC';
  readonly mintick: number;
  readonly minContract: number;
}

/** syminfo.* values for a USD(T/C) linear perpetual, shared by backtest and Paper. */
export function pineSymbolInfo(market: PineSymbolMarket) {
  const pricescale = Math.round(1 / market.mintick);
  const isBinance = market.exchange === 'Binance';
  const quoteCurrency = market.quoteCurrency ?? 'USDC';
  const baseSymbol = isBinance && market.symbol.endsWith(quoteCurrency)
    ? market.symbol.slice(0, -quoteCurrency.length)
    : market.symbol;
  const prefix = isBinance ? 'BINANCE' : market.exchange === 'Lighter' ? 'LIGHTER' : 'HYPERLIQUID';
  return {
    current_contract: '',
    description: `${baseSymbol} / ${quoteCurrency} perpetual`,
    isin: '',
    main_tickerid: market.tickerId,
    prefix,
    root: baseSymbol,
    ticker: isBinance ? `${market.symbol}.P` : `${market.symbol}${quoteCurrency}.P`,
    tickerid: market.tickerId,
    type: 'futures',
    basecurrency: baseSymbol,
    country: '',
    currency: quoteCurrency,
    timezone: 'Etc/UTC',
    employees: 0,
    industry: '',
    sector: '',
    shareholders: 0,
    shares_outstanding_float: 0,
    shares_outstanding_total: 0,
    expiration_date: 0,
    session: '24x7',
    volumetype: 'base',
    mincontract: market.minContract,
    minmove: 1,
    mintick: market.mintick,
    pointvalue: 1,
    pricescale,
    recommendations_buy: 0,
    recommendations_buy_strong: 0,
    recommendations_date: 0,
    recommendations_hold: 0,
    recommendations_sell: 0,
    recommendations_sell_strong: 0,
    recommendations_total: 0,
    target_price_average: 0,
    target_price_date: 0,
    target_price_estimates: 0,
    target_price_high: 0,
    target_price_low: 0,
    target_price_median: 0,
  };
}
