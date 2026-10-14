import { AlertTriangle, ArrowLeft, ArrowRight, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readPaperDraft, writePaperDraft } from '../lib/editor-draft';
import { isXyzMarket } from '../lib/stock-hours';
import { XyzHoursNotice } from './XyzHoursNotice';
import {
  PAPER_MARKET_SYMBOL_PATTERN, PINE_LIVE_TIMEFRAMES, pythonStrategyRef,
  type PineLivePaperSettingsV1, type PythonLivePaperSettingsV1, type StrategyDetail, type StrategySummary,
} from '../../../../packages/shared/src/strategy-catalog-contracts';
import {
  PineLivePaperLaunchSettingsV1Schema, PythonLivePaperLaunchSettingsV1Schema,
} from '../../../../packages/shared/src/paper-experiment-contracts';
import {
  ApiResponseError, createPaperExperiment, loadPaperCapabilities, loadPaperMarkets, loadPythonStrategies, loadStrategy, loadVenueVolumes,
  type PaperCapabilities, type PythonStrategyInfo, type PythonStrategyParam,
} from '../lib/api';
import { findSavedPythonStrategy } from '../lib/python-strategy-library';
import { InfoTooltip } from './TranslatedText';
import { EDITION, pythonStrategiesAvailable, type Edition } from '../../../../packages/shared/src/edition';

type Venue = 'Hyperliquid' | 'Lighter';
type Timeframe = typeof PINE_LIVE_TIMEFRAMES[number];
const VENUES: readonly Venue[] = ['Hyperliquid', 'Lighter'];
const MAX_PER_VENUE = 10;
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
    && tracks(a) === tracks(b);
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
  return null;
}

function parseNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value.replace(',', '.'));
}

