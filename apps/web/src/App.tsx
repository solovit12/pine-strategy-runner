import Editor, { type OnMount } from '@monaco-editor/react';
import { AlertTriangle, Play, Settings2, ShieldCheck, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PINETS_VERSION, type BacktestRequest, type BacktestResponse, type BacktestTimeframe, type PresetResponse } from '../../../packages/shared/src/contracts';
import { PYTHON_STRATEGY_SOURCE_PREFIX, pythonStrategyRef, type PaperStrategySettings, type StrategyDetail, type StrategySummary } from '../../../packages/shared/src/strategy-catalog-contracts';
import { BinanceMarketSelector } from './components/BinanceMarketSelector';
import { Metrics } from './components/Metrics';
import { LiveAccountsPage } from './components/LiveSettings';
import { PaperRunsPreview, PaperSetupPreview, type PaperVersionRequest } from './components/PaperScreens';
import { PineCheck } from './components/PineCheck';
import { ExchangeLimitsChip, useExchangeLoad } from './components/ExchangeLimits';
import { PriceChart } from './components/PriceChart';
import { StrategyLibraryBrowser } from './components/StrategyLibraryBrowser';
import { InfoTooltip } from './components/TranslatedText';
import { TradesTable } from './components/TradesTable';
import {
  createStrategy, deleteStrategy, listPaperExperiments, listStrategies, loadPreset, loadServerHealth, loadStrategy, loadStrategyCatalogCapabilities,
  runBacktest, saveStrategyVersion, type ServerHealth,
} from './lib/api';
import { backtestDateWindowError, inclusiveUtcDays } from './lib/backtest-date-window';
import { readEditorDraft, writeEditorDraft, type EditorDraft } from './lib/editor-draft';
import { backtestResultAfter } from './lib/run-result-state';
import { backtestSettingsSupportedByEditor } from './lib/strategy-editor-compat';
import { registerBacktestWebTools } from './lib/webmcp';
import { EDITION, liveTradingAvailable } from '../../../packages/shared/src/edition';
import { findSavedPythonStrategy, pythonStrategySource } from './lib/python-strategy-library';
import { changedDeclarationProperties, strategyDeclarationProperties, type StrategyDeclarationProperties } from './strategy-declaration';

type RunState = 'loading-preset' | 'ready' | 'running' | 'success' | 'error' | 'stopped';
type AppPage = 'backtest' | 'paper-setup' | 'paper-runs' | 'accounts';

/** Header status: busy Paper slots still mean Paper works; a site without its engine says so. */
/** Tells the owner's private and public sites apart, in the header and the browser tab. */
const EDITION_LABEL = EDITION === 'full' ? 'Private' : 'Public';
if (typeof document !== 'undefined') document.title = `Pine Strategy Runner · ${EDITION_LABEL}`;

export function paperModeLabel(health: ServerHealth): string {
  if (health.paper.configured) return 'BACKTEST + PAPER';
  return health.role === 'site' ? 'PAPER ENGINE OFF' : 'BACKTEST ONLY';
}
type EditorSnapshot = {
  source: string;
  symbol: string;
  timeframe: BacktestTimeframe;
  startDate: string;
  endDate: string;
  initialCapital: number;
  defaultOrderSizeValue: number;
  defaultOrderSizeType: OrderSizeType;
  pyramiding: number;
  commissionValueInput: string;
  longLeverage: string;
  shortLeverage: string;
  slippageTicks: number;
  processOrdersOnClose: boolean;
  barDetail: BarDetail;
  strategyName: string;
  selectedStrategyId: string;
  loadedStrategy: StrategyDetail | null;
  paperStrategy: StrategyDetail | null;
  result: BacktestResponse | null;
  lastBacktestedRequest: BacktestRequest | null;
  state: RunState;
  error: string;
};

function pageFromPath(): AppPage {
  if (typeof window === 'undefined') return 'backtest';
  if (window.location.pathname === '/paper/setup') return 'paper-setup';
  if (window.location.pathname.startsWith('/paper')) return 'paper-runs';
  if (window.location.pathname === '/accounts') return 'accounts';
  return 'backtest';
}
type OrderSizeType = 'fixed' | 'cash' | 'percent_of_equity';
/** `high`: every order checked on each minute candle; `default`: the candle's own 4-point path (TradingView's Default). */
type BarDetail = 'high' | 'default';
const DEFAULT_PAPER_SETTINGS: PaperStrategySettings = {
  accountModel: 'pine_live_v1',
  timeframe: '1h',
  tracks: [],
  capitalPerVenue: 10_000,
  orderSizePercent: 10,
  hyperliquidMakerFeePercent: null,
  hyperliquidTakerFeePercent: null,
  lighterMakerFeePercent: null,
  lighterTakerFeePercent: null,
};
const orderSizeLabels: Record<OrderSizeType, { en: string; ru: string }> = {
  fixed: { en: 'Quantity', ru: 'Количество' },
  cash: { en: 'USDT', ru: 'USDT' },
  percent_of_equity: { en: '% of equity', ru: '% от капитала' },
};

const timeframeOptions: BacktestTimeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const executionExamples: Record<BacktestTimeframe, { en: string; ru: string }> = {
  '1m': {
    en: 'At 12:01 the strategy decides. A market entry starts at the open of the 12:01–12:02 candle. Existing stop and take-profit orders are checked on that minute candle. The next strategy calculation is at 12:02. No sub-minute price path is available.',
    ru: 'В 12:01 стратегия принимает решение. Рыночный вход начинается на открытии свечи 12:01–12:02. Уже выставленные стоп и тейк проверяются по этой минутной свече. Следующий расчёт стратегии — в 12:02. Данных о движении цены внутри минуты нет.',
  },
  '5m': {
    en: 'At 12:05 the strategy decides. A market entry starts at the open of the 12:05–12:10 candle. A stop may fill at 12:07. The next strategy calculation is at 12:10.',
    ru: 'В 12:05 стратегия принимает решение. Рыночный вход начинается на открытии свечи 12:05–12:10. Стоп может сработать в 12:07. Следующий расчёт стратегии — в 12:10.',
  },
  '15m': {
    en: 'At 12:15 the strategy decides. A market entry starts at the open of the 12:15–12:30 candle. A stop may fill at 12:19. The next strategy calculation is at 12:30.',
    ru: 'В 12:15 стратегия принимает решение. Рыночный вход начинается на открытии свечи 12:15–12:30. Стоп может сработать в 12:19. Следующий расчёт стратегии — в 12:30.',
  },
  '30m': {
    en: 'At 12:30 the strategy decides. A market entry starts at the open of the 12:30–13:00 candle. A stop may fill at 12:34. The next strategy calculation is at 13:00.',
    ru: 'В 12:30 стратегия принимает решение. Рыночный вход начинается на открытии свечи 12:30–13:00. Стоп может сработать в 12:34. Следующий расчёт стратегии — в 13:00.',
  },
  '1h': {
    en: 'At 13:00 the strategy decides. A market entry starts at the open of the 13:00–14:00 candle. A stop may fill at 13:07. The next strategy calculation is at 14:00.',
    ru: 'В 13:00 стратегия принимает решение. Рыночный вход начинается на открытии свечи 13:00–14:00. Стоп может сработать в 13:07. Следующий расчёт стратегии — в 14:00.',
  },
  '4h': {
    en: 'At 12:00 the strategy decides. A market entry starts at the open of the 12:00–16:00 candle. A stop may fill at 12:19. The next strategy calculation is at 16:00.',
    ru: 'В 12:00 стратегия принимает решение. Рыночный вход начинается на открытии свечи 12:00–16:00. Стоп может сработать в 12:19. Следующий расчёт стратегии — в 16:00.',
  },
  '1d': {
    en: 'At 00:00 UTC on 2 September the strategy decides from the closed daily candle. A market entry starts at the open of 2 September. A stop may fill at 12:19 UTC. The next strategy calculation is at 00:00 UTC on 3 September.',
    ru: 'В 00:00 UTC 2 сентября стратегия принимает решение по закрытой дневной свече. Рыночный вход начинается на открытии 2 сентября. Стоп может сработать в 12:19 UTC. Следующий расчёт стратегии — в 00:00 UTC 3 сентября.',
  },
  '1w': {
    en: 'At 00:00 UTC on Monday the strategy decides from the closed weekly candle. A market entry starts at the open of the new week. A stop may fill on Wednesday. The next strategy calculation is at 00:00 UTC next Monday.',
    ru: 'В понедельник в 00:00 UTC стратегия принимает решение по закрытой недельной свече. Рыночный вход начинается на открытии новой недели. Стоп может сработать в среду. Следующий расчёт стратегии — в 00:00 UTC следующего понедельника.',
  },
};

