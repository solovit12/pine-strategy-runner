import { AlertTriangle, ArrowLeft, ArrowRight, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readPaperDraft, writePaperDraft } from '../lib/editor-draft';
import { isXyzMarket } from '../lib/stock-hours';
import { XyzHoursNotice } from './XyzHoursNotice';
import { ExchangeLimitsForecast, useExchangeLoad } from './ExchangeLimits';
import { forecastRun, runLoadPlan } from '../../../../packages/shared/src/exchange-load';
import {
  LIVE_MAX_EXCHANGE_STOP_PERCENT, LIVE_MAX_LEVERAGE, MAX_MARKETS_PER_VENUE, PAPER_MARKET_SYMBOL_PATTERN, PINE_LIVE_TIMEFRAMES, pythonStrategyRef,
  type PineLivePaperSettingsV1, type PythonLivePaperSettingsV1, type StrategyDetail, type StrategySummary,
} from '../../../../packages/shared/src/strategy-catalog-contracts';
import {
  liveAccountBusyMessage, PineLivePaperLaunchSettingsV1Schema, PythonLivePaperLaunchSettingsV1Schema,
  type LiveAccountFees, type LiveAccountView, type LiveExchange,
} from '../../../../packages/shared/src/paper-experiment-contracts';
import {
  ApiResponseError, createPaperExperiment, loadLiveAccountFees, loadLiveAccounts, loadPaperCapabilities, loadPaperMarkets, loadPythonStrategies, loadStrategy, loadVenueVolumes,
  type PaperCapabilities, type PythonStrategyInfo, type PythonStrategyParam,
} from '../lib/api';
import { findSavedPythonStrategy } from '../lib/python-strategy-library';
import { InfoTooltip } from './TranslatedText';
import { ZodError } from 'zod';
import { accountIdentity, EXCHANGE_NAMES } from './LiveSettings';
import { EDITION, liveTradingAvailable, pythonStrategiesAvailable, type Edition } from '../../../../packages/shared/src/edition';

type Venue = 'Hyperliquid' | 'Lighter';
type Timeframe = typeof PINE_LIVE_TIMEFRAMES[number];
const VENUES: readonly Venue[] = ['Hyperliquid', 'Lighter'];
const MAX_PER_VENUE = MAX_MARKETS_PER_VENUE;
/** Public base-tier perpetual fees (percent); editable before launch. */
/** Markets of a new run in both editions (the owner's standard set); a saved strategy keeps its own. */
export const DEFAULT_PAPER_MARKETS: Readonly<Record<'Hyperliquid' | 'Lighter', readonly string[]>> = {
  Hyperliquid: ['xyz:XYZ100', 'xyz:CL', 'xyz:BRENTOIL', 'xyz:NVDA', 'xyz:SP500', 'xyz:SILVER', 'xyz:SNDK', 'xyz:MU', 'xyz:SKHX', 'xyz:SKHY'],
  Lighter: ['HYPE', 'SOL', 'XRP', 'SUI', 'DOGE', 'LIT', '1000SHIB', 'ADA', 'QQQ', 'PUMP'],
};

export const DEFAULT_PAPER_FEES = {
  hyperliquidMakerFeePercent: 0.015, hyperliquidTakerFeePercent: 0.045,
  lighterMakerFeePercent: 0, lighterTakerFeePercent: 0,
} as const;

type LiveSettings = PineLivePaperSettingsV1 | PythonLivePaperSettingsV1;

function isPineLive(settings: unknown): settings is PineLivePaperSettingsV1 {
  return !!settings && typeof settings === 'object' && (settings as { accountModel?: unknown }).accountModel === 'pine_live_v1';
}

function isPythonLive(settings: unknown): settings is PythonLivePaperSettingsV1 {
  return !!settings && typeof settings === 'object' && (settings as { accountModel?: unknown }).accountModel === 'python_live_v1';
}

function isLive(settings: unknown): settings is LiveSettings {
  return isPineLive(settings) || isPythonLive(settings);
}

/** Text field value -> typed parameter (NaN / '' surface as validation errors). */
export function parseParam(spec: PythonStrategyParam, value: string): number | boolean | string {
  if (spec.type === 'bool') return value === 'true';
  if (spec.type === 'str') return value;
  return value.trim() === '' ? Number.NaN : Number(value.replace(',', '.'));
}

export function paramError(name: string, spec: PythonStrategyParam, value: number | boolean | string): string | null {
  const label = spec.label || name;
  if (spec.type === 'int' && !Number.isInteger(value)) return `${label} must be a whole number.`;
  if (spec.type === 'float' && (typeof value !== 'number' || !Number.isFinite(value))) return `${label} must be a number.`;
  if (spec.choices && !spec.choices.includes(value as never)) return `${label} must be one of ${spec.choices.join(', ')}.`;
  if (typeof value === 'number' && spec.min !== null && value < spec.min) return `${label} must be at least ${spec.min}.`;
  if (typeof value === 'number' && spec.max !== null && value > spec.max) return `${label} must be at most ${spec.max}.`;
  return null;
}

/** Base asset from a backtest symbol such as BTCUSDT or HYPE. */
export function baseMarket(symbol: string | undefined): string | null {
  if (!symbol) return null;
  const base = symbol.toUpperCase().replace(/[-_:/.].*$/, '').replace(/(USDT|USDC|USD|PERP)$/, '');
  return PAPER_MARKET_SYMBOL_PATTERN.test(base) ? base : null;
}

type FeeFields = Record<keyof typeof DEFAULT_PAPER_FEES, string>;

/** Empty fee fields (e.g. in a draft saved before defaults existed) get the exchange's standard fee. */
function withDefaultFees(fees: FeeFields): FeeFields {
  const entries = Object.entries(DEFAULT_PAPER_FEES) as Array<[keyof typeof DEFAULT_PAPER_FEES, number]>;
  return Object.fromEntries(entries.map(([key, fee]) => [key, fees[key].trim() === '' ? String(fee) : fees[key]])) as FeeFields;
}

export function paperSettingsEqual(a: LiveSettings, b: unknown): boolean {
  if (!isLive(b) || a.accountModel !== b.accountModel) return false;
  if (isPythonLive(a) && isPythonLive(b) && (a.strategyRef !== b.strategyRef
    || JSON.stringify(Object.entries(a.params).sort()) !== JSON.stringify(Object.entries(b.params).sort()))) return false;
  const tracks = (value: LiveSettings) => value.tracks.map(({ venue, market }) => `${venue}:${market}`).sort().join(',');
  return a.timeframe === b.timeframe && a.capitalPerVenue === b.capitalPerVenue && a.orderSizePercent === b.orderSizePercent
    && a.hyperliquidMakerFeePercent === b.hyperliquidMakerFeePercent && a.hyperliquidTakerFeePercent === b.hyperliquidTakerFeePercent
    && a.lighterMakerFeePercent === b.lighterMakerFeePercent && a.lighterTakerFeePercent === b.lighterTakerFeePercent
    && tracks(a) === tracks(b)
    && (a.live === undefined) === (b.live === undefined)
    && a.live?.dailyLossLimitPercent === b.live?.dailyLossLimitPercent && a.live?.maxLeverage === b.live?.maxLeverage
    && a.live?.exchangeStopPercent === b.live?.exchangeStopPercent && a.live?.exchangeStopFrom === b.live?.exchangeStopFrom
    && a.live?.maxSlippagePercent === b.live?.maxSlippagePercent && a.live?.maxPositionUsdc === b.live?.maxPositionUsdc
    && Boolean(a.live?.minimumOrderSize) === Boolean(b.live?.minimumOrderSize)
    && a.live?.accounts?.lighter === b.live?.accounts?.lighter && a.live?.accounts?.hyperliquid === b.live?.accounts?.hyperliquid;
}