function errorMessage(reason: unknown): string {
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

/** `fee ×0.2` for a HIP-3 market; empty for the venue's ordinary fee. */
export function feeMultiplierLabel(multiplier: number | undefined): string {
  return multiplier === undefined || multiplier === 1 ? '' : `fee ×${Number(multiplier.toFixed(3))}`;
}

function MarketPicker({ venue, otherVenue, options, otherOptions, volumes, feeMultipliers, selected, onAdd, onRemove, error }: {
  venue: Venue; otherVenue: Venue; options: string[] | null; otherOptions: string[] | null;
  volumes: Record<string, number> | null; feeMultipliers: Record<string, number>; selected: string[]; error: string;
  onAdd: (market: string) => void; onRemove: (market: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = `paper-markets-${venue.toLowerCase()}`;
  const ranked = useMemo(() => rankMarkets(options ?? [], draft, selected, volumes), [options, draft, selected, volumes]);
  const normalized = (options ?? []).find((market) => market.toUpperCase() === draft.trim().toUpperCase()) ?? draft.trim();
  const known = options === null || options.includes(normalized);
  const full = selected.length >= MAX_PER_VENUE;
  const add = (market = normalized) => {
    if (!market || !PAPER_MARKET_SYMBOL_PATTERN.test(market) || full || selected.includes(market)
      || (options !== null && !options.includes(market))) return;
    onAdd(market);
    setDraft('');
    setActive(0);
    setOpen(false); // show the new chip instead of keeping the list over it
  };
  const showList = open && options !== null && !full;
  return (
    <div className="paper-venue-markets">
      <div className="paper-card-title"><h3>{venue}</h3><span className="paper-count-chip">{selected.length} / {MAX_PER_VENUE}</span></div>
      <div className="paper-market-add">
        <div className="paper-market-combo">
          <input role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
            placeholder={full ? `${MAX_PER_VENUE} markets chosen` : options ? `Choose from ${options.length} perpetuals` : 'Market, e.g. BTC'}
            value={draft} aria-label={`Add ${venue} market`} disabled={full}
            onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => setOpen(false)}
            onChange={(event) => { setDraft(event.target.value); setActive(0); setOpen(true); }}
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
        <button type="button" className="paper-text-button" onClick={() => add()} disabled={!draft.trim() || !known || full}><Plus size={14} />Add</button>
      </div>
      {draft.trim() && !known && <small className="paper-market-unavailable">{normalized} is not an active {venue} perpetual.</small>}
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
  onSelectStrategy, onPrepareVersion, onBack, onRuns, edition = EDITION, embedded = false }: PaperSetupProps) {
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
  const draft: LiveSettings = useMemo(() => ({
    ...(kind === 'python'
      ? { accountModel: 'python_live_v1' as const, strategyRef: pythonRef, params: pythonParams }
      : { accountModel: 'pine_live_v1' as const }),
    timeframe,
    tracks: VENUES.flatMap((venue) => tracks[venue].map((market) => ({ venue, market }))),
    capitalPerVenue: parseNumber(capital),
    orderSizePercent: parseNumber(orderSize),
    hyperliquidMakerFeePercent: parseNumber(fees.hyperliquidMakerFeePercent),
    hyperliquidTakerFeePercent: parseNumber(fees.hyperliquidTakerFeePercent),
    lighterMakerFeePercent: parseNumber(fees.lighterMakerFeePercent),
    lighterTakerFeePercent: parseNumber(fees.lighterTakerFeePercent),
  }), [kind, pythonRef, pythonParams, timeframe, tracks, capital, orderSize, fees]);
  const selectedSource = sourceChoice === 'saved' && savedStrategy ? savedStrategy.version.source : source;
  const paramsError = pythonInfo ? Object.entries(pythonInfo.params)
    .map(([name, spec]) => paramError(name, spec, pythonParams[name]!)).find(Boolean) ?? null : null;
  const settingsError = validPaperSettings(draft, capabilities) ?? (kind === 'python'
    ? (!pythonInfo ? 'Choose a Python strategy.' : paramsError) : null);
  const launchBlocker = !capabilities
    ? capabilityError ? `Cannot check Paper availability: ${capabilityError}` : 'Checking Paper availability…'
    : !capabilities.available
      ? capabilities.reason || 'Paper launch is not available on this server.'
      : kind === 'pine' && !selectedSource.trim()
        ? 'Paste a Pine strategy in the editor first.'
        : kind === 'pine' && sourceChoice === 'saved' && !savedStrategy
          ? 'Choose a saved strategy or use the editor code.'
          : settingsError;
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

  const feeField = (key: keyof typeof fees, label: string) => (
    <label key={key}><span>{label}</span><div className="paper-input-suffix"><input type="text" inputMode="decimal" value={fees[key]}
      aria-label={label} onChange={(event) => setFees((current) => ({ ...current, [key]: event.target.value }))} /><span>%</span></div></label>
  );

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

      <div className="paper-setup-grid">
        <section className="paper-card paper-strategy-card">
          <span className="eyebrow">01 / STRATEGY</span>
          <h2>{kind === 'python' ? pythonInfo?.name ?? 'Python strategy' : sourceName(selectedSource)}</h2>
          <label className="paper-source-select"><span>Strategy type {pythonAllowed ? <InfoTooltip label="strategy type" en="Pine code runs as written after every closed bar. Python strategies come from strategy packs (open examples or your own private pack) and react to every price update inside the execution engine. Both use the same real-time order execution." ru="Pine-код работает как написан, после каждого закрытого бара. Python-стратегии берутся из пакетов (открытые примеры или ваш приватный пакет) и реагируют на каждое изменение цены внутри движка исполнения. Исполнение заявок у обоих одинаковое, в реальном времени." /> : <InfoTooltip label="strategy type" en="This version runs strategies written in Pine Script, the TradingView language. Paste or open Pine code in the editor." ru="Эта версия запускает стратегии на Pine Script — языке TradingView. Вставьте или откройте Pine-код в редакторе." />}</span>
            <select value={kind} aria-label="Strategy type" disabled={!pythonAllowed} onChange={(event) => { awaitingLastRun.current = false; setKind(event.target.value as 'pine' | 'python'); }}>
              <option value="pine">Pine code</option>
              {pythonAllowed && <option value="python" disabled={!pythonList?.length}>Python strategy</option>}
            </select></label>
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
          <h2>One virtual account per exchange <InfoTooltip label="virtual accounts" en="All selected markets of one exchange share its virtual USDC account. The balance applies to each exchange separately." ru="Все выбранные рынки одной биржи делят её виртуальный счёт в USDC. Баланс задаётся для каждой биржи отдельно." /></h2>
          <div className="paper-form-grid">
            <label><span>Starting balance per exchange</span><div className="paper-input-suffix"><input type="number" min="100" step="100" value={capital} aria-label="Starting balance per exchange" onChange={(event) => setCapital(event.target.value)} /><span>USDC</span></div></label>
            <label><span>Order size <InfoTooltip label="order size" en={`Each new entry uses this percent of the exchange account balance${pythonAllowed ? " (a Python strategy may scale it per entry)" : ""}. The strategy decides direction and timing; exits close the same share of the real position that the strategy closes.`} ru={`Каждый новый вход использует этот процент баланса счёта биржи${pythonAllowed ? " (Python-стратегия может масштабировать его для отдельного входа)" : ""}. Стратегия решает направление и момент; выходы закрывают ту же долю реальной позиции, что закрывает стратегия.`} /></span><div className="paper-input-suffix"><input type="text" inputMode="decimal" value={orderSize} aria-label="Order size percent" onChange={(event) => setOrderSize(event.target.value)} /><span>% of account</span></div></label>
            {feeField('hyperliquidMakerFeePercent', 'Hyperliquid maker fee')}
            {feeField('hyperliquidTakerFeePercent', 'Hyperliquid taker fee')}
            {feeField('lighterMakerFeePercent', 'Lighter maker fee')}
            {feeField('lighterTakerFeePercent', 'Lighter taker fee')}
          </div>
          <p className="paper-card-footnote">Defaults are public base-tier fees. Funding payments are not included.</p>
        </section>
      </div>

      <section className="paper-card paper-market-card">
        <div className="paper-card-title"><div><span className="eyebrow">03 / MARKETS</span><h2>Any USDC perpetuals, up to {MAX_PER_VENUE} per exchange <InfoTooltip label="market selection" en="Pick markets on one or both exchanges. Each market runs its own copy of the strategy on its own candles and order book." ru="Выберите рынки на одной или обеих биржах. На каждом рынке работает своя копия стратегии на его свечах и стакане." /></h2></div>
          <span className="paper-count-chip">{draft.tracks.length} market{draft.tracks.length === 1 ? '' : 's'}</span></div>
        <label className="paper-add-both"><input type="checkbox" checked={addToBoth} onChange={(event) => setAddToBoth(event.target.checked)} />
          Add to both exchanges when the market is listed on both</label>
        <p className="paper-market-note">Hyperliquid also lists <strong>xyz:</strong> markets (stocks, indices, commodities by trade.xyz).
          Each has its own fee, shown as a multiple of the Hyperliquid fee above, and trades thinly while its home exchange is closed.</p>
        <div className="paper-venue-grid">
          {VENUES.map((venue) => {
            const otherVenue = venue === 'Hyperliquid' ? 'Lighter' : 'Hyperliquid';
            return <MarketPicker key={venue} venue={venue} otherVenue={otherVenue} options={markets[venue]} otherOptions={markets[otherVenue]}
            volumes={volumes[venue]} feeMultipliers={feeMultipliers[venue]} selected={tracks[venue]} error={marketErrors[venue]}
            onAdd={(market) => setTracks((current) => {
              const also = addToBoth && markets[otherVenue]?.includes(market) && !current[otherVenue].includes(market)
                && current[otherVenue].length < MAX_PER_VENUE;
              return { ...current, [venue]: [...current[venue], market], ...(also ? { [otherVenue]: [...current[otherVenue], market] } : {}) };
            })}
            onRemove={(market) => setTracks((current) => ({ ...current, [venue]: current[venue].filter((item) => item !== market) }))} />;
          })}
        </div>
        <XyzHoursNotice markets={tracks.Hyperliquid.filter(isXyzMarket)} />
      </section>

      <section className="paper-card paper-readiness-card">
        <span className="eyebrow">04 / HOW ORDERS EXECUTE</span>
        <ul className="paper-execution-rules">
          <li>Market orders execute about 0.2 s after the strategy sends them, as IOC against the live book.</li>
          <li>Limit orders and take-profits fill when the opposite best price reaches them.</li>
          <li>Stops, stop-losses and trailing stops trigger on the live best price, then execute 0.3 s later.</li>
          <li>Partial fills are real: the rest of an exit keeps working; an entry keeps what filled.</li>
        </ul>
      </section>

      <div className="paper-action-bar">
        <div><strong>{launching ? 'Starting…' : launchError ? 'Launch failed' : launchBlocker ? 'Not ready' : 'Ready'}</strong>
          <span>{launchBlocker ?? `${draft.tracks.length} market(s), ${timeframe} bars, ${draft.orderSizePercent}% per entry.`}</span>
          {launchError && <p id="paper-launch-error" className="paper-launch-error" role="alert"><AlertTriangle size={16} />{launchError}</p>}
        </div>
        <div className="paper-action-buttons">
          <button type="button" className="paper-text-button" onClick={onRuns}>View Paper Runs <ArrowRight size={15} /></button>
          <button type="button" className="run-button" aria-describedby={launchError ? 'paper-launch-error' : undefined}
            disabled={Boolean(launchBlocker) || launching || catalogBusy} onClick={() => { void launchPaper(); }}>{launching ? 'Starting…' : 'Start Paper'}</button>
        </div>
      </div>
    </section>
  );
}

export { PaperRuns as PaperRunsPreview } from './PaperRuns';
