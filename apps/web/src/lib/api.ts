import type {
  BacktestRequest, BacktestResponse, PineCheckRequest, PineCheckResponse, PresetResponse,
} from '../../../../packages/shared/src/contracts';
import type { BinanceFuturesMarketList } from '../../../../packages/shared/src/binance-market-list-contracts';
import type { ExchangeLoadView } from '../../../../packages/shared/src/exchange-load';
import type {
  CreateStrategyInput,
  SaveStrategyVersionInput,
  StrategyDetail,
  StrategySummary,
} from '../../../../packages/shared/src/strategy-catalog-contracts';
import type {
  CreateLiveAccountRequest, LiveAccountFees, LiveAccountView, LiveAccountsView, LiveConnectionCheck, PaperExperimentActivity,
  PaperExperimentCapabilities, PaperExperimentDetail, PaperExperimentSummary, StartPaperExperimentRequest, UpdateLiveAccountRequest,
} from '../../../../packages/shared/src/paper-experiment-contracts';
import type {
  BacktestReport, ReportSettingsView, SheetRowResult, TelegramBacktestPost, TelegramPostResult,
} from '../../../../packages/shared/src/report-contracts';

export type PaperCapabilities = PaperExperimentCapabilities;
export type CreatePaperExperimentInput = StartPaperExperimentRequest;
export type { PaperExperimentActivity, PaperExperimentDetail, PaperExperimentSummary, PaperExperimentStatus, PaperExperimentTrack } from '../../../../packages/shared/src/paper-experiment-contracts';

export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: string | null,
    readonly experiment: PaperExperimentDetail | null,
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

const SIGNED_OUT = 'Your sign-in to this site has expired. Reload the page (⌘R / Ctrl+R) and sign in again; the code in the editor is kept. / '
  + 'Вход на сайт истёк. Обновите страницу (⌘R / Ctrl+R) и войдите снова; код в редакторе сохранится.';
const OFFLINE = 'No connection to the server. Check the internet connection and try again. / '
  + 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';

/**
 * fetch with a plain message instead of the browser's "Failed to fetch": when the sign-in in front of the
 * site (Cloudflare Access) has expired, every request is redirected to its login page and fails that way.
 */
async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    const signedOut = await fetch('/api/health', { redirect: 'manual', cache: 'no-store' })
      .then((response) => response.type === 'opaqueredirect', () => false);
    throw new Error(signedOut ? SIGNED_OUT : OFFLINE);
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new ApiResponseError(
    body.error || `HTTP ${response.status}`,
    response.status,
    typeof body.kind === 'string' ? body.kind : null,
    body.experiment ?? null,
  );
  return body as T;
}

export async function loadPreset(): Promise<PresetResponse> {
  return parse<PresetResponse>(await apiFetch('/api/preset'));
}

export async function loadBinanceFuturesMarkets(signal?: AbortSignal): Promise<BinanceFuturesMarketList> {
  return parse<BinanceFuturesMarketList>(await apiFetch('/api/markets/binance-futures', { signal }));
}