export function validPaperSettings(settings: LiveSettings, limits: PaperCapabilities | null): string | null {
  if (settings.tracks.length < 1) return 'Choose at least one market.';
  for (const venue of VENUES) {
    const count = settings.tracks.filter((track) => track.venue === venue).length;
    if (count > (limits?.maxTracksPerVenue ?? MAX_PER_VENUE)) return `Choose at most ${limits?.maxTracksPerVenue ?? MAX_PER_VENUE} ${venue} markets.`;
  }
  if (!Number.isFinite(settings.capitalPerVenue) || settings.capitalPerVenue < 100) return 'Enter a starting balance of at least 100 USDC per exchange.';
  if (!Number.isFinite(settings.orderSizePercent) || settings.orderSizePercent <= 0 || settings.orderSizePercent > 100) return 'Order size must be above 0% and at most 100%.';
  const fees = [settings.hyperliquidMakerFeePercent, settings.hyperliquidTakerFeePercent, settings.lighterMakerFeePercent, settings.lighterTakerFeePercent];
  if (fees.some((fee) => fee === null || !Number.isFinite(fee) || fee < 0 || fee > 100)) return 'Enter all four fees from 0% to 100% (0 is allowed).';
  if (settings.live) {
    const { dailyLossLimitPercent, maxLeverage, exchangeStopPercent, maxSlippagePercent, maxPositionUsdc } = settings.live;
    if (maxPositionUsdc !== undefined && (!Number.isFinite(maxPositionUsdc) || maxPositionUsdc <= 0))
      return 'Enter a max position above 0 USDC, or leave it empty for none.';
    if (maxSlippagePercent !== undefined && (!Number.isFinite(maxSlippagePercent) || maxSlippagePercent < 0.05
      || maxSlippagePercent > 50)) return 'Enter a max slippage from 0.05% to 50%.';
    if (dailyLossLimitPercent !== undefined && (!Number.isFinite(dailyLossLimitPercent) || dailyLossLimitPercent < 1
      || dailyLossLimitPercent > 99)) return 'Enter a daily loss limit from 1% to 99%, or leave it empty for none.';
    if (!Number.isFinite(maxLeverage) || maxLeverage <= 0 || maxLeverage > LIVE_MAX_LEVERAGE) return `Enter the account leverage limit, above 0 and at most ${LIVE_MAX_LEVERAGE}x.`;
    if (!Number.isFinite(exchangeStopPercent) || exchangeStopPercent <= 0 || exchangeStopPercent > LIVE_MAX_EXCHANGE_STOP_PERCENT) return `Enter the exchange stop distance, above 0% and at most ${LIVE_MAX_EXCHANGE_STOP_PERCENT}%.`;
  }
  return null;
}

function parseNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value.replace(',', '.'));
}

function errorMessage(reason: unknown): string {
  // A settings check names its rule: show that sentence, not the checker's raw report.
  if (reason instanceof ZodError) return reason.issues.map((issue) => issue.message).join(' ');
  return reason instanceof Error ? reason.message : String(reason);
}

function sourceName(source: string): string {
  return /\bstrategy\s*\(\s*['"]([^'"]+)['"]/.exec(source)?.[1] || 'Current Pine editor source';
}

export interface PaperVersionRequest {
  readonly settings: LiveSettings;
  /** Save the editor's Pine code (new strategy or version) instead of the selected saved version. */
  readonly fromEditor: boolean;
  /** A Python pack strategy: saved (or reused) in the library under this name. */
  readonly python?: { readonly ref: string; readonly name: string };
}

type PaperSetupProps = {
  source: string;
  fromBacktest: boolean;
  /** Opened from the editor page: its code leads even without a backtest. */
  fromEditor?: boolean;
  /** Timeframe and symbol of the editor's backtest settings, used as defaults. */
  backtestTimeframe?: string;
  backtestSymbol?: string;
  strategies: StrategySummary[];
  savedStrategy: StrategyDetail | null;
  catalogBusy: boolean;
  onSelectStrategy: (id: string) => void;
  /** Persist the Pine source and these Paper settings as a version; resolves with it. */
  onPrepareVersion: (request: PaperVersionRequest) => Promise<StrategyDetail>;
  onBack: () => void;
  onRuns: () => void;
  /** Opens the Accounts page (LIVE accounts and their keys). */
  onAccounts?: () => void;
  /** Defaults to this build's edition; the public edition runs Pine code only. */
  edition?: Edition;
  /** A tab of the Strategy page: the editor is the strategy, so there is no own heading or source choice. */
  embedded?: boolean;
};

const usd = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * Picker order: exact symbol, then symbols starting with the query, then any match;
 * inside each group the most traded first (24 h USD volume), then by name.
 */
export function rankMarkets(options: readonly string[], query: string, selected: readonly string[],
  volumes: Readonly<Record<string, number>> | null): string[] {
  const needle = query.trim().toUpperCase();
  const group = (market: string) => {
    const upper = market.toUpperCase();
    return !needle ? 0 : upper === needle ? 0 : upper.startsWith(needle) ? 1 : upper.includes(needle) ? 2 : -1;
  };
  return options.filter((market) => !selected.includes(market) && group(market) >= 0)
    .sort((left, right) => group(left) - group(right)
      || (volumes?.[right] ?? -1) - (volumes?.[left] ?? -1)
      || left.localeCompare(right));
}

/** What a typed or pasted list of markets ("BTC, ETH sol") adds to one exchange, and what it cannot. */
export interface MarketListResult {
  readonly add: string[];
  readonly unknown: string[];
  readonly already: string[];
  readonly overLimit: string[];
}

/**
 * Several markets at once (owner, 2026-10-20): separated by commas, spaces, semicolons or new lines,
 * in any letter case; each is matched to the exchange's list, kept once, and added up to the limit.
 */
export function parseMarketList(text: string, options: readonly string[] | null, selected: readonly string[],
  limit: number): MarketListResult {
  const result: MarketListResult = { add: [], unknown: [], already: [], overLimit: [] };
  for (const token of text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean)) {
    const market = options === null
      ? (PAPER_MARKET_SYMBOL_PATTERN.test(token) ? token : null)
      : options.find((option) => option.toUpperCase() === token.toUpperCase()) ?? null;
    if (!market) result.unknown.push(token);
    else if (selected.includes(market) || result.add.includes(market)) { if (!result.already.includes(market)) result.already.push(market); }
    else if (selected.length + result.add.length >= limit) result.overLimit.push(market);
    else result.add.push(market);
  }
  return result;
}

/** `fee ×0.2` for a HIP-3 market; empty for the venue's ordinary fee. */
export function feeMultiplierLabel(multiplier: number | undefined): string {
  return multiplier === undefined || multiplier === 1 ? '' : `fee ×${Number(multiplier.toFixed(3))}`;
}

