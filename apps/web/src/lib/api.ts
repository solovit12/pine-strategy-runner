import type { BacktestRequest, BacktestResponse, PresetResponse } from '../../../../packages/shared/src/contracts';
import type { BinanceFuturesMarketList } from '../../../../packages/shared/src/binance-market-list-contracts';
import type {
  CreateStrategyInput,
  SaveStrategyVersionInput,
  StrategyDetail,
  StrategySummary,
} from '../../../../packages/shared/src/strategy-catalog-contracts';
import type {
  PaperExperimentActivity, PaperExperimentCapabilities, PaperExperimentDetail, PaperExperimentSummary,
  StartPaperExperimentRequest,
} from '../../../../packages/shared/src/paper-experiment-contracts';

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
  return parse<PresetResponse>(await fetch('/api/preset'));
}

export async function loadBinanceFuturesMarkets(signal?: AbortSignal): Promise<BinanceFuturesMarketList> {
  return parse<BinanceFuturesMarketList>(await fetch('/api/markets/binance-futures', { signal }));
}

export async function runBacktest(request: BacktestRequest, signal: AbortSignal): Promise<BacktestResponse> {
  try {
    return parse<BacktestResponse>(await fetch('/api/backtests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    }));
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('The local server is unavailable. Restart Pine Strategy Runner and run the backtest again. / Локальный сервер недоступен. Перезапустите Pine Strategy Runner и повторите расчёт.');
    }
    throw error;
  }
}

export async function loadStrategyCatalogCapabilities(signal?: AbortSignal): Promise<{ enabled: boolean }> {
  return parse<{ enabled: boolean }>(await fetch('/api/strategy-catalog/capabilities', { signal }));
}

export async function listStrategies(): Promise<StrategySummary[]> {
  const result = await parse<{ strategies: StrategySummary[] }>(await fetch('/api/strategies'));
  return result.strategies;
}

export async function loadStrategy(id: string): Promise<StrategyDetail> {
  return parse<StrategyDetail>(await fetch(`/api/strategies/${encodeURIComponent(id)}`));
}

export async function createStrategy(input: CreateStrategyInput): Promise<StrategyDetail> {
  return parse<StrategyDetail>(await fetch('/api/strategies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function saveStrategyVersion(id: string, input: SaveStrategyVersionInput): Promise<StrategyDetail> {
  return parse<StrategyDetail>(await fetch(`/api/strategies/${encodeURIComponent(id)}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

/** Removes a strategy from the library for good. */
export async function deleteStrategy(id: string): Promise<void> {
  const response = await fetch(`/api/strategies/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

/** Python strategies of the built-in example pack and the owner's private packs. */
export async function loadPythonStrategies(signal?: AbortSignal): Promise<{ strategies: PythonStrategyInfo[];
  errors: { pack: string; module: string; error: string }[]; packsConfigured: number }> {
  return parse(await fetch('/api/python-strategies', { signal }));
}

/** Active USDC perpetuals of one venue, read live by the API; HIP-3 markets (xyz:NVDA) carry a fee multiplier. */
export async function loadPaperMarkets(venue: 'lighter' | 'hyperliquid', signal?: AbortSignal):
  Promise<{ markets: string[]; feeMultipliers: Record<string, number> }> {
  const result = await parse<{ markets: string[]; feeMultipliers?: Record<string, number> }>(
    await fetch(`/api/paper/markets?venue=${venue}`, { signal }));
  return { markets: result.markets, feeMultipliers: result.feeMultipliers ?? {} };
}

/** What the server can do now; a site reports its Paper engine as configured only while it answers. */
export interface ServerHealth {
  readonly role?: 'all' | 'engine' | 'site';
  readonly paper: { readonly configured: boolean; readonly acceptingNewRun: boolean };
}

export async function loadServerHealth(signal?: AbortSignal): Promise<ServerHealth> {
  return parse<ServerHealth>(await fetch('/api/health', { signal }));
}

/** 24-hour USD volume per market of one venue, for ordering the market picker. */
export async function loadVenueVolumes(venue: 'lighter' | 'hyperliquid', signal?: AbortSignal): Promise<Record<string, number>> {
  const result = await parse<{ volumes: Record<string, number> }>(await fetch(`/api/venue-volumes?venue=${venue}`, { signal }));
  return result.volumes;
}

export async function loadPaperCapabilities(signal?: AbortSignal): Promise<PaperCapabilities> {
  return parse<PaperCapabilities>(await fetch('/api/paper/capabilities', { signal }));
}

export async function createPaperExperiment(input: CreatePaperExperimentInput): Promise<PaperExperimentDetail> {
  const result = await parse<{ experiment: PaperExperimentDetail }>(await fetch('/api/paper-experiments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
  return result.experiment;
}

export async function listPaperExperiments(signal?: AbortSignal): Promise<PaperExperimentSummary[]> {
  const result = await parse<{ experiments: PaperExperimentSummary[] }>(await fetch('/api/paper-experiments', { signal }));
  return result.experiments;
}

export async function loadPaperExperiment(id: string, signal?: AbortSignal): Promise<PaperExperimentDetail> {
  const result = await parse<{ experiment: PaperExperimentDetail }>(await fetch(`/api/paper-experiments/${encodeURIComponent(id)}`, { signal }));
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
  const result = await parse<{ activity: PaperExperimentActivity }>(await fetch(
    `/api/paper-experiments/${encodeURIComponent(id)}/activity${suffix}`, { signal },
  ));
  return result.activity;
}

export async function stopPaperExperiment(id: string): Promise<PaperExperimentDetail> {
  const result = await parse<{ experiment: PaperExperimentDetail }>(await fetch(`/api/paper-experiments/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  }));
  return result.experiment;
}
