import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../apps/web/src/App';
import {
  BinanceMarketSelector,
  canUseExactBinanceSymbol,
  filterBinanceMarkets,
} from '../apps/web/src/components/BinanceMarketSelector';

const markets = [
  { rank: 1, symbol: 'BTCUSDT', quoteVolume24hUsdt: 1000 },
  { rank: 2, symbol: 'HYPEUSDT', quoteVolume24hUsdt: 500 },
];

describe('Binance market selector', () => {
  it('filters the ranked list and keeps exact symbols outside the top 100 possible', () => {
    expect(filterBinanceMarkets(markets, 'hype').map((market) => market.symbol)).toEqual(['HYPEUSDT']);
    expect(canUseExactBinanceSymbol('SOLUSDT', markets)).toBe(true);
    expect(canUseExactBinanceSymbol('BTCUSDT', markets)).toBe(false);
    expect(canUseExactBinanceSymbol('INVALID/USDT', markets)).toBe(false);
  });

  it('renders a labeled, searchable combobox with the current symbol preserved', () => {
    const html = renderToStaticMarkup(createElement(BinanceMarketSelector, {
      value: 'HYPEUSDT', onChange: () => undefined,
    }));
    expect(html).toContain('>Symbol</label>');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('value="HYPEUSDT"');
    expect(html).toContain('aria-label="Information about symbol list"');
    expect(html).toContain('Оборот — лишь ориентир ликвидности');
  });

  it('uses the market selector for the backtest Symbol field', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="Browse Binance markets"');
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain('placeholder="BTCUSDT"');
  });
});