export async function runBacktest(request: BacktestRequest, signal: AbortSignal): Promise<BacktestResponse> {
  try {
    return parse<BacktestResponse>(await apiFetch('/api/backtests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    }));
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('The local server is unavailable. Restart Svit Runner and run the backtest again. / Локальный сервер недоступен. Перезапустите Svit Runner и повторите расчёт.');
    }
    throw error;
  }
}

export async function loadExchangeLoad(signal?: AbortSignal): Promise<ExchangeLoadView> {
  return parse<ExchangeLoadView>(await apiFetch('/api/paper/exchange-load', { signal }));
}

export async function checkPineCode(request: PineCheckRequest, signal: AbortSignal): Promise<PineCheckResponse> {
  return parse<PineCheckResponse>(await apiFetch('/api/pine/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  }));
}

export async function loadStrategyCatalogCapabilities(signal?: AbortSignal): Promise<{ enabled: boolean }> {
  return parse<{ enabled: boolean }>(await apiFetch('/api/strategy-catalog/capabilities', { signal }));
}

export async function listStrategies(): Promise<StrategySummary[]> {
  const result = await parse<{ strategies: StrategySummary[] }>(await apiFetch('/api/strategies'));
  return result.strategies;
}

export async function loadStrategy(id: string): Promise<StrategyDetail> {
  return parse<StrategyDetail>(await apiFetch(`/api/strategies/${encodeURIComponent(id)}`));
}

export async function createStrategy(input: CreateStrategyInput): Promise<StrategyDetail> {
  return parse<StrategyDetail>(await apiFetch('/api/strategies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function saveStrategyVersion(id: string, input: SaveStrategyVersionInput): Promise<StrategyDetail> {
  return parse<StrategyDetail>(await apiFetch(`/api/strategies/${encodeURIComponent(id)}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

/** Removes a strategy from the library for good. */
export async function deleteStrategy(id: string): Promise<void> {
  const response = await apiFetch(`/api/strategies/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) await parse(response);
}

export interface PythonStrategyParam {
  type: 'int' | 'float' | 'bool' | 'str';
  default: number | boolean | string;
  min: number | null;
  max: number | null;
  choices: (number | string)[] | null;
  label: string;
  help: string;
}

export interface PythonStrategyInfo {
  id: string;
  pack: string;
  builtin: boolean;
  name: string;
  description: string;
  timeframe: string;
  warmupBars: number;
  /** At most this many markets of one exchange hold a position at once (null: no limit). */
  maxPositionsPerVenue?: number | null;
  params: Record<string, PythonStrategyParam>;
}

/** Python strategies of the owner's private packs. */
export async function loadPythonStrategies(signal?: AbortSignal): Promise<{ strategies: PythonStrategyInfo[];
  errors: { pack: string; module: string; error: string }[]; packsConfigured: number }> {
  return parse(await apiFetch('/api/python-strategies', { signal }));
}

/** Active USDC perpetuals of one venue, read live by the API; HIP-3 markets (xyz:NVDA) carry a fee multiplier. */
export async function loadPaperMarkets(venue: 'lighter' | 'hyperliquid', signal?: AbortSignal):
  Promise<{ markets: string[]; feeMultipliers: Record<string, number> }> {
  const result = await parse<{ markets: string[]; feeMultipliers?: Record<string, number> }>(
    await apiFetch(`/api/paper/markets?venue=${venue}`, { signal }));
  return { markets: result.markets, feeMultipliers: result.feeMultipliers ?? {} };
}

/** What the server can do now; a site reports its Paper engine as configured only while it answers. */
export interface ServerHealth {
  readonly role?: 'all' | 'engine' | 'site';
  readonly paper: { readonly configured: boolean; readonly acceptingNewRun: boolean };
}

export async function loadServerHealth(signal?: AbortSignal): Promise<ServerHealth> {
  return parse<ServerHealth>(await apiFetch('/api/health', { signal }));
}

/** 24-hour USD volume per market of one venue, for ordering the market picker. */
export async function loadVenueVolumes(venue: 'lighter' | 'hyperliquid', signal?: AbortSignal): Promise<Record<string, number>> {
  const result = await parse<{ volumes: Record<string, number> }>(await apiFetch(`/api/venue-volumes?venue=${venue}`, { signal }));
  return result.volumes;
}

export async function loadPaperCapabilities(signal?: AbortSignal): Promise<PaperCapabilities> {
  return parse<PaperCapabilities>(await apiFetch('/api/paper/capabilities', { signal }));
}

export async function createPaperExperiment(input: CreatePaperExperimentInput): Promise<PaperExperimentDetail> {
  const result = await parse<{ experiment: PaperExperimentDetail }>(await apiFetch('/api/paper-experiments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
  return result.experiment;
}

export async function listPaperExperiments(signal?: AbortSignal): Promise<PaperExperimentSummary[]> {
  const result = await parse<{ experiments: PaperExperimentSummary[] }>(await apiFetch('/api/paper-experiments', { signal }));
  return result.experiments;
}

export async function loadPaperExperiment(id: string, signal?: AbortSignal): Promise<PaperExperimentDetail> {
  const result = await parse<{ experiment: PaperExperimentDetail }>(await apiFetch(`/api/paper-experiments/${encodeURIComponent(id)}`, { signal }));
  return result.experiment;
}

export async function loadPaperExperimentActivity(
  id: string,
  options: { readonly limit?: number; readonly fillsCursor?: string } = {},
  signal?: AbortSignal,
): Promise<PaperExperimentActivity> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.fillsCursor) query.set('fillsCursor', options.fillsCursor);
  const suffix = query.size > 0 ? `?${query}` : '';
  const result = await parse<{ activity: PaperExperimentActivity }>(await apiFetch(
    `/api/paper-experiments/${encodeURIComponent(id)}/activity${suffix}`, { signal },
  ));
  return result.activity;
}

export async function stopPaperExperiment(id: string): Promise<PaperExperimentDetail> {
  const result = await parse<{ experiment: PaperExperimentDetail }>(await apiFetch(`/api/paper-experiments/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  }));
  return result.experiment;
}

export async function loadLiveAccounts(signal?: AbortSignal): Promise<LiveAccountsView> {
  return parse<LiveAccountsView>(await apiFetch('/api/live/accounts', { signal }));
}

/** The API private key is sent once and stored on the machine that runs the engine; it never comes back. */
export async function createLiveAccount(input: CreateLiveAccountRequest): Promise<LiveAccountView> {
  return (await parse<{ account: LiveAccountView }>(await apiFetch('/api/live/accounts', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }))).account;
}

export async function updateLiveAccount(id: string, input: UpdateLiveAccountRequest): Promise<LiveAccountView> {
  return (await parse<{ account: LiveAccountView }>(await apiFetch(`/api/live/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }))).account;
}

export async function removeLiveAccount(id: string): Promise<LiveAccountsView> {
  return parse<LiveAccountsView>(await apiFetch(`/api/live/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function loadLiveAccountFees(id: string, signal?: AbortSignal): Promise<LiveAccountFees> {
  return (await parse<{ fees: LiveAccountFees }>(await apiFetch(`/api/live/accounts/${encodeURIComponent(id)}/fees`, { signal }))).fees;
}

export async function checkLiveAccount(id: string): Promise<LiveConnectionCheck> {
  return (await parse<{ check: LiveConnectionCheck }>(await apiFetch(`/api/live/accounts/${encodeURIComponent(id)}/check`, {
    method: 'POST',
  }))).check;
}

export async function loadReportSettings(signal?: AbortSignal): Promise<ReportSettingsView> {
  return parse<ReportSettingsView>(await apiFetch('/api/reports/settings', { signal }));
}

/** The robot's key is sent once and stays on the server; it never comes back. */
export async function saveGoogleReportSettings(input: { sheet: string; serviceAccountKey?: string }): Promise<ReportSettingsView> {
  return parse<ReportSettingsView>(await apiFetch('/api/reports/google', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }));
}

/** The bot token is sent once and stays on the server; it never comes back. */
export async function saveTelegramReportSettings(input: { channel: string; botToken?: string }): Promise<ReportSettingsView> {
  return parse<ReportSettingsView>(await apiFetch('/api/reports/telegram', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }));
}

export async function addBacktestToSheet(report: BacktestReport): Promise<SheetRowResult> {
  return parse<SheetRowResult>(await apiFetch('/api/reports/backtests/sheet', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report),
  }));
}

export async function postBacktestToTelegram(post: TelegramBacktestPost): Promise<TelegramPostResult> {
  return parse<TelegramPostResult>(await apiFetch('/api/reports/backtests/telegram', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(post),
  }));
}