function bilingual(en: string, ru: string): string {
  return `${en} / ${ru}`;
}

function splitBilingual(value: string): { en: string; ru?: string } {
  const match = /^(.*?) \/ ([А-ЯЁа-яё].*)$/s.exec(value);
  return match ? { en: match[1], ru: match[2] } : { en: value };
}

function leverageToMarginPercent(value: string, side: { en: string; ru: string }): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return undefined;
  if (normalized === 'infinity' || normalized === '∞') return 0;
  const leverage = Number(normalized.replace(/x|×/g, ''));
  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new Error(bilingual(
      `${side.en}: enter Auto, Infinity, or positive leverage such as 20.`,
      `${side.ru}: укажите Auto, Infinity или положительное плечо, например 20.`,
    ));
  }
  return 100 / leverage;
}

function formatLeverage(marginPercent: number): string {
  if (marginPercent === 0) return '∞';
  return `${Number((100 / marginPercent).toFixed(4))}×`;
}

export function App() {
  const [page, setPage] = useState<AppPage>(pageFromPath);
  // The Paper tab mounts on first visit and then keeps its form while hidden.
  const [paperTabMounted, setPaperTabMounted] = useState(() => pageFromPath() === 'paper-setup');
  useEffect(() => { if (page === 'paper-setup') setPaperTabMounted(true); }, [page]);
  const [paperMode, setPaperMode] = useState('BACKTEST ONLY');
  const exchangeLoad = useExchangeLoad(paperMode === 'BACKTEST + PAPER');
  const [paperFromBacktest, setPaperFromBacktest] = useState(false);
  const [lastBacktestedRequest, setLastBacktestedRequest] = useState<BacktestRequest | null>(null);
  const [catalogEnabled, setCatalogEnabled] = useState(false);
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState('');
  const [browseStrategies, setBrowseStrategies] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveNameDraft, setSaveNameDraft] = useState('');
  const [saveError, setSaveError] = useState('');
  const [loadedStrategy, setLoadedStrategy] = useState<StrategyDetail | null>(null);
  const [previousEditors, setPreviousEditors] = useState<EditorSnapshot[]>([]);
  const [paperStrategy, setPaperStrategy] = useState<StrategyDetail | null>(null);
  const [strategyName, setStrategyName] = useState('');
  const [catalogMessage, setCatalogMessage] = useState('');
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [preset, setPreset] = useState<PresetResponse | null>(null);
  const [source, setSource] = useState('');
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState<BacktestTimeframe>('1h');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [initialCapital, setInitialCapital] = useState(100_000);
  const [defaultOrderSizeValue, setDefaultOrderSizeValue] = useState(0.01);
  const [defaultOrderSizeType, setDefaultOrderSizeType] = useState<OrderSizeType>('fixed');
  const [pyramiding, setPyramiding] = useState(1);
  const [commissionValueInput, setCommissionValueInput] = useState('');
  const [longLeverage, setLongLeverage] = useState('Auto');
  const [shortLeverage, setShortLeverage] = useState('Auto');
  const [slippageTicks, setSlippageTicks] = useState(0);
  const [processOrdersOnClose, setProcessOrdersOnClose] = useState(false);
  const [barDetail, setBarDetail] = useState<BarDetail>('high');
  const [result, setResult] = useState<BacktestResponse | null>(null);
  const [state, setState] = useState<RunState>('loading-preset');
  const [error, setError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const paperStrategySelectionEpoch = useRef(0);
  const lastRunStrategy = useRef<StrategyDetail | null>(null);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const declarationRef = useRef<StrategyDeclarationProperties>({});
  /** Set once the saved draft (if any) is back in the form; saving starts only then. */
  const draftRestored = useRef(false);

  /** Loaded code keeps its saved properties; only later edits to strategy(...) update the form. */
  const setLoadedSource = (text: string) => {
    declarationRef.current = strategyDeclarationProperties(text);
    setSource(text);
  };

  useEffect(() => {
    const next = strategyDeclarationProperties(source);
    const changed = changedDeclarationProperties(declarationRef.current, next);
    declarationRef.current = next;
    if (changed.initialCapital !== undefined) setInitialCapital(changed.initialCapital);
    if (changed.defaultOrderSizeType !== undefined) setDefaultOrderSizeType(changed.defaultOrderSizeType);
    if (changed.defaultOrderSizeValue !== undefined) setDefaultOrderSizeValue(changed.defaultOrderSizeValue);
    if (changed.pyramiding !== undefined) setPyramiding(changed.pyramiding);
    if (changed.commissionPercent !== undefined) setCommissionValueInput(String(changed.commissionPercent));
    if (changed.processOrdersOnClose !== undefined) setProcessOrdersOnClose(changed.processOrdersOnClose);
  }, [source]);

  useEffect(() => {
    loadPreset().then((loaded) => {
      setPreset(loaded);
      setLoadedSource(loaded.source);
      setSymbol(loaded.configuration.symbol);
      setTimeframe(timeframeOptions.includes(loaded.configuration.timeframe) ? loaded.configuration.timeframe : '1h');
      setStartDate(loaded.configuration.dateRange.start);
      setEndDate(loaded.configuration.dateRange.end);
      setInitialCapital(loaded.configuration.initialCapital);
      setDefaultOrderSizeValue(loaded.configuration.defaultOrderSizeValue);
      setDefaultOrderSizeType(loaded.configuration.defaultOrderSizeType);
      setPyramiding(loaded.configuration.pyramiding);
      setSlippageTicks(loaded.configuration.slippageTicks);
      setProcessOrdersOnClose(strategyDeclarationProperties(loaded.source).processOrdersOnClose ?? false);
      const draft = readEditorDraft();
      if (draft) restoreEditorDraft(draft, loaded.source);
      draftRestored.current = true;
      setState('ready');
    }).catch((reason: Error) => {
      setError(reason.message);
      setState('error');
    });
  }, []);

  // Unsaved work survives a page reload (this browser only).
  useEffect(() => {
    if (!draftRestored.current) return;
    const timer = window.setTimeout(() => writeEditorDraft({
      source, symbol, timeframe, startDate, endDate, initialCapital, defaultOrderSizeValue, defaultOrderSizeType,
      pyramiding, commissionValueInput, longLeverage, shortLeverage, slippageTicks, processOrdersOnClose, barDetail, strategyName,
      strategyId: loadedStrategy?.strategy.id ?? null,
    }), 300);
    return () => window.clearTimeout(timer);
  }, [source, symbol, timeframe, startDate, endDate, initialCapital, defaultOrderSizeValue, defaultOrderSizeType, pyramiding,
    commissionValueInput, longLeverage, shortLeverage, slippageTicks, processOrdersOnClose, barDetail, strategyName, loadedStrategy, state]);

  useEffect(() => {
    const controller = new AbortController();
    loadStrategyCatalogCapabilities(controller.signal).then(({ enabled }) => {
      if (!enabled || controller.signal.aborted) return;
      setCatalogEnabled(true);
      listStrategies().then(async (items) => {
        if (controller.signal.aborted) return;
        setStrategies(items);
        // "Prepare experiment" on Paper Runs opens the strategy of the most recent run, if it is still saved.
        const latestRun = (await listPaperExperiments(controller.signal).catch(() => []))[0];
        const lastStrategy = latestRun && items.find((item) => item.id === latestRun.strategyId);
        if (lastStrategy) {
          const detail = await loadStrategy(lastStrategy.id);
          if (!controller.signal.aborted) lastRunStrategy.current = detail;
        }
      }).catch((reason: Error) => { if (!controller.signal.aborted) setCatalogMessage(reason.message); });
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => loadServerHealth(controller.signal)
      .then((health) => setPaperMode(paperModeLabel(health))).catch(() => undefined);
    void refresh();
    // The Paper engine can be restarted separately; keep the header honest.
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    const onPopState = () => setPage(pageFromPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!browseStrategies && !saveDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !catalogBusy) {
        if (browseStrategies) {
          setBrowseStrategies(false);
          requestAnimationFrame(() => openButtonRef.current?.focus());
        }
        if (saveDialogOpen) {
          setSaveDialogOpen(false);
          requestAnimationFrame(() => saveButtonRef.current?.focus());
        }
      }
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.strategy-dialog[role="dialog"]');
      const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length > 0) : [];
      if (!dialog || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [browseStrategies, saveDialogOpen, catalogBusy]);

  const navigate = (next: AppPage) => {
    setBrowseStrategies(false);
    setSaveDialogOpen(false);
    const path = next === 'paper-setup' ? '/paper/setup' : next === 'paper-runs' ? '/paper' : next === 'accounts' ? '/accounts' : '/';
    window.history.pushState(null, '', path);
    window.dispatchEvent(new Event('paper-route-changed'));
    // Switching between the Strategy tabs keeps the editor in view.
    if (next === 'paper-runs' || page === 'paper-runs' || next === 'accounts' || page === 'accounts') window.scrollTo({ top: 0, behavior: 'smooth' });
    setPage(next);
  };

  /** Opens one run's page (Paper Runs), e.g. from the account that run trades. */
  const openRun = (runId: string) => {
    navigate('paper-runs');
    window.history.replaceState(null, '', `/paper/${encodeURIComponent(runId)}`);
    window.dispatchEvent(new Event('paper-route-changed'));
  };

  /**
   * The editor's backtest settings. `commissionFallback` fills an empty commission field
   * (Paper launches need no backtest; Pine's own bookkeeping then uses the Paper fee).
   */
  const currentRequest = (commissionFallback?: number): BacktestRequest => {
    const marginLongPercent = leverageToMarginPercent(longLeverage, { en: 'Long leverage', ru: 'Плечо для лонга' });
    const marginShortPercent = leverageToMarginPercent(shortLeverage, { en: 'Short leverage', ru: 'Плечо для шорта' });
    const barDetailization: BarDetail = timeframe === '1m' ? 'default' : barDetail;
    const dateWindowError = backtestDateWindowError(startDate, endDate);
    const normalizedCommission = commissionValueInput.trim() === '' && commissionFallback !== undefined
      ? String(commissionFallback) : commissionValueInput.trim().replace(',', '.');
    const commissionValue = Number(normalizedCommission);
    const validationError = !source.trim()
      ? bilingual('The Pine editor is empty.', 'Редактор Pine пуст.')
      : !/^[A-Z0-9]+USDT$/.test(symbol.trim())
        ? bilingual('Enter a Binance perpetual symbol settled in USDT, for example BTCUSDT.', 'Укажите символ бессрочного контракта Binance с расчётом в USDT, например BTCUSDT.')
      : dateWindowError
        ? dateWindowError
        : !Number.isFinite(initialCapital) || initialCapital <= 0
          ? bilingual('Initial capital must be greater than zero.', 'Начальный капитал должен быть больше нуля.')
          : !Number.isFinite(defaultOrderSizeValue) || defaultOrderSizeValue <= 0
            ? bilingual('Default order size must be greater than zero.', 'Размер заявки должен быть больше нуля.')
            : !Number.isInteger(pyramiding) || pyramiding < 0 || pyramiding > 100
              ? bilingual('Pyramiding must be a whole number from 0 to 100.', 'Пирамидинг должен быть целым числом от 0 до 100.')
              : !/^\d+(?:\.\d+)?$/.test(normalizedCommission) || !Number.isFinite(commissionValue) || commissionValue < 0 || commissionValue > 100
                ? bilingual('Enter commission as a percentage from 0 to 100. Zero means no commission.', 'Укажите комиссию в процентах от 0 до 100. Ноль означает отсутствие комиссии.')
                : !Number.isInteger(slippageTicks) || slippageTicks < 0
                  ? bilingual('Slippage must be a whole number of ticks starting from zero.', 'Проскальзывание должно быть целым числом тиков от нуля.')
                  : '';
    if (validationError) {
      throw new Error(validationError);
    }
    return {
      source, exchange: 'Binance', marketType: 'Perpetual', symbol: symbol.trim().toUpperCase(), timeframe,
      barIndexOffset: 0,
      dateRange: { start: startDate, end: endDate },
      initialCapital, baseCurrency: 'USDT', defaultOrderSizeValue, defaultOrderSizeType, pyramiding,
      feeModel: 'manual',
      commissionType: 'percent', commissionValue, marginLongPercent, marginShortPercent, slippageTicks,
      barDetailization, calcOnOrderFills: false, calcOnEveryTick: false,
      calcOnEveryHistoryTick: false, limitOrderVerificationTicks: 0, processOrdersOnClose,
    };
  };

  const backtestMatchesEditor = (): boolean => {
    if (state !== 'success' || result === null || lastBacktestedRequest === null) return false;
    try {
      return JSON.stringify(currentRequest()) === JSON.stringify(lastBacktestedRequest);
    } catch { return false; }
  };

  /**
   * Paper runs the editor's code, backtested or not. From Paper Runs, an untouched
   * editor first opens the strategy of the most recent run.
   */
  const preparePaper = (fromEditor: boolean) => {
    const last = lastRunStrategy.current;
    if (!fromEditor && !loadedStrategy && preset && source === preset.source && last
      && pythonStrategyRef(last.version.source) === null) loadDetailIntoEditor(last);
    setPaperFromBacktest(fromEditor && backtestMatchesEditor());
    navigate('paper-setup');
  };

  const run = async (): Promise<BacktestResponse> => {
    if (controllerRef.current) throw new Error(bilingual('A backtest is already running.', 'Бэктест уже выполняется.'));
    setLastBacktestedRequest(null);
    setResult((current) => backtestResultAfter(current, { type: 'run-started' }));
    let request: BacktestRequest;
    try {
      request = currentRequest();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setState('error');
      throw new Error(message);
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setError('');
    setState('running');
    try {
      const next = await runBacktest(request, controller.signal);
      setResult((current) => backtestResultAfter(current, { type: 'run-succeeded', result: next }));
      setLastBacktestedRequest(request);
      setState('success');
      return next;
    } catch (reason) {
      setResult((current) => backtestResultAfter(current, { type: 'run-failed-or-stopped' }));
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        setState('stopped');
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
        setState('error');
      }
      throw reason;
    } finally {
      controllerRef.current = null;
    }
  };

  const refreshStrategies = async () => setStrategies(await listStrategies());

  const applyStrategyToEditor = (detail: StrategyDetail) => {
    const settings = detail.version.backtestSettings;
    paperStrategySelectionEpoch.current += 1;
    setLoadedStrategy(detail);
    setPaperStrategy(detail);
    setSelectedStrategyId(detail.strategy.id);
    setStrategyName(detail.version.name);
    setLoadedSource(detail.version.source);
    setSymbol(settings.symbol);
    setTimeframe(settings.timeframe);
    setStartDate(settings.dateRange.start);
    setEndDate(settings.dateRange.end);
    setInitialCapital(settings.initialCapital);
    setDefaultOrderSizeValue(settings.defaultOrderSizeValue);
    setDefaultOrderSizeType(settings.defaultOrderSizeType);
    setPyramiding(settings.pyramiding);
    setCommissionValueInput(String(settings.commissionValue));
    setLongLeverage(settings.marginLongPercent === undefined ? 'Auto' : formatLeverage(settings.marginLongPercent));
    setShortLeverage(settings.marginShortPercent === undefined ? 'Auto' : formatLeverage(settings.marginShortPercent));
    setSlippageTicks(settings.slippageTicks);
    setProcessOrdersOnClose(settings.processOrdersOnClose ?? strategyDeclarationProperties(detail.version.source).processOrdersOnClose ?? false);
    setBarDetail(settings.timeframe !== '1m' && settings.barDetailization === 'default' ? 'default' : 'high');
    setResult(null);
    setLastBacktestedRequest(null);
    setError('');
    setState('ready');
  };

  /** Puts the draft saved before a reload back into the form, over the template. */
  const restoreEditorDraft = (draft: EditorDraft, templateSource: string) => {
    setLoadedSource(draft.source);
    setSymbol(draft.symbol);
    setTimeframe(timeframeOptions.includes(draft.timeframe) ? draft.timeframe : '1h');
    setStartDate(draft.startDate);
    setEndDate(draft.endDate);
    setInitialCapital(draft.initialCapital);
    setDefaultOrderSizeValue(draft.defaultOrderSizeValue);
    setDefaultOrderSizeType(draft.defaultOrderSizeType);
    setPyramiding(draft.pyramiding);
    setCommissionValueInput(draft.commissionValueInput);
    setLongLeverage(draft.longLeverage);
    setShortLeverage(draft.shortLeverage);
    setSlippageTicks(draft.slippageTicks);
    setProcessOrdersOnClose(draft.processOrdersOnClose);
    setBarDetail(draft.barDetail ?? 'high');
    setStrategyName(draft.strategyName);
    if (draft.source !== templateSource) setCatalogMessage('The editor was restored from your last visit.');
    if (!draft.strategyId) return;
    // Still linked to its saved strategy, so Save replaces it; a deleted one is simply forgotten.
    const strategyId = draft.strategyId;
    loadStrategy(strategyId).then((detail) => {
      if (draftRestored.current && paperStrategySelectionEpoch.current === 0) {
        setLoadedStrategy(detail);
        setPaperStrategy(detail);
        setSelectedStrategyId(strategyId);
      }
    }).catch(() => undefined);
  };

  const restorePreviousEditor = () => {
    const previousEditor = previousEditors.at(-1);
    if (!previousEditor) return;
    setLoadedSource(previousEditor.source);
    setSymbol(previousEditor.symbol);
    setTimeframe(previousEditor.timeframe);
    setStartDate(previousEditor.startDate);
    setEndDate(previousEditor.endDate);
    setInitialCapital(previousEditor.initialCapital);
    setDefaultOrderSizeValue(previousEditor.defaultOrderSizeValue);
    setDefaultOrderSizeType(previousEditor.defaultOrderSizeType);
    setPyramiding(previousEditor.pyramiding);
    setCommissionValueInput(previousEditor.commissionValueInput);
    setLongLeverage(previousEditor.longLeverage);
    setShortLeverage(previousEditor.shortLeverage);
    setSlippageTicks(previousEditor.slippageTicks);
    setProcessOrdersOnClose(previousEditor.processOrdersOnClose);
    setBarDetail(previousEditor.barDetail);
    setStrategyName(previousEditor.strategyName);
    setSelectedStrategyId(previousEditor.selectedStrategyId);
    setLoadedStrategy(previousEditor.loadedStrategy);
    setPaperStrategy(previousEditor.paperStrategy);
    setResult(previousEditor.result);
    setLastBacktestedRequest(previousEditor.lastBacktestedRequest);
    setState(previousEditor.state);
    setError(previousEditor.error);
    setPreviousEditors((items) => items.slice(0, -1));
    setCatalogMessage('Previous editor restored.');
  };

  const closeOpenDialog = () => {
    setBrowseStrategies(false);
    requestAnimationFrame(() => openButtonRef.current?.focus());
  };

  const closeSaveDialog = () => {
    setSaveDialogOpen(false);
    requestAnimationFrame(() => saveButtonRef.current?.focus());
  };

  const loadDetailIntoEditor = (detail: StrategyDetail) => {
    if (pythonStrategyRef(detail.version.source) !== null) {
      closeOpenDialog();
      setCatalogMessage(`${detail.version.name} is a Python strategy from a strategy pack. Choose it on the Paper tab under Strategy type; the Pine editor was left unchanged.`);
      return;
    }
    if (!backtestSettingsSupportedByEditor(detail.version.backtestSettings)) {
      closeOpenDialog();
      setCatalogMessage('This saved strategy has backtest settings that this editor cannot show or preserve. The editor was left unchanged.');
      return;
    }
    const snapshot: EditorSnapshot = {
      source, symbol, timeframe, startDate, endDate, initialCapital,
      defaultOrderSizeValue, defaultOrderSizeType, pyramiding, commissionValueInput,
      longLeverage, shortLeverage, slippageTicks, processOrdersOnClose, barDetail, strategyName, selectedStrategyId,
      loadedStrategy, paperStrategy, result, lastBacktestedRequest, state, error,
    };
    setPreviousEditors((items) => [...items, snapshot].slice(-3));
    applyStrategyToEditor(detail);
    closeOpenDialog();
    setCatalogMessage(`Opened ${detail.version.name}.`);
  };

  const openSaveDialog = () => {
    setSaveNameDraft(strategyName.trim() || /\bstrategy\s*\(\s*['"]([^'"]+)['"]/.exec(source)?.[1] || '');
    setSaveError('');
    setSaveDialogOpen(true);
  };

  const saveFromEditor = async (newStrategy: boolean) => {
    setCatalogBusy(true);
    setSaveError('');
    try {
      const name = saveNameDraft.trim();
      if (!name) throw new Error('Enter a strategy name before saving.');
      const request = currentRequest();
      const { source: pineSource, ...backtestSettings } = request;
      const input = {
        name,
        source: pineSource,
        backtestSettings,
        paperSettings: loadedStrategy?.version.paperSettings ?? DEFAULT_PAPER_SETTINGS,
        metadata: newStrategy ? {} : loadedStrategy?.version.metadata ?? {},
      };
      const detail = newStrategy || !loadedStrategy
        ? await createStrategy(input)
        : await saveStrategyVersion(loadedStrategy.strategy.id, {
          ...input, expectedVersion: loadedStrategy.strategy.currentVersion,
        });
      setLoadedStrategy(detail);
      setPaperStrategy(detail);
      setSelectedStrategyId(detail.strategy.id);
      setStrategyName(detail.version.name);
      closeSaveDialog();
      setCatalogMessage(`Saved ${detail.version.name}.`);
      try {
        await refreshStrategies();
      } catch {
        setCatalogMessage(`Saved ${detail.version.name}. The library list could not refresh yet.`);
      }
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCatalogBusy(false);
    }
  };

  /** Deletes a library strategy; an editor holding it keeps the code as an unsaved draft. */
  const removeStrategy = async (strategy: StrategySummary) => {
    await deleteStrategy(strategy.id);
    if (loadedStrategy?.strategy.id === strategy.id) {
      setLoadedStrategy(null);
      setPaperStrategy(null);
      setSelectedStrategyId('');
    }
    if (lastRunStrategy.current?.strategy.id === strategy.id) lastRunStrategy.current = null;
    setCatalogMessage(loadedStrategy?.strategy.id === strategy.id
      ? `Deleted ${strategy.name}. The editor keeps its code as an unsaved draft.`
      : `Deleted ${strategy.name}.`);
    try { await refreshStrategies(); } catch { /* the list refreshes on the next open */ }
  };

  /** Persist the Pine code and Paper settings as a version that can be launched. */
  const preparePaperVersion = async ({ settings, fromEditor, python }: PaperVersionRequest): Promise<StrategyDetail> => {
    setCatalogBusy(true);
    setCatalogMessage('');
    try {
      let detail: StrategyDetail;
      if (python) {
        // A pack strategy lives in the library as a reference; its code stays in the pack.
        const source = pythonStrategySource(python.ref);
        const existing = await findSavedPythonStrategy(python.ref, await listStrategies());
        const current = existing ? await loadStrategy(existing.id) : null;
        const input = { name: current?.version.name ?? `${python.name} (Python)`, source, backtestSettings: {},
          paperSettings: settings, metadata: { origin: `python-strategy-pack:${python.ref}` } };
        detail = current && JSON.stringify(current.version.paperSettings) === JSON.stringify(settings)
          ? current
          : current
            ? await saveStrategyVersion(current.strategy.id, { ...input, expectedVersion: current.strategy.currentVersion })
            : await createStrategy(input);
      } else if (fromEditor) {
        const firstVenue = settings.tracks[0]?.venue;
        const request = currentRequest((firstVenue === 'Lighter' ? settings.lighterTakerFeePercent : settings.hyperliquidTakerFeePercent) ?? 0);
        const { source: pineSource, ...backtestSettings } = request;
        const name = strategyName.trim() || /\bstrategy\s*\(\s*['"]([^'"]+)['"]/.exec(pineSource)?.[1] || 'Pine strategy';
        const input = { name, source: pineSource, backtestSettings, paperSettings: settings,
          metadata: loadedStrategy?.version.metadata ?? {} };
        detail = loadedStrategy
          ? await saveStrategyVersion(loadedStrategy.strategy.id, { ...input, expectedVersion: loadedStrategy.strategy.currentVersion })
          : await createStrategy(input);
        setLoadedStrategy(detail);
        setSelectedStrategyId(detail.strategy.id);
        setStrategyName(detail.version.name);
      } else {
        if (!paperStrategy) throw new Error('Choose a saved strategy first.');
        detail = await saveStrategyVersion(paperStrategy.strategy.id, {
          name: paperStrategy.version.name,
          source: paperStrategy.version.source,
          backtestSettings: paperStrategy.version.backtestSettings,
          paperSettings: settings,
          metadata: paperStrategy.version.metadata,
          expectedVersion: paperStrategy.strategy.currentVersion,
        });
        if (loadedStrategy?.strategy.id === detail.strategy.id) setLoadedStrategy(detail);
      }
      setPaperStrategy(detail);
      setCatalogMessage(`Saved ${detail.version.name} for Paper.`);
      try { await refreshStrategies(); } catch { /* the version is saved; the list refreshes later */ }
      return detail;
    } finally {
      setCatalogBusy(false);
    }
  };

  const stop = () => {
    if (!controllerRef.current) return false;
    controllerRef.current.abort();
    return true;
  };
  const runRef = useRef(run);
  const stopRef = useRef(stop);
  runRef.current = run;
  stopRef.current = stop;
  useEffect(() => registerBacktestWebTools({
    run: () => runRef.current(),
    stop: () => stopRef.current(),
    reportError: (reason) => console.warn('WebMCP registration failed', reason),
  }), []);
  const sourceVersion = source.match(/^\s*\/\/@version\s*=\s*(\d+)/m)?.[1] || '?';
  const selectedDays = inclusiveUtcDays(startDate, endDate);
  const dateRangeCopy = selectedDays !== null && selectedDays > 0
    ? {
      en: `${selectedDays} selected calendar days. Historical dates are available; for today, only closed candles are used.`,
      ru: `Выбрано календарных дней: ${selectedDays}. Старые даты доступны; за сегодня используются только закрытые свечи.`,
    }
    : { en: 'Select a valid date range.', ru: 'Выберите корректный период.' };
  const errorCopy = splitBilingual(error);
  const runtimeCopy = result
    ? { en: `${result.runtime.name} ${result.runtime.version} · child process`, ru: `${result.runtime.name} ${result.runtime.version} · дочерний процесс` }
    : { en: 'Public Binance candles: no API key required.', ru: 'Публичные свечи Binance: API-ключ не требуется.' };
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span>P</span><i /></div>
          <div><strong>PINE STRATEGY RUNNER</strong></div>
          <span className={`edition-badge edition-${EDITION}`}>{EDITION_LABEL}</span>
        </div>
        <nav className="top-nav" aria-label="Main navigation">
          <button type="button" className={page !== 'paper-runs' && page !== 'accounts' ? 'active' : ''} onClick={() => navigate(page === 'paper-runs' || page === 'accounts' ? 'backtest' : page)}>Strategy</button>
          <button type="button" className={page === 'paper-runs' ? 'active' : ''} onClick={() => navigate('paper-runs')}>Runs</button>
          {liveTradingAvailable(EDITION) && <button type="button" className={page === 'accounts' ? 'active' : ''} onClick={() => navigate('accounts')}>Accounts</button>}
        </nav>
        <div className="top-status">
          <span><ShieldCheck size={13} />{paperMode}</span>
          <ExchangeLimitsChip view={exchangeLoad} onOpen={() => {
            navigate('accounts');
            window.setTimeout(() => document.getElementById('exchange-limits')?.scrollIntoView({ behavior: 'smooth' }), 100);
          }} />
          <span className="version">v0.1</span>
        </div>
      </header>

      {catalogMessage && <div className="catalog-message" role="status"><span>{catalogMessage}</span>{previousEditors.length > 0 && (catalogMessage.startsWith('Opened ') || catalogMessage === 'Previous editor restored.') && <button type="button" onClick={restorePreviousEditor} disabled={catalogBusy || state === 'running'}>Undo open</button>}</div>}

      {browseStrategies && <div className="strategy-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !catalogBusy) closeOpenDialog(); }}>
        <section className="strategy-dialog" role="dialog" aria-modal="true" aria-labelledby="open-strategy-title">
          <header className="strategy-dialog-heading"><h3 id="open-strategy-title">Open strategy</h3><button type="button" autoFocus onClick={closeOpenDialog} disabled={catalogBusy}>Close</button></header>
          <StrategyLibraryBrowser strategies={strategies} initialSelectedStrategyId={selectedStrategyId} busy={catalogBusy || state === 'running'} onLoadVersion={loadDetailIntoEditor} onDelete={removeStrategy} />
        </section>
      </div>}

      {saveDialogOpen && <div className="strategy-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !catalogBusy) closeSaveDialog(); }}>
        <section className="strategy-dialog strategy-save-dialog" role="dialog" aria-modal="true" aria-labelledby="save-strategy-title">
          <header className="strategy-dialog-heading"><h3 id="save-strategy-title">Save strategy</h3><button type="button" onClick={closeSaveDialog} disabled={catalogBusy}>Close</button></header>
          <form onSubmit={(event) => { event.preventDefault(); void saveFromEditor(!loadedStrategy); }}>
            <label className="strategy-save-name"><span>Strategy name</span><input autoFocus value={saveNameDraft} onChange={(event) => setSaveNameDraft(event.target.value)} maxLength={120} disabled={catalogBusy} /></label>
            <p className="strategy-save-hint">{loadedStrategy ? `Save replaces ${loadedStrategy.version.name} in the library with this code and its settings.` : 'Save creates a strategy with this Pine code and its Backtest and Paper settings. Each name can be used once.'}<InfoTooltip label="saving a strategy" en="Saving stores Pine source, the current backtest settings and a Paper draft in the local catalog. It does not run a backtest or start Paper trading." ru="Сохранение записывает Pine-код, текущие настройки бэктеста и черновик Paper в локальный каталог. Оно не запускает бэктест или пэйпер-торговлю." /></p>
            {saveError && <p className="strategy-save-error" role="alert">{saveError}</p>}
            <div className="strategy-dialog-actions"><button type="button" onClick={closeSaveDialog} disabled={catalogBusy}>Cancel</button><button className="primary" type="submit" disabled={catalogBusy}>{catalogBusy ? 'Saving…' : 'Save'}</button></div>
            {loadedStrategy && <details className="strategy-save-more"><summary>Save as a separate strategy</summary><p>Creates another item in the library from the current editor. Give it a name no other strategy uses.</p><button type="button" onClick={() => { void saveFromEditor(true); }} disabled={catalogBusy}>Create separate strategy</button></details>}
          </form>
        </section>
      </div>}

      {page === 'paper-runs' ? (
        <PaperRunsPreview onPrepare={() => preparePaper(false)} />
      ) : page === 'accounts' ? (
        <LiveAccountsPage onOpenRun={openRun} />
      ) : <>

      <section className="workbench">
        <div className="editor-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">SOURCE · PINE V{sourceVersion}</span><h2>Strategy Editor</h2></div>
            <span className="file-chip">strategy.pine</span>
          </div>
          {catalogEnabled && <div className="strategy-library">
            <div className="strategy-library-summary">
              <div className="strategy-library-current"><span>STRATEGY</span><strong>{loadedStrategy?.version.name ?? 'Unsaved draft'}</strong></div>
              <div className="strategy-library-buttons">
                <button ref={openButtonRef} type="button" onClick={() => setBrowseStrategies(true)} aria-haspopup="dialog" disabled={catalogBusy}>Open</button>
                <button ref={saveButtonRef} type="button" className="primary" onClick={openSaveDialog} aria-haspopup="dialog" disabled={catalogBusy || state === 'running'}>Save</button>
              </div>
            </div>
          </div>}
          <div className="editor-wrap">
            <Editor
              height="100%"
              defaultLanguage="plaintext"
              value={source}
              onChange={(value) => setSource(value || '')}
              onMount={(editor) => { editorRef.current = editor; }}
              theme="vs-dark"
              loading={<span className="editor-loading">Loading the editor…</span>}
              options={{
                minimap: { enabled: false }, fontSize: 16, lineHeight: 24, fontFamily: 'Cascadia Code, Consolas, monospace',
                scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 }, wordWrap: 'on', automaticLayout: true,
                renderLineHighlight: 'line', overviewRulerBorder: false, hideCursorInOverviewRuler: true,
              }}
            />
          </div>
          <PineCheck source={source} symbol={symbol} timeframe={timeframe} onGoToLine={(line) => {
            const editor = editorRef.current;
            if (!editor) return;
            editor.revealLineInCenter(line);
            editor.setPosition({ lineNumber: line, column: 1 });
            editor.focus();
          }} />
          <div className="editor-footer"><span>UTF-8</span><span>Spaces: 4</span><span>UTC</span></div>
        </div>
        <PriceChart result={result} loading={state === 'running'} />
      </section>

      <div className="strategy-tabs" role="tablist" aria-label="Strategy mode">
        <button type="button" role="tab" id="tab-backtest" aria-selected={page === 'backtest'} aria-controls="panel-backtest" className={page === 'backtest' ? 'active' : ''} onClick={() => navigate('backtest')}>Backtest<small>Binance history</small></button>
        <button type="button" role="tab" id="tab-paper" aria-selected={page === 'paper-setup'} aria-controls="panel-paper" className={page === 'paper-setup' ? 'active' : ''} onClick={() => preparePaper(true)}>Paper<small>live prices, virtual money</small></button>
      </div>

      {paperTabMounted && <div role="tabpanel" id="panel-paper" aria-labelledby="tab-paper" hidden={page !== 'paper-setup'}>
        <PaperSetupPreview embedded source={source} fromBacktest={paperFromBacktest} fromEditor strategies={strategies} savedStrategy={loadedStrategy} catalogBusy={catalogBusy} onSelectStrategy={() => undefined} backtestTimeframe={timeframe} backtestSymbol={symbol} onPrepareVersion={preparePaperVersion} onBack={() => navigate('backtest')} onRuns={() => navigate('paper-runs')} onAccounts={() => navigate('accounts')} />
      </div>}

      <div role="tabpanel" id="panel-backtest" aria-labelledby="tab-backtest" hidden={page !== 'backtest'}>
      <section className="control-deck">
        <div className="settings-grid">
          <label><span>Exchange</span><input value="Binance Futures" readOnly /></label>
          <label><span>Market</span><input value="Perpetual" readOnly /></label>
          <BinanceMarketSelector value={symbol} onChange={setSymbol} disabled={state === 'running'} />
          <label><span>Timeframe</span><select value={timeframe} onChange={(event) => setTimeframe(event.target.value as BacktestTimeframe)} disabled={state === 'running'}>{timeframeOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>From · UTC</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} disabled={state === 'running'} /></label>
          <label className="date-range-end"><span>To · UTC · inclusive <InfoTooltip label="date range" en={dateRangeCopy.en} ru={dateRangeCopy.ru} alignRight /></span><input type="date" max={new Date().toISOString().slice(0, 10)} value={endDate} onChange={(event) => setEndDate(event.target.value)} disabled={state === 'running'} /></label>
        </div>
        <div className="run-zone">
          {state === 'running' ? (
            <button className="stop-button" onClick={() => stop()}><Square size={15} fill="currentColor" />Stop</button>
          ) : (
            <button className="run-button" onClick={() => { void run().catch(() => undefined); }} disabled={!preset}><Play size={16} fill="currentColor" />Run Backtest</button>
          )}
          {state !== 'running' && backtestMatchesEditor() && <button className="paper-prepare-button" type="button" onClick={() => preparePaper(true)}>Continue in Paper</button>}
        </div>
      </section>

      <details className="properties-panel" open>
        <summary><span><Settings2 size={15} />Strategy Properties</span><small>Execution model settings</small></summary>
        <div className="properties-content">
          <section className="property-group">
            <div className="property-heading"><span>General</span><strong>Capital and Order Size</strong></div>
            <div className="property-fields">
              <label><span>Initial Capital <InfoTooltip label="initial capital" en="Starting balance of the strategy." ru="Стартовый баланс стратегии." /></span><div className="input-suffix"><input type="number" min="0.01" step="1000" value={initialCapital} onChange={(event) => setInitialCapital(Number(event.target.value))} disabled={state === 'running'} /><span>USDT</span></div></label>
              <label><span>Default Order Size <InfoTooltip label="default order size" en="Choose coin quantity, USDT value, or a share of equity." ru="Выберите количество монет, сумму USDT или долю капитала." /></span><div className="compound-input"><input type="number" min="0.00000001" step="any" value={defaultOrderSizeValue} onChange={(event) => setDefaultOrderSizeValue(Number(event.target.value))} disabled={state === 'running'} /><select value={defaultOrderSizeType} onChange={(event) => setDefaultOrderSizeType(event.target.value as OrderSizeType)} disabled={state === 'running'}><option value="fixed">Quantity</option><option value="cash">USDT</option><option value="percent_of_equity">% of equity</option></select></div></label>
              <label><span>Pyramiding <InfoTooltip label="pyramiding" en="Maximum number of same-direction entries that may remain open." ru="Максимальное число одновременно открытых входов в одном направлении." /></span><input type="number" min="0" max="100" step="1" value={pyramiding} onChange={(event) => setPyramiding(Number(event.target.value))} disabled={state === 'running'} /></label>
            </div>
          </section>

          <section className="property-group">
            <div className="property-heading"><span>Broker Emulation</span><strong>Execution and Costs</strong></div>
            <div className="property-fields broker-fields">
              <label><span>Commission per Fill, % <InfoTooltip label="commission" en="Enter your commission using a dot or comma. It is charged separately on entry and exit; 0% means no commission." ru="Укажите свою комиссию через точку или запятую. Она начисляется отдельно на вход и выход; 0% означает отсутствие комиссии." /></span><div className="input-suffix"><input type="text" inputMode="decimal" value={commissionValueInput} onChange={(event) => setCommissionValueInput(event.target.value)} disabled={state === 'running'} placeholder="Enter %" required /><span>%</span></div></label>
              <label><span>Long Leverage <InfoTooltip label="long leverage" en="Auto reads margin_long from the Pine code." ru="Auto берёт margin_long из Pine-кода." /></span><input value={longLeverage} onChange={(event) => setLongLeverage(event.target.value)} placeholder="Auto / Infinity / 20" disabled={state === 'running'} /></label>
              <label><span>Short Leverage <InfoTooltip label="short leverage" en="20 means 5% margin; Infinity means 0%." ru="20 означает маржу 5%; Infinity означает 0%." /></span><input value={shortLeverage} onChange={(event) => setShortLeverage(event.target.value)} placeholder="Auto / Infinity / 20" disabled={state === 'running'} /></label>
              <label><span>Slippage <InfoTooltip label="slippage" en="Price worsening applied to market and stop orders." ru="Ухудшение цены для рыночных и стоп-заявок." /></span><div className="input-suffix"><input type="number" min="0" step="1" value={slippageTicks} onChange={(event) => setSlippageTicks(Number(event.target.value))} disabled={state === 'running'} /><span>ticks</span></div></label>
              <label><span>Bar Detail <InfoTooltip label="bar detail" en="How orders are checked inside each candle. Every minute: stops, take-profits and limits are checked on every one-minute candle inside it, the most accurate model. 4 points per bar: only open, high, low and close, in the order open → nearer extreme → farther extreme → close. This repeats TradingView's Default bar detailization on a free account (no Bar Magnifier); use it to compare with TradingView. On 1m there are no smaller candles, so 4 points is the only model." ru="Как проверяются заявки внутри каждой свечи. Every minute: стопы, тейки и лимитные заявки проверяются по каждой минутной свече внутри неё — самая точная модель. 4 points per bar: только открытие, максимум, минимум и закрытие в порядке открытие → ближний экстремум → дальний → закрытие. Это повторяет детализацию Default в TradingView на бесплатном аккаунте (без Bar Magnifier); удобно для сверки с TradingView. На 1m меньших свечей нет, поэтому там только 4 точки." /></span><select value={timeframe === '1m' ? 'default' : barDetail} onChange={(event) => setBarDetail(event.target.value as BarDetail)} disabled={state === 'running' || timeframe === '1m'}><option value="high">Every minute (most accurate)</option><option value="default">4 points per bar — as TradingView free (Default)</option></select></label>
              <label className="property-checkbox"><input type="checkbox" checked={processOrdersOnClose} onChange={(event) => setProcessOrdersOnClose(event.target.checked)} disabled={state === 'running'} /><span>Fill Orders on Bar Close <InfoTooltip label="fill orders on bar close" en="Like TradingView's Properties → Fill orders: On bar close. Market orders fill at the close of the candle that placed them instead of the next candle's open. Starts from process_orders_on_close in the script's strategy(...)." ru="Как в TradingView: Properties → Fill orders: On bar close. Рыночные заявки исполняются по закрытию свечи, на которой они выставлены, а не на открытии следующей. Начальное значение берётся из process_orders_on_close в strategy(...) скрипта." /></span></label>
            </div>
          </section>
        </div>

        <details className="backtest-explanation">
          <summary><span>How the Backtest Works</span><small>Detailed execution rules</small></summary>
          <div className="backtest-explanation-content">
            <div className="fixed-execution-model">
              <span>1. Strategy Calculation</span>
              <strong>After each {timeframe} candle closes</strong>
              <small>The strategy checks its conditions after each candle of the selected timeframe closes. It does not calculate a new signal while the next candle is still open. <InfoTooltip label="strategy calculation" en="The strategy checks its conditions after each candle of the selected timeframe closes. It does not calculate a new signal while the next candle is still open." ru="Стратегия проверяет свои условия после закрытия каждой свечи выбранного таймфрейма. Пока следующая свеча ещё открыта, новый сигнал не рассчитывается." /></small>
            </div>
            <div className="fixed-execution-model">
              <span>2. Order Execution</span>
              <strong>Entry on the next candle; stops and take profits checked minute by minute</strong>
              <small>A market order created by a strategy calculation is filled from the opening of the next candle of the selected timeframe. Existing stop and take-profit orders are checked against each one-minute candle, so a trade may close before the strategy calculates its next signal. <InfoTooltip label="order execution" en="A market order created by a strategy calculation is filled from the opening of the next candle of the selected timeframe. Existing stop and take-profit orders are checked against each one-minute candle, so a trade may close before the strategy calculates its next signal." ru="Рыночная заявка, созданная после расчёта стратегии, исполняется начиная с открытия следующей свечи выбранного таймфрейма. Уже выставленные стоп и тейк проверяются по каждой минутной свече, поэтому сделка может закрыться раньше следующего расчёта стратегии." /></small>
            </div>
            <div className="fixed-execution-model">
              <span>Example for {timeframe}</span>
              <strong>Decision → entry → stop check → next decision</strong>
              <small>{executionExamples[timeframe].en} <InfoTooltip label="execution example" en={executionExamples[timeframe].en} ru={executionExamples[timeframe].ru} /></small>
            </div>
            <div className="minute-order-example" role="note">
              <strong>Both stop and take profit were touched in one minute: which one wins?</strong>
              <p>A one-minute candle stores only Open, High, Low, and Close. It does not record whether the high or low happened first. The backtester therefore uses one fixed rule. <InfoTooltip label="one-minute candle rule" en="A one-minute candle stores only Open, High, Low, and Close. It does not record whether the high or low happened first. The backtester therefore uses one fixed rule." ru="Минутная свеча хранит только цены открытия, максимума, минимума и закрытия. Она не показывает, что было раньше — максимум или минимум. Поэтому бэктестер применяет одно постоянное правило." /></p>
              <p>Example: a long position entered at 102 has a stop at 100 and a take profit at 104. During one minute, the low is 100 and the high is 104, so both levels were touched. <InfoTooltip label="stop and take-profit example" en="Example: a long position entered at 102 has a stop at 100 and a take profit at 104. During one minute, the low is 100 and the high is 104, so both levels were touched." ru="Пример: лонг открыт по цене 102, стоп стоит на цене 100, а тейк — на цене 104. За одну минуту минимум равен 100, а максимум — 104, поэтому цена коснулась обоих уровней." /></p>
              <p><b>Open 101:</b> 100 is closer to the opening price than 104. The modeled path moves down first, so the stop at 100 closes the trade. Result: −2 per coin before commission. <InfoTooltip label="opening price 101 example" en="100 is closer to the opening price than 104. The modeled path moves down first, so the stop at 100 closes the trade. Result: −2 per coin before commission." ru="Цена 100 ближе к цене открытия, чем 104. Модель сначала ведёт цену вниз, поэтому сделка закрывается по стопу 100. Результат: −2 за монету до комиссии." /></p>
              <p><b>Open 103:</b> 104 is closer to the opening price than 100. The modeled path moves up first, so the take profit at 104 closes the trade. Result: +2 per coin before commission. <InfoTooltip label="opening price 103 example" en="104 is closer to the opening price than 100. The modeled path moves up first, so the take profit at 104 closes the trade. Result: +2 per coin before commission." ru="Цена 104 ближе к цене открытия, чем 100. Модель сначала ведёт цену вверх, поэтому сделка закрывается по тейку 104. Результат: +2 за монету до комиссии." /></p>
              <small>If the distances are equal, the modeled path moves toward the high first. With an opening price of 102 in this example, the take profit wins. <InfoTooltip label="equal-distance rule" en="If the distances are equal, the modeled path moves toward the high first. With an opening price of 102 in this example, the take profit wins." ru="Если расстояния равны, модель сначала ведёт цену к максимуму. При цене открытия 102 в этом примере первым сработает тейк." /></small>
            </div>
            <p className="experimental-warning"><AlertTriangle size={18} /><span>The actual order of price movements inside that minute is unknown. This is a deterministic calculation rule, not a record of the real price path. <InfoTooltip label="price-path limitation" en="The actual order of price movements inside that minute is unknown. This is a deterministic calculation rule, not a record of the real price path." ru="Настоящий порядок движения цены внутри этой минуты неизвестен. Это постоянное правило расчёта, а не запись реального движения цены." /></span></p>
          </div>
        </details>
      </details>

      {error && <section className="error-banner"><AlertTriangle size={18} /><div><strong>Strategy Did Not Start</strong><p>{errorCopy.en}{errorCopy.ru && <> <InfoTooltip label="run error" en={errorCopy.en} ru={errorCopy.ru} /></>}</p></div></section>}

      <Metrics metrics={result?.metrics || null} />
      <TradesTable trades={result?.trades || []} />

      <footer className="evidence-footer">
        <div><ShieldCheck size={15} /><span>Runtime <InfoTooltip label="runtime" en={runtimeCopy.en} ru={runtimeCopy.ru} /></span><strong>{result ? runtimeCopy.en : `PineTS ${PINETS_VERSION}`}</strong></div>
        <p>Binance Futures data <InfoTooltip label="backtest limitations" alignRight en="Backtests use Binance Futures candles and the commission you enter. Prices and execution may differ on Hyperliquid and Lighter. Funding is not included in PnL, so live results may differ." ru="Бэктест использует свечи Binance Futures и введённую вами комиссию. На Hyperliquid и Lighter цены и исполнение могут отличаться. Фандинг не учитывается в PnL, поэтому реальный результат может быть другим." /></p>
      </footer>
      </div>
      </>}
    </main>
  );
}
