import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { BinanceFuturesMarketList, BinanceFuturesMarketOption } from '../../../../packages/shared/src/binance-market-list-contracts';
import { loadBinanceFuturesMarkets } from '../lib/api';
import { InfoTooltip } from './TranslatedText';
import './BinanceMarketSelector.css';

const EXACT_SYMBOL = /^[A-Z0-9]+USDT$/;

export function filterBinanceMarkets(markets: BinanceFuturesMarketOption[], query: string): BinanceFuturesMarketOption[] {
  const needle = query.trim().toUpperCase();
  return needle ? markets.filter((market) => market.symbol.includes(needle)) : markets;
}

export function canUseExactBinanceSymbol(query: string, markets: BinanceFuturesMarketOption[]): boolean {
  const symbol = query.trim().toUpperCase();
  return EXACT_SYMBOL.test(symbol)
    && !markets.some((market) => market.symbol === symbol);
}

interface BinanceMarketSelectorProps {
  value: string;
  onChange: (symbol: string) => void;
  disabled?: boolean;
}

export function BinanceMarketSelector({ value, onChange, disabled = false }: BinanceMarketSelectorProps) {
  const id = useId();
  const listId = `${id}-markets`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [catalog, setCatalog] = useState<BinanceFuturesMarketList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [openAbove, setOpenAbove] = useState(false);
  const [popoverHeight, setPopoverHeight] = useState(360);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadBinanceFuturesMarkets(controller.signal).then((response) => {
      setCatalog(response);
      setError(false);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [retry]);

  const markets = catalog?.markets ?? [];
  const filtered = useMemo(() => filterBinanceMarkets(markets, query), [markets, query]);
  const exactChoice = canUseExactBinanceSymbol(query, markets);
  const choiceCount = filtered.length + (exactChoice ? 1 : 0);

  function choose(symbol: string) {
    onChange(symbol);
    setQuery('');
    setOpen(false);
    setActiveIndex(0);
  }

  function positionPopover() {
    const bounds = inputRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const below = window.innerHeight - bounds.bottom - 8;
    const above = bounds.top - 8;
    const placeAbove = below < 300 && above > below;
    setOpenAbove(placeAbove);
    setPopoverHeight(Math.max(120, Math.min(360, placeAbove ? above : below)));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      setQuery('');
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      positionPopover();
      setOpen(true);
      setActiveIndex((current) => Math.max(0, Math.min(choiceCount - 1, current + (event.key === 'ArrowDown' ? 1 : -1))));
      return;
    }
    if (event.key === 'Enter' && open && choiceCount > 0) {
      event.preventDefault();
      const market = filtered[activeIndex];
      if (market) choose(market.symbol);
      else if (exactChoice) choose(query.trim().toUpperCase());
    }
  }

  const selectedOutside = Boolean(catalog && value && !markets.some((market) => market.symbol === value));
  const fetchedAt = catalog ? new Date(catalog.fetchedAt).toLocaleString('en-GB', {
    timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short',
  }) : null;

  return (
    <div className="binance-market-selector">
      <div className="binance-market-label"><label htmlFor={id}>Symbol</label><InfoTooltip label="symbol list" en="Search the 100 Binance USD-M USDT perpetual symbols supported by this backtester's symbol format with the largest rolling 24-hour quote turnover. Turnover is a liquidity proxy, not a guarantee of fill quality or historical data coverage." ru="Поиск среди 100 бессрочных USDT-контрактов Binance USD-M с поддерживаемыми названиями и наибольшим оборотом за последние 24 часа. Оборот — лишь ориентир ликвидности, а не гарантия исполнения или полноты истории." /></div>
      <div className="binance-market-input-row">
        <input ref={inputRef} id={id} type="text" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
          aria-activedescendant={open && choiceCount > 0 ? `${listId}-option-${activeIndex}` : undefined}
          value={open ? query : value} placeholder="Search BTC, HYPE…"
          onFocus={() => { positionPopover(); setQuery(''); setActiveIndex(0); setOpen(true); }}
          onChange={(event) => { positionPopover(); setQuery(event.target.value.toUpperCase()); setActiveIndex(0); setOpen(true); }}
          onKeyDown={handleKeyDown}
          onBlur={() => { setOpen(false); setQuery(''); }} disabled={disabled} />
        <button type="button" aria-label="Browse Binance markets" disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { positionPopover(); setQuery(''); setActiveIndex(0); setOpen((current) => !current); inputRef.current?.focus(); }}>
          ▾
        </button>
      </div>
      {open && !disabled && (
        <div className={`binance-market-popover${openAbove ? ' above' : ''}`} style={{ maxHeight: popoverHeight }}>
          <div className="binance-market-popover-head">
            <strong>{catalog ? `Top ${markets.length} supported of ${catalog.rankedMarketCount} observed` : 'Binance USDT perps'} · 24h turnover</strong>
            {catalog && <span>{catalog.sourceStatus === 'stale' || error ? 'Stale' : 'As of'} {fetchedAt} UTC</span>}
          </div>
          {loading && !catalog && <p role="status">Loading Binance markets…</p>}
          {error && <p role="alert">Market list unavailable. Enter an exact USDT symbol, or <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setRetry((value) => value + 1)}>retry</button>.</p>}
          {catalog?.sourceStatus === 'stale' && !error && <p role="status">Binance is unavailable; this list is an older snapshot.</p>}
          {catalog && catalog.excludedUnsupportedCount > 0 && <p role="status">{catalog.excludedUnsupportedCount} Binance symbol{catalog.excludedUnsupportedCount === 1 ? ' is' : 's are'} excluded by this backtester’s symbol format.</p>}
          {catalog && catalog.missingMarketCount > 0 && <p role="status">{catalog.missingMarketCount} active market{catalog.missingMarketCount === 1 ? '' : 's'} lack a usable ticker; ranking may be incomplete.</p>}
          {selectedOutside && <p role="status">{value} is outside this top 100. It remains selected; the backtest server checks it.</p>}
          {!loading && !error && choiceCount === 0 && <p role="status">No matching market. Search another symbol.</p>}
          {choiceCount > 0 && <div id={listId} role="listbox" className="binance-market-options" aria-label="Binance Futures markets">
            {filtered.map((market, index) => (
              <button key={market.symbol} id={`${listId}-option-${index}`} type="button" role="option"
                aria-selected={market.symbol === value} className={index === activeIndex ? 'active' : ''}
                onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(market.symbol)}>
                <span><b>{market.symbol}</b><small>#{market.rank} by 24h turnover</small></span>
                <span>{new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(market.quoteVolume24hUsdt)} USDT</span>
              </button>
            ))}
            {exactChoice && <button id={`${listId}-option-${filtered.length}`} type="button" role="option"
              aria-selected={false} className={activeIndex === filtered.length ? 'active' : ''}
              onMouseEnter={() => setActiveIndex(filtered.length)} onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(query.trim().toUpperCase())}>
              <span><b>Use {query.trim().toUpperCase()}</b><small>Outside top 100; server validates availability</small></span>
            </button>}
          </div>}
        </div>
      )}
    </div>
  );
}