function MarketPicker({ venue, otherVenue, options, otherOptions, volumes, feeMultipliers, selected, onAdd, onRemove, error }: {
  venue: Venue; otherVenue: Venue; options: string[] | null; otherOptions: string[] | null;
  volumes: Record<string, number> | null; feeMultipliers: Record<string, number>; selected: string[]; error: string;
  onAdd: (markets: string[]) => void; onRemove: (market: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = `paper-markets-${venue.toLowerCase()}`;
  const ranked = useMemo(() => rankMarkets(options ?? [], draft, selected, volumes), [options, draft, selected, volumes]);
  const normalized = (options ?? []).find((market) => market.toUpperCase() === draft.trim().toUpperCase()) ?? draft.trim();
  const known = options === null || options.includes(normalized);
  const full = selected.length >= MAX_PER_VENUE;
  // A list ("BTC, ETH SOL"): every market in it is added at once.
  const many = /[\s,;]/.test(draft.trim());
  const add = (market = normalized) => {
    if (many) return addList(draft);
    if (!market || !PAPER_MARKET_SYMBOL_PATTERN.test(market) || full || selected.includes(market)
      || (options !== null && !options.includes(market))) return;
    onAdd([market]);
    setNotice('');
    setDraft('');
    setActive(0);
    setOpen(false); // show the new chip instead of keeping the list over it
  };
  const addList = (text: string) => {
    const result = parseMarketList(text, options, selected, MAX_PER_VENUE);
    if (result.add.length) onAdd(result.add);
    setNotice([
      result.add.length ? `Added ${result.add.length}: ${result.add.join(', ')}.` : 'Nothing added.',
      result.unknown.length ? `Not ${venue} perpetuals: ${result.unknown.join(', ')}.` : '',
      result.already.length ? `Already chosen: ${result.already.join(', ')}.` : '',
      result.overLimit.length ? `Over the ${MAX_PER_VENUE}-market limit: ${result.overLimit.join(', ')}.` : '',
    ].filter(Boolean).join(' '));
    setDraft(result.unknown.join(' ')); // what could not be added stays to be corrected
    setActive(0);
    setOpen(false);
  };
  const showList = open && options !== null && !full && !many;
  return (
    <div className="paper-venue-markets">
      <div className="paper-card-title"><h3>{venue}</h3><span className="paper-count-chip">{selected.length} / {MAX_PER_VENUE}</span></div>
      <div className="paper-market-add">
        <div className="paper-market-combo">
          <input role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
            placeholder={full ? `${MAX_PER_VENUE} markets chosen` : options ? `Choose from ${options.length} perpetuals, or type several: BTC, ETH SOL` : 'Markets, e.g. BTC, ETH SOL'}
            value={draft} aria-label={`Add ${venue} market`} disabled={full}
            onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => setOpen(false)}
            onChange={(event) => { setDraft(event.target.value); setActive(0); setOpen(true); }}
            onPaste={(event) => {
              // A pasted list is added at once; a single pasted market stays to be checked and added.
              const text = event.clipboardData.getData('text');
              if (!/[\s,;]/.test(text.trim())) return;
              event.preventDefault();
              addList(`${draft} ${text}`);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive((index) => Math.min(index + 1, ranked.length - 1)); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
              else if (event.key === 'Escape') setOpen(false);
              else if (event.key === 'Enter') { event.preventDefault(); add(showList && ranked[active] ? ranked[active] : normalized); }
            }} />
          {showList && <ul className="paper-market-list" id={listId} role="listbox" aria-label={`${venue} perpetuals`}>
            {ranked.map((market, index) => (
              <li key={market} role="option" aria-selected={index === active} className={index === active ? 'active' : ''}
                onMouseDown={(event) => { event.preventDefault(); add(market); }} onMouseEnter={() => setActive(index)}>
                <span className="paper-market-symbol">{market}</span>
                {otherOptions?.includes(market) ? <span className="paper-market-both" title={`Also listed on ${otherVenue}`}>+ {otherVenue}</span>
                  : <span className="paper-market-fee" title="This market's fee relative to the ordinary Hyperliquid fee entered above">{feeMultiplierLabel(feeMultipliers[market])}</span>}
                <span className="paper-market-volume">{volumes?.[market] !== undefined ? `$${usd.format(volumes[market]!)}` : ''}</span>
              </li>
            ))}
            {ranked.length === 0 && <li className="paper-market-none">No {venue} perpetual matches “{draft.trim()}”.</li>}
          </ul>}
        </div>
        <button type="button" className="paper-text-button" onClick={() => add()} disabled={!draft.trim() || (!known && !many) || full}><Plus size={14} />{many ? 'Add all' : 'Add'}</button>
      </div>
      {many && <small className="paper-market-hint">Several markets: Enter or “Add all” adds every one found on {venue}.</small>}
      {draft.trim() && !known && !many && <small className="paper-market-unavailable">{normalized} is not an active {venue} perpetual.</small>}
      {notice && <small className="paper-market-hint" role="status">{notice}</small>}
      {full && <small className="paper-market-unavailable">{MAX_PER_VENUE} markets is the limit per exchange: remove one (×) to add another.</small>}
      {error && <small className="paper-market-unavailable">Market list unavailable: {error}</small>}
      <ul className="paper-market-chips">
        {selected.map((market) => <li key={market}><span>{market}</span>
          {feeMultiplierLabel(feeMultipliers[market]) && <small className="paper-market-fee">{feeMultiplierLabel(feeMultipliers[market])}</small>}<button type="button" aria-label={`Remove ${venue} ${market}`} onClick={() => onRemove(market)}><X size={12} /></button></li>)}
        {selected.length === 0 && <li className="paper-market-chip-empty">No {venue} markets</li>}
      </ul>
    </div>
  );
}

export function PaperSetupPreview({ source, fromBacktest, fromEditor = fromBacktest, backtestTimeframe, backtestSymbol, strategies, savedStrategy, catalogBusy,
  onSelectStrategy, onPrepareVersion, onBack, onRuns, onAccounts, edition = EDITION, embedded = false }: PaperSetupProps) {
  const pythonAllowed = pythonStrategiesAvailable(edition);
  // Coming from a fresh backtest of other code, the editor leads: another saved
  // strategy's type, timeframe and markets must not be carried over.
  const startsFromEditor = !savedStrategy || (fromEditor && savedStrategy.version.source !== source);
  const saved = !startsFromEditor && isLive(savedStrategy?.version.paperSettings)
    ? savedStrategy!.version.paperSettings as LiveSettings : null;
  const initial = saved && isPythonLive(saved) && !pythonAllowed ? null : saved;
  // Settings changed before a page reload come back first (the Strategy page's Paper tab only).
  const [restored] = useState(() => {
    const draft = embedded ? readPaperDraft() : null;
    return draft && draft.kind === 'python' && !pythonAllowed ? null : draft;
  });
  /** The restored draft already holds this strategy's settings; do not overwrite it once they load. */
  const keepRestoredFor = useRef(restored?.strategyId ?? null);
  const [kind, setKind] = useState<'pine' | 'python'>(restored?.kind ?? (isPythonLive(initial) ? 'python' : 'pine'));
  const [pythonList, setPythonList] = useState<PythonStrategyInfo[] | null>(null);
  const [pythonError, setPythonError] = useState('');
  const [pythonRef, setPythonRef] = useState(restored?.pythonRef ?? (isPythonLive(initial) ? initial.strategyRef : ''));
  const [paramText, setParamText] = useState<Record<string, string>>(() => restored?.paramText ?? (isPythonLive(initial)
    ? Object.fromEntries(Object.entries(initial.params).map(([name, value]) => [name, String(value)])) : {}));
  const defaultTimeframe: Timeframe = (PINE_LIVE_TIMEFRAMES as readonly string[]).includes(backtestTimeframe ?? '')
    ? backtestTimeframe as Timeframe : '1h';
  const [sourceChoice, setSourceChoice] = useState<'saved' | 'editor'>(embedded || startsFromEditor ? 'editor' : 'saved');
  // Opened directly (not from a backtest), the screen waits for the last-run strategy, which
  // the app loads in the background, unless the user already chose something themselves.
  const awaitingLastRun = useRef(!savedStrategy && !fromEditor);
  useEffect(() => {
    if (!awaitingLastRun.current || !savedStrategy) return;
    awaitingLastRun.current = false;
    setSourceChoice('saved');
  }, [savedStrategy]);
  const [timeframe, setTimeframe] = useState<Timeframe>(restored?.timeframe ?? initial?.timeframe ?? defaultTimeframe);
  const [tracks, setTracks] = useState<Record<Venue, string[]>>(() => restored?.tracks ?? ({
    Hyperliquid: initial ? initial.tracks.filter((t) => t.venue === 'Hyperliquid').map((t) => t.market) : [...DEFAULT_PAPER_MARKETS.Hyperliquid],
    Lighter: initial ? initial.tracks.filter((t) => t.venue === 'Lighter').map((t) => t.market) : [...DEFAULT_PAPER_MARKETS.Lighter],
  }));
  const [capital, setCapital] = useState(restored?.capital ?? String(initial?.capitalPerVenue ?? 10_000));
  const [orderSize, setOrderSize] = useState(restored?.orderSize ?? String(initial?.orderSizePercent ?? 10));
  const [fees, setFees] = useState(() => restored ? withDefaultFees(restored.fees) : ({
    hyperliquidMakerFeePercent: String(initial?.hyperliquidMakerFeePercent ?? DEFAULT_PAPER_FEES.hyperliquidMakerFeePercent),
    hyperliquidTakerFeePercent: String(initial?.hyperliquidTakerFeePercent ?? DEFAULT_PAPER_FEES.hyperliquidTakerFeePercent),
    lighterMakerFeePercent: String(initial?.lighterMakerFeePercent ?? DEFAULT_PAPER_FEES.lighterMakerFeePercent),
    lighterTakerFeePercent: String(initial?.lighterTakerFeePercent ?? DEFAULT_PAPER_FEES.lighterTakerFeePercent),
  }));
  useEffect(() => {
    if (!embedded) return;
    writePaperDraft({ strategyId: savedStrategy?.strategy.id ?? null, kind, pythonRef, paramText, timeframe, tracks, capital, orderSize, fees });
  }, [embedded, savedStrategy?.strategy.id, kind, pythonRef, paramText, timeframe, tracks, capital, orderSize, fees]);
  const [markets, setMarkets] = useState<Record<Venue, string[] | null>>({ Hyperliquid: null, Lighter: null });
  const [marketErrors, setMarketErrors] = useState<Record<Venue, string>>({ Hyperliquid: '', Lighter: '' });
  const [volumes, setVolumes] = useState<Record<Venue, Record<string, number> | null>>({ Hyperliquid: null, Lighter: null });
  const [addToBoth, setAddToBoth] = useState(true);
  const [feeMultipliers, setFeeMultipliers] = useState<Record<Venue, Record<string, number>>>({ Hyperliquid: {}, Lighter: {} });
  const [capabilities, setCapabilities] = useState<PaperCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  // Live (real money) is never restored on its own: each Live launch is chosen and confirmed again.
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [liveFields, setLiveFields] = useState(() => ({
    dailyLossLimitPercent: initial?.live?.dailyLossLimitPercent !== undefined ? String(initial.live.dailyLossLimitPercent) : '',
    maxLeverage: initial?.live ? String(initial.live.maxLeverage) : '',
    exchangeStopPercent: initial?.live ? String(initial.live.exchangeStopPercent) : '',
    exchangeStopFrom: initial?.live?.exchangeStopFrom ?? 'strategy_stop' as 'strategy_stop' | 'entry_price',
    maxSlippagePercent: String(initial?.live?.maxSlippagePercent ?? 3),
    maxPositionUsdc: initial?.live?.maxPositionUsdc !== undefined ? String(initial.live.maxPositionUsdc) : '',
    minimumOrderSize: initial?.live?.minimumOrderSize === true,
  }));
  // The LIVE account each exchange trades (Accounts page); a saved draft brings its choice back.
  const [liveAccounts, setLiveAccounts] = useState<LiveAccountView[] | null>(null);
  const [accountChoice, setAccountChoice] = useState<Partial<Record<LiveExchange, string>>>(() => ({ ...(initial?.live?.accounts ?? {}) }));
  // LIVE: each chosen account's real fees on its exchange (or why they could not be read).
  const [liveFees, setLiveFees] = useState<Partial<Record<LiveExchange, LiveAccountFees | string>>>({});
  const [launchError, setLaunchError] = useState('');
  const [launching, setLaunching] = useState(false);
  const launchInFlight = useRef(false);
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadPaperCapabilities(controller.signal)
      .then((next) => { setCapabilities(next); setCapabilityError(''); })
      .catch((reason) => { if (!controller.signal.aborted) setCapabilityError(errorMessage(reason)); });
    for (const venue of VENUES) {
      loadPaperMarkets(venue === 'Lighter' ? 'lighter' : 'hyperliquid', controller.signal)
        .then(({ markets: list, feeMultipliers: multipliers }) => {
          setMarkets((current) => ({ ...current, [venue]: list }));
          setFeeMultipliers((current) => ({ ...current, [venue]: multipliers }));
          // Drop a default market the venue does not list.
          if (!initial) setTracks((current) => ({ ...current, [venue]: current[venue].filter((market) => list.includes(market)) }));
        })
        .catch((reason) => { if (!controller.signal.aborted) setMarketErrors((current) => ({ ...current, [venue]: errorMessage(reason) })); });
      // Only orders the picker; without volumes the list stays alphabetical.
      loadVenueVolumes(venue === 'Lighter' ? 'lighter' : 'hyperliquid', controller.signal)
        .then((result) => setVolumes((current) => ({ ...current, [venue]: result })))
        .catch(() => undefined);
    }
    if (pythonAllowed) loadPythonStrategies(controller.signal)
      .then((result) => { setPythonList(result.strategies); if (result.errors.length) setPythonError(result.errors.map((row) => `${row.pack}/${row.module}: ${row.error}`).join('; ')); })
      .catch((reason) => { if (!controller.signal.aborted) setPythonError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);

  const pythonInfo = pythonList?.find((row) => row.id === pythonRef) ?? null;
  const chosenPythonRef = useRef(pythonRef);

  const applySettings = (settings: LiveSettings) => {
    if (isPythonLive(settings) && !pythonAllowed) return;
    if (isPythonLive(settings)) {
      setKind('python');
      setPythonRef(settings.strategyRef);
      setParamText(Object.fromEntries(Object.entries(settings.params).map(([name, value]) => [name, String(value)])));
    }
    setTimeframe(settings.timeframe);
    setTracks({ Hyperliquid: settings.tracks.filter((t) => t.venue === 'Hyperliquid').map((t) => t.market),
      Lighter: settings.tracks.filter((t) => t.venue === 'Lighter').map((t) => t.market) });
    setCapital(String(settings.capitalPerVenue));
    setOrderSize(String(settings.orderSizePercent));
    if (settings.live) setLiveFields({
      dailyLossLimitPercent: settings.live.dailyLossLimitPercent !== undefined ? String(settings.live.dailyLossLimitPercent) : '',
      maxLeverage: String(settings.live.maxLeverage),
      exchangeStopPercent: String(settings.live.exchangeStopPercent), exchangeStopFrom: settings.live.exchangeStopFrom,
      maxSlippagePercent: String(settings.live.maxSlippagePercent ?? 3),
      maxPositionUsdc: settings.live.maxPositionUsdc !== undefined ? String(settings.live.maxPositionUsdc) : '',
      minimumOrderSize: settings.live.minimumOrderSize === true });
    if (settings.live?.accounts) setAccountChoice({ ...settings.live.accounts });
    setFees({
      // A strategy saved without fees gets each exchange's standard fee, not an empty field.
      hyperliquidMakerFeePercent: String(settings.hyperliquidMakerFeePercent ?? DEFAULT_PAPER_FEES.hyperliquidMakerFeePercent),
      hyperliquidTakerFeePercent: String(settings.hyperliquidTakerFeePercent ?? DEFAULT_PAPER_FEES.hyperliquidTakerFeePercent),
      lighterMakerFeePercent: String(settings.lighterMakerFeePercent ?? DEFAULT_PAPER_FEES.lighterMakerFeePercent),
      lighterTakerFeePercent: String(settings.lighterTakerFeePercent ?? DEFAULT_PAPER_FEES.lighterTakerFeePercent),
    });
  };

  /** A pack strategy starts from the settings it was last saved (launched) with, else from its defaults. */
  const choosePython = (ref: string) => {
    awaitingLastRun.current = false;
    chosenPythonRef.current = ref;
    setPythonRef(ref);
    const info = pythonList?.find((row) => row.id === ref);
    if (!info) return;
    setParamText(Object.fromEntries(Object.entries(info.params).map(([name, spec]) => [name, String(spec.default)])));
    if ((PINE_LIVE_TIMEFRAMES as readonly string[]).includes(info.timeframe)) setTimeframe(info.timeframe as Timeframe);
    void findSavedPythonStrategy(ref, strategies)
      .then((saved) => saved ? loadStrategy(saved.id) : undefined)
      .then((detail) => {
        if (chosenPythonRef.current !== ref || !detail || !isPythonLive(detail.version.paperSettings)) return;
        applySettings(detail.version.paperSettings);
      })
      .catch(() => undefined); // defaults stay; the library is optional here
  };

  // Opening a saved strategy in the editor brings its saved Paper settings along.
  useEffect(() => {
    if (!embedded || !savedStrategy || savedStrategy.version.source !== source || !isLive(savedStrategy.version.paperSettings)) return;
    if (keepRestoredFor.current === savedStrategy.strategy.id) {
      keepRestoredFor.current = null;
      return;
    }
    applySettings(savedStrategy.version.paperSettings as LiveSettings);
  }, [embedded, savedStrategy?.strategy.id, savedStrategy?.version.version]);

  // Selecting another saved strategy loads its saved Paper settings.
  useEffect(() => {
    if (sourceChoice !== 'saved' || !savedStrategy || !isLive(savedStrategy.version.paperSettings)) return;
    chosenPythonRef.current = isPythonLive(savedStrategy.version.paperSettings) ? savedStrategy.version.paperSettings.strategyRef : '';
    applySettings(savedStrategy.version.paperSettings as LiveSettings);
  }, [savedStrategy?.strategy.id, savedStrategy?.version.version, sourceChoice]);

  const pythonParams = useMemo(() => Object.fromEntries(Object.entries(pythonInfo?.params ?? {})
    .map(([name, spec]) => [name, parseParam(spec, paramText[name] ?? String(spec.default))])), [pythonInfo, paramText]);
  // The LIVE choice is offered in every edition; it trades on the exchanges whose account is connected and switched on.
  const liveOffered = liveTradingAvailable(edition) && capabilities !== null;
  const liveAllowed = liveOffered && capabilities?.liveTrading === true;
  const liveChosen = mode === 'live' && liveOffered;
  const live = liveChosen && liveAllowed;
  const liveVenues: readonly Venue[] = VENUES.filter((venue) => (capabilities?.liveExchanges ?? ['lighter'])
    .includes(venue === 'Lighter' ? 'lighter' : 'hyperliquid'));
  const liveNames = liveVenues.join(' and ') || 'the exchange';
  useEffect(() => {
    if (mode !== 'live' || !liveOffered) return;
    const controller = new AbortController();
    const load = () => loadLiveAccounts(controller.signal).then((view) => setLiveAccounts([...view.accounts])).catch(() => { /* keep the last list */ });
    void load();
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [mode, liveOffered]);
  /** Exchanges of this LIVE run: those with markets chosen. */
  const runExchanges: LiveExchange[] = liveVenues.filter((venue) => tracks[venue].length > 0)
    .map((venue) => venue === 'Lighter' ? 'lighter' as const : 'hyperliquid' as const);
  const usableAccounts = (exchange: LiveExchange) => (liveAccounts ?? [])
    .filter((account) => account.exchange === exchange && account.enabled && account.keySaved);
  // An exchange without a choice takes its first free account; a chosen account that is gone falls back too.
  const chosenAccounts: Partial<Record<LiveExchange, string>> = Object.fromEntries(runExchanges.flatMap((exchange) => {
    const usable = usableAccounts(exchange);
    const chosen = usable.find((account) => account.id === accountChoice[exchange])
      ?? usable.find((account) => !account.runId) ?? usable[0];
    return chosen ? [[exchange, chosen.id]] : [];
  }));
  const chosenKey = live ? JSON.stringify(chosenAccounts) : '';
  useEffect(() => {
    if (!chosenKey) return;
    const controller = new AbortController();
    const chosen = JSON.parse(chosenKey) as Partial<Record<LiveExchange, string>>;
    for (const [exchange, id] of Object.entries(chosen) as Array<[LiveExchange, string]>) {
      loadLiveAccountFees(id, controller.signal).then((fees) => {
        setLiveFees((current) => ({ ...current, [exchange]: fees }));
        // The fee fields show the account's own rates while LIVE is chosen.
        setFees((current) => ({ ...current, ...(exchange === 'hyperliquid'
          ? { hyperliquidMakerFeePercent: String(fees.makerPercent), hyperliquidTakerFeePercent: String(fees.takerPercent) }
          : { lighterMakerFeePercent: String(fees.makerPercent), lighterTakerFeePercent: String(fees.takerPercent) }) }));
      }).catch((reason) => {
        if (!controller.signal.aborted) setLiveFees((current) => ({ ...current, [exchange]: errorMessage(reason) }));
      });
    }
    return () => controller.abort();
  }, [chosenKey]);
  const feesLocked = (exchange: LiveExchange) => live && typeof liveFees[exchange] === 'object';
  const draft: LiveSettings = useMemo(() => ({
    ...(kind === 'python'
      ? { accountModel: 'python_live_v1' as const, strategyRef: pythonRef, params: pythonParams }
      : { accountModel: 'pine_live_v1' as const }),
    timeframe,
    // Live trades the connected exchanges; the selection of another one stays for Paper.
    tracks: (live ? liveVenues : VENUES).flatMap((venue) => tracks[venue].map((market) => ({ venue, market }))),
    capitalPerVenue: parseNumber(capital),
    orderSizePercent: parseNumber(orderSize),
    hyperliquidMakerFeePercent: parseNumber(fees.hyperliquidMakerFeePercent),
    hyperliquidTakerFeePercent: parseNumber(fees.hyperliquidTakerFeePercent),
    lighterMakerFeePercent: parseNumber(fees.lighterMakerFeePercent),
    lighterTakerFeePercent: parseNumber(fees.lighterTakerFeePercent),
    ...(live ? { live: {
      // Empty: no daily limit.
      ...(liveFields.dailyLossLimitPercent.trim() === '' ? {} : { dailyLossLimitPercent: parseNumber(liveFields.dailyLossLimitPercent) }),
      maxLeverage: parseNumber(liveFields.maxLeverage),
      exchangeStopPercent: parseNumber(liveFields.exchangeStopPercent), exchangeStopFrom: liveFields.exchangeStopFrom,
      maxSlippagePercent: parseNumber(liveFields.maxSlippagePercent),
      // Empty: no cap.
      ...(liveFields.maxPositionUsdc.trim() === '' ? {} : { maxPositionUsdc: parseNumber(liveFields.maxPositionUsdc) }),
      ...(liveFields.minimumOrderSize ? { minimumOrderSize: true } : {}),
      ...(Object.keys(chosenAccounts).length ? { accounts: chosenAccounts } : {}) } } : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [kind, pythonRef, pythonParams, timeframe, tracks, capital, orderSize, fees, live, liveFields, JSON.stringify(chosenAccounts)]);
  const selectedSource = sourceChoice === 'saved' && savedStrategy ? savedStrategy.version.source : source;
  const paramsError = pythonInfo ? Object.entries(pythonInfo.params)
    .map(([name, spec]) => paramError(name, spec, pythonParams[name]!)).find(Boolean) ?? null : null;
  const accountBlocker = (() => {
    for (const exchange of runExchanges) {
      const account = (liveAccounts ?? []).find((row) => row.id === chosenAccounts[exchange]);
      if (!account) return `Add a ${EXCHANGE_NAMES[exchange]} account on the Accounts page, or remove the ${EXCHANGE_NAMES[exchange]} markets.`;
      if (account.runId) return liveAccountBusyMessage(account.name);
    }
    return null;
  })();
  const settingsError = validPaperSettings(draft, capabilities) ?? (kind === 'python'
    ? (!pythonInfo ? 'Choose a Python strategy.' : paramsError) : null);
  // A LIVE run Hyperliquid would refuse connections to does not start (the engine refuses it too).
  const exchangeLoad = useExchangeLoad(draft.tracks.length > 0);
  const loadRefusal = live && exchangeLoad ? forecastRun(exchangeLoad, runLoadPlan(draft)).refusal : null;
  const launchBlocker = !capabilities
    ? capabilityError ? `Cannot check Paper availability: ${capabilityError}` : 'Checking Paper availability…'
    : !capabilities.available
      ? capabilities.reason || 'Paper launch is not available on this server.'
      : kind === 'pine' && !selectedSource.trim()
        ? 'Paste a Pine strategy in the editor first.'
        : kind === 'pine' && sourceChoice === 'saved' && !savedStrategy
          ? 'Choose a saved strategy or use the editor code.'
          : liveChosen && !liveAllowed
            ? 'Add your exchange account on the Accounts page and switch LIVE on for it first.'
          : live && liveAccounts === null
            ? 'Loading your LIVE accounts…'
          : live && accountBlocker
            ? accountBlocker
          : loadRefusal
            ? 'Exchange limit: Hyperliquid would not open this LIVE run\'s connections (see the note above).'
            : settingsError ?? (live && !liveConfirmed ? 'Confirm that this run trades real money.' : null);
  const willSave = kind === 'python' || sourceChoice === 'editor' || !savedStrategy
    || pythonStrategyRef(savedStrategy.version.source) !== null || !paperSettingsEqual(draft, savedStrategy.version.paperSettings);

  const launchPaper = async () => {
    if (launchInFlight.current || launchBlocker) return;
    launchInFlight.current = true;
    setLaunching(true);
    setLaunchError('');
    try {
      const settings = kind === 'python'
        ? PythonLivePaperLaunchSettingsV1Schema.parse(draft)
        : PineLivePaperLaunchSettingsV1Schema.parse(draft);
      const version = willSave
        ? await onPrepareVersion({ settings, fromEditor: kind === 'pine' && sourceChoice === 'editor',
          ...(kind === 'python' && pythonInfo ? { python: { ref: pythonInfo.id, name: pythonInfo.name } } : {}) })
        : savedStrategy!;
      const fingerprint = JSON.stringify({ strategyId: version.strategy.id, version: version.version.version,
        sourceSha256: version.version.sourceSha256, settings });
      if (idempotency.current?.fingerprint !== fingerprint) idempotency.current = { fingerprint, key: crypto.randomUUID() };
      const experiment = await createPaperExperiment({
        strategyId: version.strategy.id, version: version.version.version, sourceSha256: version.version.sourceSha256,
        settings, idempotencyKey: idempotency.current.key,
      });
      setLiveConfirmed(false);
      onRuns();
      window.history.replaceState(null, '', `/paper/${encodeURIComponent(experiment.id)}`);
      window.dispatchEvent(new Event('paper-route-changed'));
    } catch (reason) {
      setLaunchError(errorMessage(reason));
      if (reason instanceof ApiResponseError && reason.kind === 'PAPER_START_FAILED' && reason.experiment?.status === 'interrupted') {
        idempotency.current = null;
      }
      try { setCapabilities(await loadPaperCapabilities()); } catch { /* keep the server response */ }
    } finally {
      launchInFlight.current = false;
      setLaunching(false);
    }
  };

  const feeField = (key: keyof typeof fees, label: string) => {
    const locked = feesLocked(key.startsWith('hyperliquid') ? 'hyperliquid' : 'lighter');
    return <label key={key}><span>{label}</span><div className="paper-input-suffix"><input type="text" inputMode="decimal" value={fees[key]}
      aria-label={label} disabled={locked} title={locked ? 'Your account\'s fee on the exchange' : undefined}
      onChange={(event) => setFees((current) => ({ ...current, [key]: event.target.value }))} /><span>%</span></div></label>;
  };

  return (
    <section className={embedded ? 'paper-page paper-tab' : 'paper-page'} aria-labelledby={embedded ? undefined : 'paper-setup-title'} aria-label={embedded ? 'Paper setup' : undefined}>
      {!embedded && <div className="paper-page-heading">
        <div>
          <span className="eyebrow">PAPER / SETUP</span>
          <h1 id="paper-setup-title">Run a strategy in Paper <InfoTooltip label="Paper trading" en={pythonAllowed ? "Your Pine or Python strategy runs on each selected market's own candles and prices from Lighter or Hyperliquid. Its orders execute in real time against live order books with virtual money. Paper does not try to repeat the backtest." : "Your Pine strategy runs on each selected market's own candles and prices from Lighter or Hyperliquid. Its orders execute in real time against live order books with virtual money. Paper does not try to repeat the backtest."} ru={pythonAllowed ? "Pine- или Python-стратегия работает на свечах и ценах каждого выбранного рынка Lighter или Hyperliquid. Её заявки исполняются в реальном времени по живым стаканам на виртуальные деньги. Paper не пытается повторить бэктест." : "Pine-стратегия работает на свечах и ценах каждого выбранного рынка Lighter или Hyperliquid. Её заявки исполняются в реальном времени по живым стаканам на виртуальные деньги. Paper не пытается повторить бэктест."} /></h1>
        </div>
        <button className="paper-text-button" type="button" onClick={onBack}><ArrowLeft size={15} />Back to Backtest</button>
      </div>}

      {capabilities && !capabilities.available && <div className="paper-preview-notice" role="status">
        <AlertTriangle size={18} /><div><strong>{launchBlocker}</strong></div>
      </div>}

      {liveOffered && <section className={liveChosen ? 'paper-card paper-mode-card paper-mode-live' : 'paper-card paper-mode-card'} aria-label="Run mode">
        <span className="eyebrow">00 / MODE</span>
        <div className="paper-mode-options" role="radiogroup" aria-label="Run mode">
          <label><input type="radio" name="paper-run-mode" checked={!liveChosen} onChange={() => { setMode('paper'); setLiveConfirmed(false); }} />Paper — virtual money</label>
          <label><input type="radio" name="paper-run-mode" checked={liveChosen} onChange={() => setMode('live')} />LIVE — real money</label>
        </div>
        {liveChosen && !liveAllowed && <>
          <h3 className="paper-live-connect-title">Add your exchange account</h3>
          <p className="paper-card-footnote">LIVE trades the accounts on the Accounts page. Lighter: create an API key for your
            account (API key index 4–254). Hyperliquid: create an API wallet (More → API). Then add the account there with LIVE on.</p>
          {onAccounts && <button type="button" className="paper-text-button" onClick={onAccounts}>Open Accounts</button>}
        </>}
        {live && <>
          <p className="paper-live-warning" role="note"><AlertTriangle size={16} /><span><strong>LIVE — real money.</strong> Orders go to your {liveNames} account at once.
            Take-profits and stops are held by the engine; each open position also gets a reduce-only stop on its exchange. Stop closes every position at market.</span></p>
          <div className="paper-form-grid paper-live-accounts" aria-label="LIVE accounts">
            {runExchanges.map((exchange) => <label key={exchange}><span>{EXCHANGE_NAMES[exchange]} account <InfoTooltip label={`${EXCHANGE_NAMES[exchange]} account`} en="The exchange account this run trades (Accounts page). An account trades in one LIVE run at a time; another account can run LIVE beside it." ru="Аккаунт биржи, которым торгует этот прогон (страница Accounts). Один аккаунт торгует только в одном LIVE-прогоне; другой аккаунт может работать параллельно." /></span>
              <select value={chosenAccounts[exchange] ?? ''} aria-label={`${EXCHANGE_NAMES[exchange]} account`}
                onChange={(event) => setAccountChoice((current) => ({ ...current, [exchange]: event.target.value }))}>
                {usableAccounts(exchange).length === 0 && <option value="">No {EXCHANGE_NAMES[exchange]} account with LIVE on</option>}
                {usableAccounts(exchange).map((account) => <option key={account.id} value={account.id} disabled={Boolean(account.runId)}>
                  {account.name} · {accountIdentity(account)}{account.runId ? ' — trading in another run' : ''}</option>)}
              </select></label>)}
            {onAccounts && <div className="paper-live-accounts-manage"><button type="button" className="paper-text-button" onClick={onAccounts}>Manage accounts</button></div>}
          </div>
          <div className="paper-form-grid">
            <label><span>Daily loss limit (%) <InfoTooltip label="daily loss limit" en="When the account equity (balance plus open profit and loss) drops this far below the value captured at the first start of the day (a new day starts at 06:00 UTC), the run closes every position and stops. The starting value is kept on the server, so a new run the same day continues from it." ru="Когда капитал счёта (баланс плюс открытая прибыль и убыток) опускается на этот процент ниже значения, зафиксированного при первом запуске за день (новый день начинается в 06:00 UTC), прогон закрывает все позиции и останавливается. Стартовое значение хранится на сервере, поэтому новый прогон в тот же день продолжает от него." /></span>
              <div className="paper-input-suffix"><input type="text" inputMode="decimal" value={liveFields.dailyLossLimitPercent} aria-label="Daily loss limit percent"
                placeholder="off" onChange={(event) => setLiveFields((current) => ({ ...current, dailyLossLimitPercent: event.target.value }))} /><span>%</span></div>
              <small className="paper-field-hint">1–99%. Empty: off.</small></label>
            <label><span>Account leverage <InfoTooltip label="account leverage" en={`All open positions together stay within this multiple of the account equity (balance plus open losses). 1 means no borrowing; above 1 positions may exceed the balance. At most ${LIVE_MAX_LEVERAGE}x; the exchange's own margin rules still apply.`} ru={`Все открытые позиции вместе не превышают это число × капитал счёта (баланс плюс открытые убытки). 1 — без займа у биржи; больше 1 — позиции могут быть больше баланса. Не больше ${LIVE_MAX_LEVERAGE}×; собственные правила маржи биржи действуют всё равно.`} /></span>
              <div className="paper-input-suffix"><input type="text" inputMode="decimal" value={liveFields.maxLeverage} aria-label="Account leverage limit"
                onChange={(event) => setLiveFields((current) => ({ ...current, maxLeverage: event.target.value }))} /><span>x</span></div></label>
            <div className="paper-field-stack"><label><span>Max position (USDC) <InfoTooltip label="max position" en="The largest position on one market, in USDC at the entry price. When Order size would open more, the entry is reduced to fit; when what is left is below the exchange's minimum order, the entry is not sent. Applies to each market separately, together with Account leverage." ru="Самая большая позиция на одном рынке, в USDC по цене входа. Если Order size откроет больше, вход уменьшается до этого размера; если остаток меньше минимальной заявки биржи, вход не отправляется. Действует на каждый рынок отдельно, вместе с Account leverage." /></span>
              <div className="paper-input-suffix"><input type="text" inputMode="decimal" value={liveFields.maxPositionUsdc} aria-label="Max position USDC"
                placeholder="off" onChange={(event) => setLiveFields((current) => ({ ...current, maxPositionUsdc: event.target.value }))} /><span>USDC</span></div>
              <small className="paper-field-hint">Per market. Empty: off.</small></label>
              <label className="paper-inline-check"><input type="checkbox" checked={liveFields.minimumOrderSize} aria-label="Minimum order size"
                onChange={(event) => setLiveFields((current) => ({ ...current, minimumOrderSize: event.target.checked }))} />
                <span>Minimum order size <InfoTooltip label="minimum order size" en="Every entry opens the smallest order the exchange accepts on that market plus 15 % (about 11.5 USDC on most markets), whatever the balance; Order size is not used. The 15 % keep the exchange stop and the closes of a long above the exchange's minimum order. Max position and Account leverage still apply." ru="Каждый вход открывает самую маленькую заявку, которую биржа принимает на этом рынке, плюс 15 % (около 11,5 USDC на большинстве рынков), независимо от баланса; Order size не используется. Запас 15 % нужен, чтобы стоп на бирже и закрытие лонга не оказались меньше минимальной заявки биржи. Max position и Account leverage действуют как обычно." /></span></label></div>
            <label><span>Exchange stop <InfoTooltip label="exchange stop" en="A reduce-only stop that waits on the exchange for each open position, this far beyond its reference: where it triggers. It closes the position if the server or the engine stops working. Once triggered, the exchange closes at market within Max slippage. If it executes while the run works, the run stops and closes everything." ru="Стоп «только закрытие», который ждёт на бирже для каждой открытой позиции, на столько дальше точки отсчёта: где он срабатывает. Он закроет позицию, если сервер или двигатель перестанут работать. После срабатывания биржа закрывает позицию по рынку в пределах Max slippage. Если он сработает при работающем прогоне, прогон остановится и закроет всё." /></span>
              <div className="paper-input-suffix"><input type="text" inputMode="decimal" value={liveFields.exchangeStopPercent} aria-label="Exchange stop percent"
                onChange={(event) => setLiveFields((current) => ({ ...current, exchangeStopPercent: event.target.value }))} /><span>%</span></div></label>
            <label><span>Exchange stop from <InfoTooltip label="exchange stop reference" en="Strategy stop: beyond the strategy's own stop-loss (from the entry price when the strategy has none). Entry price: always from the position's average entry price. The exchange stop is placed again when the position's size changes; it does not follow a trailing stop." ru="Стоп стратегии: дальше её собственного стоп-лосса (от цены входа, если у стратегии стопа нет). Цена входа: всегда от средней цены входа позиции. Стоп на бирже переставляется, когда меняется размер позиции; за трейлинг-стопом он не следует." /></span>
              <select value={liveFields.exchangeStopFrom} aria-label="Exchange stop from"
                onChange={(event) => setLiveFields((current) => ({ ...current, exchangeStopFrom: event.target.value as 'strategy_stop' | 'entry_price' }))}>
                <option value="strategy_stop">Strategy stop (entry price if none)</option>
                <option value="entry_price">Entry price</option>
              </select></label>
            <label><span>Max slippage (%) <InfoTooltip label="max slippage" en="The price allowance of every market order of this run: how much worse than the current price (or a stop's trigger) the exchange may fill it. Without enough allowance a fast move cancels the order. Applies to market exits and entries, the exchange stop and the closes on Stop. Limit orders keep their price." ru="Допуск цены для каждой рыночной заявки прогона: насколько хуже текущей цены (или цены срабатывания стопа) биржа может её исполнить. Без достаточного допуска быстрое движение цены отменяет заявку. Действует на рыночные выходы и входы, стоп на бирже и закрытия при остановке. Лимитные заявки исполняются по своей цене." /></span>
              <div className="paper-input-suffix"><input type="text" inputMode="decimal" value={liveFields.maxSlippagePercent} aria-label="Max slippage percent"
                onChange={(event) => setLiveFields((current) => ({ ...current, maxSlippagePercent: event.target.value }))} /><span>%</span></div>
              <small className="paper-field-hint">Default 3%, from 0.05% to 50%: the price allowance of a market order.</small></label>
          </div>
          <label className="paper-live-confirm"><input type="checkbox" checked={liveConfirmed} onChange={(event) => setLiveConfirmed(event.target.checked)} />
            I understand: this run places real orders with real money on my {liveNames} account.</label>
        </>}
      </section>}

      <div className="paper-setup-grid">
        <section className="paper-card paper-strategy-card">
          <span className="eyebrow">01 / STRATEGY</span>
          <h2>{kind === 'python' ? pythonInfo?.name ?? 'Python strategy' : sourceName(selectedSource)}</h2>
          <label className="paper-source-select"><span>Strategy type {pythonAllowed ? <InfoTooltip label="strategy type" en="Pine code runs as written after every closed bar. Python strategies are your own .py files in the strategy folder (README: Python strategies) and react to every price update inside the execution engine. Both use the same real-time order execution." ru="Pine-код работает как написан, после каждого закрытого бара. Python-стратегии — ваши собственные .py-файлы в папке стратегий (README: Python strategies); они реагируют на каждое изменение цены внутри движка исполнения. Исполнение заявок у обоих одинаковое, в реальном времени." /> : <InfoTooltip label="strategy type" en="This version runs strategies written in Pine Script, the TradingView language. Paste or open Pine code in the editor." ru="Эта версия запускает стратегии на Pine Script — языке TradingView. Вставьте или откройте Pine-код в редакторе." />}</span>
            <select value={kind} aria-label="Strategy type" disabled={!pythonAllowed} onChange={(event) => { awaitingLastRun.current = false; setKind(event.target.value as 'pine' | 'python'); }}>
              <option value="pine">Pine code</option>
              {pythonAllowed && <option value="python" disabled={!pythonList?.length}>Python strategy</option>}
            </select></label>
          {kind === 'pine' && pythonAllowed && !pythonList?.length && (pythonList || pythonError) && <p className="paper-card-footnote">{pythonError
            ? `Python strategies could not load: ${pythonError}`
            : 'No Python strategies yet: put your .py files in the strategy folder (README: Python strategies), then reopen this page.'}</p>}
          {kind === 'python' && <>
            <label className="paper-source-select"><span>Python strategy</span>
              <select value={pythonRef} aria-label="Python strategy" onChange={(event) => choosePython(event.target.value)}>
                <option value="">Choose a strategy</option>
                {(pythonList ?? []).map((row) => <option key={row.id} value={row.id}>{row.name} · {row.builtin ? 'example' : `pack ${row.pack}`}</option>)}
              </select></label>
            {pythonInfo?.description && <p className="paper-card-footnote">{pythonInfo.description}</p>}
            {pythonInfo?.maxPositionsPerVenue && <p className="paper-card-footnote">At most {pythonInfo.maxPositionsPerVenue} markets per exchange hold a position at once.</p>}
            {pythonInfo && Object.keys(pythonInfo.params).length > 0 && <div className="paper-form-grid">
              {Object.entries(pythonInfo.params).map(([name, spec]) => <label key={name}><span>{spec.label || name}{spec.help && <InfoTooltip label={spec.label || name} en={spec.help} ru={spec.help} />}</span>
                {spec.type === 'bool'
                  ? <select value={paramText[name] ?? String(spec.default)} aria-label={spec.label || name} onChange={(event) => setParamText((current) => ({ ...current, [name]: event.target.value }))}><option value="true">Yes</option><option value="false">No</option></select>
                  : spec.choices
                    ? <select value={paramText[name] ?? String(spec.default)} aria-label={spec.label || name} onChange={(event) => setParamText((current) => ({ ...current, [name]: event.target.value }))}>{spec.choices.map((choice) => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}</select>
                    : <input type={spec.type === 'str' ? 'text' : 'number'} value={paramText[name] ?? String(spec.default)} aria-label={spec.label || name}
                      onChange={(event) => setParamText((current) => ({ ...current, [name]: event.target.value }))} />}
              </label>)}
            </div>}
            {pythonError && <p className="paper-card-footnote">Some strategy modules could not load: {pythonError}</p>}
          </>}
          {kind === 'pine' && !embedded && <><label className="paper-source-select"><span>Pine code</span>
            <select value={sourceChoice} onChange={(event) => { awaitingLastRun.current = false; setSourceChoice(event.target.value as 'saved' | 'editor'); }}>
              <option value="editor">Current editor{fromBacktest ? ' (just backtested)' : ''}</option>
              <option value="saved" disabled={strategies.length === 0}>Saved strategy</option>
            </select></label>
          {sourceChoice === 'saved' && <label className="paper-source-select"><span>Saved strategy</span>
            <select value={savedStrategy?.strategy.id ?? ''} onChange={(event) => onSelectStrategy(event.target.value)} disabled={catalogBusy}>
              <option value="">Choose saved strategy</option>
              {strategies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>}</>}
          <div className="paper-form-grid">
            <label><span>Timeframe <InfoTooltip label="Paper timeframe" en="The strategy receives each closed bar of this timeframe. Orders it places are worked immediately and executed whenever the live price reaches them." ru="Стратегия получает каждый закрытый бар этого таймфрейма. Выставленные ею заявки работают сразу и исполняются, как только живая цена до них доходит." /></span>
              <select value={timeframe} onChange={(event) => setTimeframe(event.target.value as Timeframe)}>
                {PINE_LIVE_TIMEFRAMES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select></label>
            <div className="paper-readonly-field"><span>Start</span><strong>Flat, no positions <InfoTooltip label="flat start" en={`Only trades the strategy opens after Start get virtual money. A Pine position held from history is followed without real size${pythonAllowed ? "; Python strategies warm up on history without trading" : ""}.`} ru={`Виртуальные деньги получают только сделки, открытые стратегией после старта. Позиция Pine из истории отслеживается без реального объёма${pythonAllowed ? "; Python-стратегии прогреваются на истории без сделок" : ""}.`} /></strong></div>
          </div>
          <p className="paper-card-footnote">{kind === 'python'
            ? 'Start saves this strategy and its settings in the library, then launches it.'
            : willSave
            ? 'Start saves this Pine code and these settings to the strategy library, then launches it.'
            : `Launches saved ${savedStrategy?.version.name}.`}</p>
        </section>

        <section className="paper-card paper-budget-card">
          <span className="eyebrow">02 / ACCOUNTS AND FEES</span>
          {live
            ? <h2>Your {liveNames} account <InfoTooltip label="exchange accounts" en="The selected markets of each exchange trade on its account whose API key is on the server. Entries are sized from that account's real balance; limits apply on each exchange separately." ru="Выбранные рынки каждой биржи торгуют на её счёте, чей ключ лежит на сервере. Размер входа считается от настоящего баланса этого счёта; ограничения действуют на каждой бирже отдельно." /></h2>
            : <h2>One virtual account per exchange <InfoTooltip label="virtual accounts" en="All selected markets of one exchange share its virtual USDC account. The balance applies to each exchange separately." ru="Все выбранные рынки одной биржи делят её виртуальный счёт в USDC. Баланс задаётся для каждой биржи отдельно." /></h2>}
          <div className="paper-form-grid">
            {live ? <div className="paper-readonly-field"><span>Balance</span><strong>Real {liveNames} balance</strong></div>
            : <label><span>Starting balance per exchange</span><div className="paper-input-suffix"><input type="number" min="100" step="100" value={capital} aria-label="Starting balance per exchange" onChange={(event) => setCapital(event.target.value)} /><span>USDC</span></div></label>}
            <label><span>Order size <InfoTooltip label="order size" en={`Each new entry uses this percent of the exchange account balance${pythonAllowed ? " (a Python strategy may scale it per entry)" : ""}. The strategy decides direction and timing; exits close the same share of the real position that the strategy closes.`} ru={`Каждый новый вход использует этот процент баланса счёта биржи${pythonAllowed ? " (Python-стратегия может масштабировать его для отдельного входа)" : ""}. Стратегия решает направление и момент; выходы закрывают ту же долю реальной позиции, что закрывает стратегия.`} /></span><div className="paper-input-suffix"><input type="text" inputMode="decimal" value={orderSize} aria-label="Order size percent" onChange={(event) => setOrderSize(event.target.value)} /><span>% of account</span></div>{live && liveFields.minimumOrderSize && <small className="paper-field-hint">LIVE: not used — Minimum order size is on.</small>}</label>
            {(!live || liveVenues.includes('Hyperliquid')) && feeField('hyperliquidMakerFeePercent', 'Hyperliquid maker fee')}
            {(!live || liveVenues.includes('Hyperliquid')) && feeField('hyperliquidTakerFeePercent', 'Hyperliquid taker fee')}
            {(!live || liveVenues.includes('Lighter')) && feeField('lighterMakerFeePercent', 'Lighter maker fee')}
            {(!live || liveVenues.includes('Lighter')) && feeField('lighterTakerFeePercent', 'Lighter taker fee')}
          </div>
          {live && runExchanges.map((exchange) => {
            const info = liveFees[exchange];
            return info === undefined ? null : typeof info === 'object'
              ? <p key={exchange} className="paper-card-footnote">{EXCHANGE_NAMES[exchange]} fees: {info.source}</p>
              : <p key={exchange} className="paper-launch-error" role="status">{EXCHANGE_NAMES[exchange]} fees: {info} The fields stay editable.</p>;
          })}
          <p className="paper-card-footnote">{live
            ? 'In LIVE the fee fields show each account\'s own fees on its exchange; the exchange charges them on real orders, and a Pine strategy uses them for its commission.'
            : 'Defaults are public base-tier fees. Funding payments are not included.'}</p>
        </section>
      </div>

      <section className="paper-card paper-market-card">
        <div className="paper-card-title"><div><span className="eyebrow">03 / MARKETS</span><h2>Any USDC perpetuals, up to {MAX_PER_VENUE} per exchange <InfoTooltip label="market selection" en="Pick markets on one or both exchanges. Each market runs its own copy of the strategy on its own candles and order book." ru="Выберите рынки на одной или обеих биржах. На каждом рынке работает своя копия стратегии на его свечах и стакане." /></h2></div>
          <span className="paper-count-chip">{draft.tracks.length} market{draft.tracks.length === 1 ? '' : 's'}</span></div>
        {live ? <p className="paper-market-note">LIVE trades <strong>{liveNames}</strong> markets{liveVenues.length < VENUES.length
          ? `; ${VENUES.filter((venue) => !liveVenues.includes(venue)).join(' and ')} markets stay selected for Paper (add that exchange's account on the Accounts page to trade them)` : ''}.</p> : <>
          <label className="paper-add-both"><input type="checkbox" checked={addToBoth} onChange={(event) => setAddToBoth(event.target.checked)} />
            Add to both exchanges when the market is listed on both</label>
          <p className="paper-market-note">Hyperliquid also lists <strong>xyz:</strong> markets (stocks, indices, commodities by trade.xyz).
            Each has its own fee, shown as a multiple of the Hyperliquid fee above, and trades thinly while its home exchange is closed.</p>
        </>}
        <div className="paper-venue-grid">
          {VENUES.filter((venue) => !live || liveVenues.includes(venue)).map((venue) => {
            const otherVenue = venue === 'Hyperliquid' ? 'Lighter' : 'Hyperliquid';
            return <MarketPicker key={venue} venue={venue} otherVenue={otherVenue} options={markets[venue]} otherOptions={markets[otherVenue]}
            volumes={volumes[venue]} feeMultipliers={feeMultipliers[venue]} selected={tracks[venue]} error={marketErrors[venue]}
            onAdd={(added) => setTracks((current) => {
              const other = [...current[otherVenue]];
              for (const market of added) {
                if (!live && addToBoth && markets[otherVenue]?.includes(market) && !other.includes(market) && other.length < MAX_PER_VENUE) {
                  other.push(market);
                }
              }
              return { ...current, [venue]: [...current[venue], ...added.filter((market) => !current[venue].includes(market))], [otherVenue]: other };
            })}
            onRemove={(market) => setTracks((current) => ({ ...current, [venue]: current[venue].filter((item) => item !== market) }))} />;
          })}
        </div>
        {!live && <XyzHoursNotice markets={tracks.Hyperliquid.filter(isXyzMarket)} />}
      </section>

      <section className="paper-card paper-readiness-card">
        <span className="eyebrow">04 / HOW ORDERS EXECUTE</span>
        {live ? <ul className="paper-execution-rules">
          <li>Orders go to {liveNames} at once over the open connection, with no modeled delay; the exchange matches them against its own book.</li>
          <li>Take-profits, stops and trailing stops are held by the engine and sent the moment the price reaches them.</li>
          <li>Each open position also has a reduce-only stop on its exchange, beyond the strategy's stop: it protects the position if the server stops; if it executes, that exchange stops trading.</li>
          <li>Every 10 s the run compares its positions with each exchange account; two differences in a row stop that exchange.</li>
          <li>A problem on one exchange (its daily loss limit, five refused orders in a row) closes that exchange's positions and stops it; the other exchange trades on. Stop closes everything and ends the run.</li>
        </ul> : <ul className="paper-execution-rules">
          <li>Market orders execute about 0.2 s after the strategy sends them, as IOC against the live book.</li>
          <li>Limit orders and take-profits fill when the opposite best price reaches them.</li>
          <li>Stops, stop-losses and trailing stops trigger on the live best price, then execute 0.3 s later.</li>
          <li>Partial fills are real: the rest of an exit keeps working; an entry keeps what filled.</li>
        </ul>}
      </section>

      <ExchangeLimitsForecast settings={draft} />
      <div className="paper-action-bar">
        <div><strong>{launching ? 'Starting…' : launchError ? 'Launch failed' : launchBlocker ? 'Not ready' : 'Ready'}</strong>
          <span>{launchBlocker ?? `${live ? 'LIVE, real money: ' : ''}${draft.tracks.length} market(s), ${timeframe} bars, ${draft.orderSizePercent}% per entry.`}</span>
          {launchError && <p id="paper-launch-error" className="paper-launch-error" role="alert"><AlertTriangle size={16} />{launchError}</p>}
        </div>
        <div className="paper-action-buttons">
          <button type="button" className="paper-text-button" onClick={onRuns}>View Runs <ArrowRight size={15} /></button>
          <button type="button" className={live ? 'run-button run-button-live' : 'run-button'} aria-describedby={launchError ? 'paper-launch-error' : undefined}
            disabled={Boolean(launchBlocker) || launching || catalogBusy} onClick={() => { void launchPaper(); }}>{launching ? 'Starting…' : live ? 'Start LIVE' : 'Start Paper'}</button>
        </div>
      </div>
    </section>
  );
}

export { PaperRuns as PaperRunsPreview } from './PaperRuns';
