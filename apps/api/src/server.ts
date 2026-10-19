import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import {
  type HistoricalInstrumentResult,
  type HistoricalMarketDataProvider,
  type HistoricalMarketDataResult,
  timeframeToMs,
} from '../../../packages/market-data/src/historical-market-data-provider.js';
import {
  buildMinuteReplayDetailizationData,
  IntrabarDataError,
  MINUTE_MS,
  type HighDetailizationData,
} from '../../../packages/market-data/src/high-detailization.js';
import { BinanceFuturesHistoricalProvider } from '../../../packages/market-data/src/binance-futures-historical-provider.js';
import { assertHighRunConfiguration, HighSafetyError } from '../../../packages/pine-runtime/src/high-safety.js';
import {
  BACKTEST_TIMEFRAME_MS,
  PINE_TIMEFRAME,
  PINETS_VERSION,
  type BacktestResponse,
  type BacktestTimeframe,
  BacktestRequestSchema,
  type Candle,
  type ChartCandle,
  type PresetResponse,
} from '../../../packages/shared/src/contracts.js';
import {
  HYPERLIQUID_BASE_PERPETUAL_FEES,
  feeRateFractionToPercent,
} from '../../../packages/shared/src/venue-fee-schedule.js';
import { CreateStrategySchema, SaveStrategyVersionSchema } from '../../../packages/shared/src/strategy-catalog-contracts.js';
import { StrategyCatalogError, StrategyCatalogV1 } from './strategy-catalog.js';
import {
  aggregateCandles,
  assertCompleteSeries,
  MAX_SERIES_REQUEST_CANDLES,
  SeriesRequestError,
  seriesSourcePlan,
  seriesWindow,
} from '../../../packages/pine-runtime/src/series-requests.js';
import { runPineWorker } from './worker-client.js';
import { BinanceFuturesMarketListService } from './binance-futures-market-list.js';
import { PaperExperimentControllerV1, type PaperExperimentRuntimeFactory } from './paper-execution/paper-experiment-controller.js';
import { EDITION, liveTradingAvailable, pythonStrategiesAvailable, type Edition } from '../../../packages/shared/src/edition.js';
import { createNativePaperFactory } from './paper-execution/native-strategies.js';
import { createPaperRuntimeRouter, createPinePaperFactory } from './paper-execution/pine-paper-factory.js';
import { fetchVenueVolumes, type PaperVenueKey } from './paper-execution/venue-markets.js';
import { isCrossOriginPaperWrite, registerPaperRoutes } from './paper-routes.js';
import { registerLiveRoutes } from './live-routes.js';
import { LiveSettingsStore } from './live-settings.js';
import {
  DEFAULT_ENGINE_URL, ENGINE_TOKEN_HEADER, engineStatus, engineTokenMatches, readEngineToken, registerEngineProxy,
  type EngineConnection,
} from './engine-proxy.js';

const projectRoot = process.cwd();
/** The editor starts from this template; the app ships without bundled strategies. */
const STRATEGY_TEMPLATE = `//@version=6
strategy("My strategy", overlay=true)

// Paste your TradingView strategy here, replacing these lines.
`;
const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_BACKTEST_EXECUTION_MINUTES = 120 * 24 * 60;
export const MAX_BACKTEST_EXECUTION_MINUTES = 189 * 24 * 60;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function bilingualMessage(english: string, russian: string): string {
  return `${english} / ${russian}`;
}

/** Prefixes each language of an "English / Русский" message (or a plain one) separately. */
function prefixedMessage(english: string, russian: string, message: string): string {
  const match = /^(.*?) \/ ([А-ЯЁа-яё].*)$/s.exec(message);
  return bilingualMessage(`${english} ${match ? match[1] : message}`, `${russian} ${match ? match[2] : message}`);
}

/**
 * `all`: one process does everything (development and tests).
 * `engine`: only Paper, behind a shared token, so it survives site restarts.
 * `site`: pages, library and backtests; Paper requests go to the engine.
 */
export type AppRole = 'all' | 'engine' | 'site';

function appRole(value: string | undefined): AppRole {
  if (value === undefined || value === '' || value === 'all') return 'all';
  if (value === 'engine' || value === 'site') return value;
  throw new Error('PSR_ROLE must be all, engine or site.');
}

export interface BuildAppOptions {
  historicalProvider?: HistoricalMarketDataProvider;
  binanceMarketList?: BinanceFuturesMarketListService;
  now?: () => number;
  maxExecutionMinutes?: number;
  strategyCatalogDir?: string | null;
  paperExperimentsDir?: string | null;
  /** Existing local journal root; used only for read-only activity inspection. */
  paperRunsDir?: string | null;
  /** Optional execution owner injected only after separate qualification. */
  paperRuntimeFactory?: PaperExperimentRuntimeFactory | null;
  role?: AppRole;
  /** Engine role: the secret the site must send. */
  engineToken?: string;
  /** Site role: where the engine listens. */
  engine?: EngineConnection;
  /** Defaults to this build's edition; tests pass the other one. */
  edition?: Edition;
  /** Where Live trading credentials are kept (default: `live-secrets` next to the Paper history). */
  liveSecretsDir?: string;
  /** A server-managed closed folder with the same credentials file, read as a fallback (null: none). */
  liveServerSecretsDir?: string | null;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function defaultHistoricalProvider(): HistoricalMarketDataProvider {
  return new BinanceFuturesHistoricalProvider({
    timeoutMs: positiveInteger(
      process.env.BINANCE_FUTURES_REQUEST_TIMEOUT_MS,
      30_000,
      'BINANCE_FUTURES_REQUEST_TIMEOUT_MS',
    ),
  });
}

function utcDateStart(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function candlesSha256(candles: Candle[]): string {
  const hash = createHash('sha256');
  for (const candle of candles) {
    hash.update(
      `${candle.openTime},${candle.open},${candle.high},${candle.low},${candle.close},${candle.volume}\n`,
    );
  }
  return hash.digest('hex');
}

function countMissingBars(candles: Candle[], intervalMs: number): number {
  let missing = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index]!.openTime - candles[index - 1]!.openTime;
    if (delta <= 0 || delta % intervalMs !== 0) {
      throw new Error(bilingualMessage(
        'The history source returned candles in an invalid order or with an invalid interval.',
        'Источник истории вернул свечи с неправильным порядком или шагом времени.',
      ));
    }
    missing += delta / intervalMs - 1;
  }
  return missing;
}

function chartCandles(candles: Candle[]): ChartCandle[] {
  return candles.map((candle) => ({
    time: Math.floor(candle.openTime / 1_000),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  }));
}

function tradingViewTicker(exchange: 'Binance' | 'Hyperliquid', symbol: string): string {
  return exchange === 'Binance' ? `BINANCE:${symbol}.P` : `HYPERLIQUID:${symbol}USDC.P`;
}

function decimalStep(decimals: number): number {
  return decimals === 0 ? 1 : Number(`1e-${decimals}`);
}

function instrumentPrecision(
  instrument: HistoricalInstrumentResult,
): {
  mintick: number;
  minContract: number;
  reconciliationTickSize: number;
} {
  if (instrument.provenance.venue === 'binance') {
    const tick = instrument.priceTickSize;
    const step = instrument.quantityStepSize;
    const minQuantity = instrument.minQuantity ?? step;
    if (!tick || !step || !minQuantity || ![tick, step, minQuantity].every(Number.isFinite)
      || tick <= 0 || step <= 0 || minQuantity <= 0) {
      throw new Error(bilingualMessage(
        'Binance Futures returned an invalid price tick or quantity step.',
        'Binance Futures вернул некорректный шаг цены или объёма.',
      ));
    }
    return { mintick: tick, minContract: minQuantity, reconciliationTickSize: tick };
  }
  const sizeDecimals = instrument.szDecimals;
  if (!Number.isSafeInteger(sizeDecimals) || sizeDecimals < 0 || sizeDecimals > 6) {
    throw new Error(bilingualMessage(
      `0xArchive returned an unsupported sz_decimals value: ${sizeDecimals}.`,
      `0xArchive вернул неподдерживаемое значение sz_decimals: ${sizeDecimals}.`,
    ));
  }
  const minimumPriceIncrement = decimalStep(6 - sizeDecimals);
  return {
    mintick: minimumPriceIncrement,
    minContract: decimalStep(sizeDecimals),
    reconciliationTickSize: minimumPriceIncrement,
  };
}

function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectCompleteCandles(
  result: HistoricalMarketDataResult,
  startInclusive: number,
  endExclusive: number,
  intervalMs: number,
  now: number,
): { candles: Candle[]; excludedIncomplete: number; expectedBars: number } {
  const boundedEndExclusive = Math.min(endExclusive, now);
  const expectedBars = Math.max(0, Math.floor((boundedEndExclusive - startInclusive) / intervalMs));
  const completeEndExclusive = startInclusive + expectedBars * intervalMs;
  const candles = result.candles.filter((candle) =>
    candle.openTime >= startInclusive && candle.closeTime < completeEndExclusive);
  return {
    candles,
    expectedBars,
    excludedIncomplete: result.candles.length - candles.length,
  };
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true, bodyLimit: 512 * 1024 });
  const role = options.role ?? appRole(process.env.PSR_ROLE);
  const engineTokenFile = process.env.PSR_ENGINE_TOKEN_FILE;
  if (role === 'engine') {
    const token = options.engineToken ?? (engineTokenFile ? readEngineToken(engineTokenFile) : undefined);
    if (!token) throw new Error('The Paper engine needs PSR_ENGINE_TOKEN_FILE.');
    app.addHook('onRequest', async (request, reply) => {
      if (!engineTokenMatches(request.headers[ENGINE_TOKEN_HEADER], token)) {
        return reply.code(401).send({ kind: 'PAPER_ENGINE_UNAUTHORIZED', error: 'Only the site may call the Paper engine.' });
      }
    });
  }
  const engine: EngineConnection | null = role !== 'site' ? null : options.engine ?? (() => {
    if (!engineTokenFile) throw new Error('The site needs PSR_ENGINE_TOKEN_FILE to reach the Paper engine.');
    return { url: process.env.PSR_ENGINE_URL || DEFAULT_ENGINE_URL, token: readEngineToken(engineTokenFile) };
  })();
  const historicalProvider = options.historicalProvider ?? defaultHistoricalProvider();
  const binanceMarketList = options.binanceMarketList ?? new BinanceFuturesMarketListService();
  const now = options.now ?? Date.now;
  const strategyCatalogDir = options.strategyCatalogDir === null
    ? null
    : options.strategyCatalogDir
      ?? process.env.STRATEGY_CATALOG_DIR
      ?? (process.env.NODE_ENV === 'production' ? null : path.join(projectRoot, '.local', 'strategy-catalog'));
  let strategyCatalog: StrategyCatalogV1 | null = null;
  const getStrategyCatalog = (): StrategyCatalogV1 | null => {
    if (!strategyCatalogDir) return null;
    strategyCatalog ??= new StrategyCatalogV1(strategyCatalogDir, now);
    return strategyCatalog;
  };
  const paperExperimentsDir = options.paperExperimentsDir === null
    ? null
    : options.paperExperimentsDir
      ?? process.env.PAPER_EXPERIMENTS_DIR
      ?? (process.env.NODE_ENV === 'production' ? null : path.join(projectRoot, '.local', 'paper-experiments'));
  const paperRunsDir = options.paperRunsDir === null ? null
    : options.paperRunsDir ?? process.env.PAPER_RUNS_DIR ?? path.join(projectRoot, '.local', 'paper-runs');
  const edition = options.edition ?? EDITION;
  const pythonStrategies = pythonStrategiesAvailable(edition);
  // Live trading: switched on and a Lighter key saved on this machine (the setup page), unless the
  // server operator switched it off. The key stays in this folder; the engine reads it from there.
  const liveSecretsDir = options.liveSecretsDir ?? process.env.PSR_LIVE_SECRETS_DIR
    ?? (paperExperimentsDir ? path.join(path.dirname(paperExperimentsDir), 'live-secrets') : path.join(projectRoot, '.local', 'live-secrets'));
  const liveSettings = role === 'site' ? null : new LiveSettingsStore(liveSecretsDir,
    options.liveServerSecretsDir === undefined ? '/etc/psr-secrets' : options.liveServerSecretsDir);
  const liveTrading = () => liveTradingAvailable(edition) && Boolean(liveSettings?.liveTrading());
  // Private Python strategy packs: absolute folders, never part of this repository.
  const strategyPacks = !pythonStrategies ? [] : (process.env.PSR_STRATEGY_PACKS ?? '').split(path.delimiter)
    .map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));
  // An engine release runs from its own folder; the Python environment stays in the project.
  const nautilusPython = process.env.PSR_NAUTILUS_PYTHON
    || path.join(projectRoot, '.local/nautilus-hl-fast5-rc7-20261018/.venv/bin/python');
  const paperRuntimeFactory = role === 'site' ? null : options.paperRuntimeFactory !== undefined
    ? options.paperRuntimeFactory
    : process.env.NODE_ENV !== 'production'
      && (process.env.PAPER_ENABLED === '1' || process.env.PAPER_HLL_HYPE_PILOT_ENABLED === '1')
      && strategyCatalogDir && paperExperimentsDir
      ? (() => {
        const shared = {
          catalogDir: strategyCatalogDir,
          runtimeDir: paperRunsDir ?? path.join(projectRoot, '.local', 'paper-runs'),
          projectRoot,
          pythonPath: nautilusPython,
          hyperliquidFastBook: true,
        };
        return createPaperRuntimeRouter(createNativePaperFactory(shared),
          createPinePaperFactory({ ...shared, strategyPacks, liveTrading, liveSecretsDir }));
      })()
      : null;
  if (paperRuntimeFactory && strategyCatalogDir) getStrategyCatalog();
  const paperExperiments = role === 'site' ? null : new PaperExperimentControllerV1({
    directory: paperExperimentsDir, catalogConfigured: Boolean(strategyCatalogDir),
    runtimeFactory: paperRuntimeFactory, now, pythonStrategies, liveTrading,
  });
  app.addHook('onClose', async () => { await paperExperiments?.close(); strategyCatalog?.close(); });
  // Runs the system stopped for a server shutdown start again once this engine is up.
  if (paperExperiments && paperRuntimeFactory && process.env.PSR_RESUME_AFTER_RESTART !== '0') {
    app.addHook('onReady', async () => {
      const catalog = getStrategyCatalog();
      if (!catalog) return;
      void paperExperiments.resumeAfterRestart((id, version) => catalog.get(id, version)).then((results) => {
        for (const result of results) {
          if (result.resumedId) app.log.info(result, 'Paper run resumed after a server restart');
          else app.log.warn(result, 'Paper run was not resumed after a server restart');
        }
      }, (error) => app.log.error({ err: error }, 'Resuming Paper runs after a server restart failed'));
    });
  }
  const paperStatus = async () => paperExperiments
    ? { reachable: Boolean(paperRuntimeFactory), capabilities: paperExperiments.capabilities() }
    : engineStatus(engine!);
  if (options.maxExecutionMinutes !== undefined
    && (!Number.isSafeInteger(options.maxExecutionMinutes) || options.maxExecutionMinutes <= 0)) {
    throw new Error('maxExecutionMinutes must be a positive integer.');
  }
  const maxExecutionMinutes = options.maxExecutionMinutes
    ?? positiveInteger(
      process.env.BACKTEST_MAX_EXECUTION_MINUTES,
      DEFAULT_MAX_BACKTEST_EXECUTION_MINUTES,
      'BACKTEST_MAX_EXECUTION_MINUTES',
    );
  if (maxExecutionMinutes > MAX_BACKTEST_EXECUTION_MINUTES) {
    throw new Error(
      `BACKTEST_MAX_EXECUTION_MINUTES must not exceed the built-in ${MAX_BACKTEST_EXECUTION_MINUTES} minute ceiling.`,
    );
  }
  let activeBacktest = false;

  app.get('/api/health', async () => {
    // Configured Paper stays 'backtest-and-paper' while its slots are busy; a site needs a reachable engine.
    const { reachable: configured, capabilities } = await paperStatus();
    return {
      status: 'ok',
      role,
      mode: configured ? 'backtest-and-paper' : 'backtest-only',
      paper: { configured, acceptingNewRun: capabilities.available },
      runtime: `PineTS ${PINETS_VERSION}`,
      historicalData: {
        provider: 'Binance Futures',
        venue: 'binance',
        configured: true,
      },
      backtestCapacity: {
        maxConcurrentRuns: 1,
        maxExecutionMinutes,
      },
    };
  });

  app.get('/api/markets/binance-futures', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store');
      return await binanceMarketList.getTopMarkets();
    } catch {
      return reply.code(503).send({
        kind: 'BINANCE_MARKET_LIST_UNAVAILABLE',
        error: bilingualMessage(
          'The Binance Futures market list is unavailable. Try again shortly.',
          'Список рынков Binance Futures недоступен. Повторите попытку позже.',
        ),
      });
    }
  });

  app.get('/api/preset', async (): Promise<PresetResponse> => {
    const source = STRATEGY_TEMPLATE;
    // The last 30 full UTC days.
    const today = new Date(now()).toISOString().slice(0, 10);
    const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    return {
      id: 'TEMPLATE',
      name: 'My strategy',
      source,
      sourceSha256: sha256(source),
      configuration: {
        exchange: 'Binance',
        marketType: 'Perpetual',
        symbol: 'BTCUSDT',
        timeframe: '1h',
        dateRange: { start: day(-30), end: day(-1) },
        initialCapital: 100_000,
        baseCurrency: 'USDT',
        defaultOrderSizeValue: 0.01,
        defaultOrderSizeType: 'fixed',
        pyramiding: 1,
        feeModel: 'manual',
        feeSchedule: null,
        liquidityAssumption: 'uniform_manual',
        commissionType: 'percent',
        commissionValue: null,
        slippageTicks: 0,
        timezone: 'UTC',
      },
    };
  });

  app.get('/api/strategy-catalog/capabilities', async () => ({
    enabled: Boolean(strategyCatalogDir),
    maxStrategies: 100,
    maxVersionsPerStrategy: 100,
    paperLaunchEnabled: Boolean(strategyCatalogDir) && (await paperStatus()).capabilities.available,
  }));

  if (paperExperiments) {
    registerPaperRoutes(app, {
      paperExperiments, paperRuntimeFactory, paperRunsDir, strategyPacks, nautilusPython, projectRoot, getStrategyCatalog, pythonStrategies,
    });
    if (liveSettings) registerLiveRoutes(app, { store: liveSettings, paperExperiments, nautilusPython, projectRoot });
  } else if (engine) {
    registerEngineProxy(app, engine);
  }
  // The engine serves only Paper; the site owns pages, the library and backtests.
  if (role === 'engine') return app;

  // Market picker ordering only; served by the site so it never touches the Paper engine.
  const venueVolumeCache = new Map<PaperVenueKey, { at: number; volumes: Record<string, number> }>();
  app.get<{ Querystring: { venue?: string } }>('/api/venue-volumes', async (request, reply) => {
    const venue = request.query.venue;
    if (venue !== 'lighter' && venue !== 'hyperliquid') {
      return reply.code(400).send({ kind: 'INVALID_VENUE', error: 'venue must be lighter or hyperliquid.' });
    }
    const cached = venueVolumeCache.get(venue);
    if (!cached || Date.now() - cached.at > 10 * 60_000) {
      try {
        venueVolumeCache.set(venue, { at: Date.now(), volumes: await fetchVenueVolumes(venue) });
      } catch (error) {
        if (!cached) {
          return reply.code(502).send({ kind: 'VENUE_UNAVAILABLE',
            error: `Could not load ${venue} volumes: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }
    reply.header('Cache-Control', 'no-store');
    return { venue, volumes: venueVolumeCache.get(venue)!.volumes };
  });

  app.get('/api/strategies', async (_request, reply) => {
    const catalog = getStrategyCatalog();
    if (!catalog) return reply.code(503).send({ kind: 'STRATEGY_CATALOG_NOT_CONFIGURED', error: 'Strategy saving needs STRATEGY_CATALOG_DIR.' });
    return { strategies: catalog.list() };
  });

  app.get<{ Params: { id: string } }>('/api/strategies/:id', async (request, reply) => {
    const catalog = getStrategyCatalog();
    if (!catalog) return reply.code(503).send({ kind: 'STRATEGY_CATALOG_NOT_CONFIGURED', error: 'Strategy saving needs STRATEGY_CATALOG_DIR.' });
    const detail = catalog.get(request.params.id);
    return detail ?? reply.code(404).send({ kind: 'STRATEGY_NOT_FOUND', error: 'Strategy not found.' });
  });

  app.get<{ Params: { id: string } }>('/api/strategies/:id/versions', async (request, reply) => {
    const catalog = getStrategyCatalog();
    if (!catalog) return reply.code(503).send({ kind: 'STRATEGY_CATALOG_NOT_CONFIGURED', error: 'Strategy saving needs STRATEGY_CATALOG_DIR.' });
    const versions = catalog.listVersions(request.params.id);
    return versions === null
      ? reply.code(404).send({ kind: 'STRATEGY_NOT_FOUND', error: 'Strategy not found.' })
      : { versions };
  });

  app.get<{ Params: { id: string; version: string } }>('/api/strategies/:id/versions/:version', async (request, reply) => {
    const catalog = getStrategyCatalog();
    if (!catalog) return reply.code(503).send({ kind: 'STRATEGY_CATALOG_NOT_CONFIGURED', error: 'Strategy saving needs STRATEGY_CATALOG_DIR.' });
    if (!/^\d+$/.test(request.params.version)) {
      return reply.code(404).send({ kind: 'STRATEGY_VERSION_NOT_FOUND', error: 'Strategy version not found.' });
    }
    const detail = catalog.get(request.params.id, Number(request.params.version));
    return detail ?? reply.code(404).send({ kind: 'STRATEGY_VERSION_NOT_FOUND', error: 'Strategy version not found.' });
  });

  app.post('/api/strategies', async (request, reply) => {
    const catalog = getStrategyCatalog();
    if (!catalog) return reply.code(503).send({ kind: 'STRATEGY_CATALOG_NOT_CONFIGURED', error: 'Strategy saving needs STRATEGY_CATALOG_DIR.' });
    const parsed = CreateStrategySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ kind: 'INVALID_STRATEGY', error: 'Invalid strategy settings.', details: parsed.error.issues });
    try {
      return reply.code(201).send(catalog.create(parsed.data));
    } catch (error) {
      if (error instanceof StrategyCatalogError && (error.kind === 'CATALOG_LIMIT' || error.kind === 'NAME_TAKEN')) {
        return reply.code(409).send({ kind: error.kind, error: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/strategies/:id/versions', async (request, reply) => {
    const catalog = getStrategyCatalog();
    if (!catalog) return reply.code(503).send({ kind: 'STRATEGY_CATALOG_NOT_CONFIGURED', error: 'Strategy saving needs STRATEGY_CATALOG_DIR.' });
    const parsed = SaveStrategyVersionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ kind: 'INVALID_STRATEGY', error: 'Invalid strategy settings.', details: parsed.error.issues });
    try {
      return reply.code(201).send(catalog.saveVersion(request.params.id, parsed.data));
    } catch (error) {
      if (error instanceof StrategyCatalogError) {
        const status = error.kind === 'NOT_FOUND' ? 404
          : error.kind === 'VERSION_CONFLICT' || error.kind === 'CATALOG_LIMIT' || error.kind === 'NAME_TAKEN' ? 409 : 500;
        return reply.code(status).send({ kind: error.kind, error: error.message });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/strategies/:id', async (request, reply) => {
    const catalog = getStrategyCatalog();
    if (!catalog) return reply.code(503).send({ kind: 'STRATEGY_CATALOG_NOT_CONFIGURED', error: 'Strategy saving needs STRATEGY_CATALOG_DIR.' });
    if (isCrossOriginPaperWrite(request)) {
      return reply.code(403).send({ kind: 'STRATEGY_ORIGIN_FORBIDDEN', error: 'Deleting a strategy requires a same-origin request.' });
    }
    try {
      catalog.delete(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof StrategyCatalogError && error.kind === 'NOT_FOUND') {
        return reply.code(404).send({ kind: 'STRATEGY_NOT_FOUND', error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/backtests', async (request, reply) => {
    const parsed = BacktestRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: bilingualMessage('Invalid run settings.', 'Некорректные настройки запуска.'),
        details: parsed.error.issues,
      });
    }

    if (options.historicalProvider === undefined && parsed.data.exchange !== 'Binance') {
      return reply.code(422).send({
        error: bilingualMessage(
          'This service runs backtests only on public Binance Futures history.',
          'Этот сервис выполняет бэктест только на публичной истории Binance Futures.',
        ),
        kind: 'UNSUPPORTED_HISTORICAL_VENUE',
      });
    }

    const symbol = parsed.data.symbol.trim().toUpperCase();
    if (parsed.data.barDetailization === 'high') {
      try {
        assertHighRunConfiguration({
          exchange: parsed.data.exchange,
          marketType: parsed.data.marketType,
          symbol,
          timeframe: parsed.data.timeframe,
          barIndexOffset: parsed.data.barIndexOffset,
          calcOnOrderFills: parsed.data.calcOnOrderFills,
          calcOnEveryTick: parsed.data.calcOnEveryTick,
          calcOnEveryHistoryTick: parsed.data.calcOnEveryHistoryTick,
          processOrdersOnClose: parsed.data.processOrdersOnClose,
        });
      } catch (error) {
        if (error instanceof HighSafetyError) {
          return reply.code(422).send({
            error: `${bilingualMessage('Unsupported detailization settings.', 'Неподдерживаемые настройки детализации.')} ${error.message}`,
            kind: error.kind,
            details: error.details,
          });
        }
        throw error;
      }
    }

    if (activeBacktest) {
      return reply.code(409).send({
        error: bilingualMessage(
          'Another backtest is already running. Wait for it to finish or stop it before starting a new one.',
          'Другой бэктест уже выполняется. Дождитесь его завершения или остановите его перед новым запуском.',
        ),
        kind: 'BACKTEST_ALREADY_RUNNING',
      });
    }
    activeBacktest = true;

    const started = performance.now();
    const abortController = new AbortController();
    let finished = false;
    reply.raw.once('close', () => {
      if (!finished) abortController.abort();
    });

    try {

    const venueFeeSchedule = parsed.data.exchange === 'Hyperliquid'
      && parsed.data.feeModel === 'venue_default_all_taker_v1'
      ? HYPERLIQUID_BASE_PERPETUAL_FEES
      : null;
    const effectiveCommissionType = venueFeeSchedule ? 'percent' as const : parsed.data.commissionType;
    const effectiveCommissionValue = venueFeeSchedule
      ? feeRateFractionToPercent(venueFeeSchedule.takerFeeRate)
      : parsed.data.commissionValue;
    const intervalMs = timeframeToMs(parsed.data.timeframe);
    const startInclusive = utcDateStart(parsed.data.dateRange.start);
    const endExclusive = utcDateStart(parsed.data.dateRange.end) + DAY_MS;
    const requestNow = now();
    if (endExclusive > Math.floor(requestNow / DAY_MS) * DAY_MS + DAY_MS) {
      finished = true;
      return reply.code(422).send({
        error: bilingualMessage(
          'The end date cannot be later than today in UTC.',
          'Конечная дата не может быть позже сегодняшнего дня UTC.',
        ),
        kind: 'INVALID_DATE_RANGE',
      });
    }
    const expectedParentBars = Math.max(
      0,
      Math.floor((Math.min(endExclusive, requestNow) - startInclusive) / intervalMs),
    );
    const completeParentEndExclusive = startInclusive + expectedParentBars * intervalMs;
    if (expectedParentBars === 0) {
      finished = true;
      return reply.code(422).send({
        error: bilingualMessage(
          'The selected period does not contain any closed candles yet.',
          'В выбранном периоде пока нет закрытых свечей.',
        ),
        kind: 'market-data-incomplete',
      });
    }
    const expectedMinuteBarsFromWindow = expectedParentBars * (intervalMs / MINUTE_MS);
    if (expectedMinuteBarsFromWindow > maxExecutionMinutes) {
      finished = true;
      return reply.code(422).send({
        error: `This run needs ${expectedMinuteBarsFromWindow.toLocaleString('en-US')} execution minutes, but this server allows ${maxExecutionMinutes.toLocaleString('en-US')}. Reduce the period. / Для запуска нужно ${expectedMinuteBarsFromWindow.toLocaleString('ru-RU')} минут исполнения, а лимит этого сервера — ${maxExecutionMinutes.toLocaleString('ru-RU')}. Уменьшите период.`,
        kind: 'INTRABAR_LIMIT_EXCEEDED',
        details: {
          expectedMinuteBars: expectedMinuteBarsFromWindow,
          maxMinuteReplayBars: maxExecutionMinutes,
          requiredExecutionMinutes: expectedMinuteBarsFromWindow,
          maxExecutionMinutes,
        },
      });
    }

    let parentResult: HistoricalMarketDataResult;
    let instrument: Awaited<ReturnType<HistoricalMarketDataProvider['getInstrument']>>;
    try {
      [parentResult, instrument] = await Promise.all([
        historicalProvider.getCandles({
          symbol,
          interval: parsed.data.timeframe,
          startInclusive,
          endExclusive: completeParentEndExclusive,
          signal: abortController.signal,
        }),
        historicalProvider.getInstrument(symbol, abortController.signal),
      ]);
    } catch (error) {
      finished = true;
      return reply.code(502).send({
        error: `${bilingualMessage(
          `Could not load ${parsed.data.exchange} Futures history.`,
          `Не удалось получить исторические данные ${parsed.data.exchange} Futures.`,
        )} ${providerErrorMessage(error)}`,
        kind: 'market-data',
      });
    }

    const expectedVenue = parsed.data.exchange === 'Binance' ? 'binance' : 'hyperliquid';
    if (parentResult.provenance.venue !== expectedVenue || instrument.provenance.venue !== expectedVenue
      || parentResult.provenance.symbol !== symbol || instrument.symbol !== symbol) {
      finished = true;
      return reply.code(422).send({
        error: bilingualMessage(
          'The data source does not match the selected market. The backtest was stopped.',
          'Источник данных и выбранный рынок не совпадают. Бэктест остановлен.',
        ),
        kind: 'market-data-mismatch',
      });
    }

    if (!instrument.isActive || instrument.instrumentType !== 'perp') {
      finished = true;
      return reply.code(422).send({
        error: bilingualMessage(
          `${symbol} is not an active perpetual contract on the selected exchange.`,
          `Инструмент ${symbol} не является активным бессрочным контрактом выбранной биржи.`,
        ),
        kind: 'market-data',
      });
    }

    const selected = selectCompleteCandles(
      parentResult,
      startInclusive,
      endExclusive,
      intervalMs,
      requestNow,
    );
    if (selected.candles.length === 0) {
      finished = true;
      return reply.code(422).send({
        error: bilingualMessage(
          `The selected UTC period has no closed ${symbol} candles.`,
          `В выбранном UTC-периоде нет закрытых свечей ${symbol}.`,
        ),
        kind: 'market-data',
      });
    }
    if (
      selected.candles.length !== selected.expectedBars
      || selected.candles[0]!.openTime !== startInclusive
      || selected.candles.at(-1)!.closeTime + 1 !== startInclusive + selected.expectedBars * intervalMs
    ) {
      finished = true;
      return reply.code(422).send({
        error: bilingualMessage(
          `The history source returned incomplete coverage: expected ${selected.expectedBars} closed candles and received ${selected.candles.length}. The backtest was stopped.`,
          `Источник истории вернул неполное покрытие периода: ожидалось ${selected.expectedBars} закрытых свечей, получено ${selected.candles.length}. Бэктест остановлен.`,
        ),
        kind: 'market-data-incomplete',
      });
    }

    let missingBars: number;
    try {
      missingBars = countMissingBars(selected.candles, intervalMs);
    } catch (error) {
      finished = true;
      return reply.code(422).send({
        error: `${bilingualMessage('Historical candle validation failed.', 'Проверка исторических свечей завершилась ошибкой.')} ${providerErrorMessage(error)}`,
        kind: 'market-data',
      });
    }
    if (missingBars > 0) {
      finished = true;
      return reply.code(422).send({
        error: bilingualMessage(
          `${missingBars} gaps were found in the parent candles. The backtest was stopped without replacing data.`,
          `В родительских свечах найдено ${missingBars} пропусков. Бэктест остановлен без подмены данных.`,
        ),
        kind: 'market-data-incomplete',
      });
    }

    const precision = instrumentPrecision(instrument);

    let highDetailization: HighDetailizationData | undefined;
    let minuteResult: HistoricalMarketDataResult | undefined;
    if (parsed.data.barDetailization === 'high') {
      const minutesPerParent = intervalMs / MINUTE_MS;
      const expectedMinuteBars = selected.candles.length * minutesPerParent;
      if (expectedMinuteBars > maxExecutionMinutes) {
        finished = true;
        return reply.code(422).send({
          error: `This run needs ${expectedMinuteBars.toLocaleString('en-US')} execution minutes, but this server allows ${maxExecutionMinutes.toLocaleString('en-US')}. Reduce the period. / Для запуска нужно ${expectedMinuteBars.toLocaleString('ru-RU')} минут исполнения, а лимит этого сервера — ${maxExecutionMinutes.toLocaleString('ru-RU')}. Уменьшите период.`,
          kind: 'INTRABAR_LIMIT_EXCEEDED',
          details: {
            expectedMinuteBars,
            maxMinuteReplayBars: maxExecutionMinutes,
            requiredExecutionMinutes: expectedMinuteBars,
            maxExecutionMinutes,
          },
        });
      }

      try {
        minuteResult = await historicalProvider.getCandles({
          symbol,
          interval: '1m',
          startInclusive: selected.candles[0]!.openTime,
          endExclusive: selected.candles.at(-1)!.openTime + intervalMs,
          signal: abortController.signal,
        });
        if (minuteResult.provenance.venue !== expectedVenue || minuteResult.provenance.symbol !== symbol) {
          throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', bilingualMessage(
            'The minute-candle source does not match the selected market. The backtest was stopped.',
            'Источник минутных свечей не совпадает с выбранным рынком. Бэктест остановлен.',
          ));
        }
        highDetailization = buildMinuteReplayDetailizationData(
          selected.candles,
          minuteResult.candles,
          {
            tickSize: precision.reconciliationTickSize,
            symbol,
            parentTimeframe: parsed.data.timeframe as Exclude<BacktestTimeframe, '1m'>,
            sourceSha256: minuteResult.provenance.sha256,
            fetchedAt: minuteResult.provenance.fetchedAt,
            pages: minuteResult.provenance.pages,
            cache: 'network',
            materializeReplayTicks: false,
          },
        );
      } catch (error) {
        finished = true;
        if (error instanceof IntrabarDataError) {
          const statusCode = error.kind === 'INTRABAR_FETCH_FAILED' ? 502 : 422;
          return reply.code(statusCode).send({
            error: `${bilingualMessage('Minute execution data is invalid.', 'Минутные данные исполнения некорректны.')} ${error.message}`,
            kind: error.kind,
            details: error.details,
          });
        }
        return reply.code(502).send({
          error: `${bilingualMessage(
            'Could not prepare minute-by-minute execution checks.',
            'Не удалось подготовить минутную проверку исполнения.',
          )} ${providerErrorMessage(error)}`,
          kind: 'INTRABAR_FETCH_FAILED',
        });
      }
    }

    const seriesNotes: string[] = [];
    const workerResult = await runPineWorker({
      source: parsed.data.source,
      candles: selected.candles,
      barIndexOffset: parsed.data.barIndexOffset,
      market: {
        tickerId: tradingViewTicker(parsed.data.exchange, symbol),
        symbol,
        exchange: parsed.data.exchange,
        quoteCurrency: parsed.data.baseCurrency,
        timeframe: parsed.data.timeframe,
        pineTimeframe: PINE_TIMEFRAME[parsed.data.timeframe],
        mintick: precision.mintick,
        minContract: precision.minContract,
      },
      ...(highDetailization ? {
        highReplay: {
          replayBars: highDetailization.replayBars,
          replayTicks: highDetailization.replayTicks,
          deriveTicksFromBars: true,
        },
      } : {}),
      execution: {
        initialCapital: parsed.data.initialCapital,
        defaultOrderSizeValue: parsed.data.defaultOrderSizeValue,
        defaultOrderSizeType: parsed.data.defaultOrderSizeType,
        pyramiding: parsed.data.pyramiding,
        commissionType: effectiveCommissionType,
        commissionValue: effectiveCommissionValue,
        marginLongPercent: parsed.data.marginLongPercent,
        marginShortPercent: parsed.data.marginShortPercent,
        slippageTicks: parsed.data.slippageTicks,
        processOrdersOnClose: parsed.data.processOrdersOnClose,
      },
    }, abortController.signal, {
      // request.security of this symbol on another timeframe: the same exchange's
      // candles, checked for gaps like the chart's own.
      loadSeries: async (request) => {
        const window = seriesWindow(request);
        const plan = seriesSourcePlan(request.timeframeMs);
        const sourceCandles = (window.endExclusive - window.startInclusive) / BACKTEST_TIMEFRAME_MS[plan.interval];
        if (sourceCandles > MAX_SERIES_REQUEST_CANDLES) {
          throw new SeriesRequestError(`request.security on ${request.timeframe} needs ${sourceCandles.toLocaleString('en-US')} ${plan.interval} candles; the limit is ${MAX_SERIES_REQUEST_CANDLES.toLocaleString('en-US')}. Shorten the period.`);
        }
        const loaded = await historicalProvider.getCandles({
          symbol, interval: plan.interval, ...window, signal: abortController.signal,
        });
        if (loaded.provenance.venue !== expectedVenue || loaded.provenance.symbol !== symbol) {
          throw new SeriesRequestError('The candle source for request.security does not match the selected market.');
        }
        const candles = aggregateCandles(loaded.candles, request.timeframeMs, plan.factor);
        assertCompleteSeries(candles, window, request.timeframeMs);
        seriesNotes.push(bilingualMessage(
          `request.security: ${candles.length} closed ${request.timeframe} candles of Binance Futures ${symbol}${plan.factor > 1 ? `, built from ${plan.interval}` : ''}, ${new Date(window.startInclusive).toISOString().slice(0, 10)} to ${new Date(window.endExclusive).toISOString().slice(0, 10)}.`,
          `request.security: ${candles.length} закрытых свечей ${request.timeframe} Binance Futures ${symbol}${plan.factor > 1 ? `, собранных из ${plan.interval}` : ''}, с ${new Date(window.startInclusive).toISOString().slice(0, 10)} по ${new Date(window.endExclusive).toISOString().slice(0, 10)}.`,
        ));
        // A higher-timeframe bar still open at the chart's end is built from the chart's
        // own candles only, so no later price reaches the script.
        if (window.endExclusive < request.endExclusive && request.timeframeMs % intervalMs === 0) {
          const tail = selected.candles.filter((candle) => candle.openTime >= window.endExclusive && candle.openTime < request.endExclusive);
          candles.push(...aggregateCandles(tail, request.timeframeMs, request.timeframeMs / intervalMs, { allowSparse: true }));
        }
        return candles;
      },
    });

    if (!workerResult.ok) {
      finished = true;
      return reply.code(422).send({
        error: workerResult.error.kind === 'compile'
          ? prefixedMessage('The Pine code has a mistake.', 'В коде Pine ошибка.', workerResult.error.message)
          : prefixedMessage('The Pine strategy failed.', 'Ошибка выполнения Pine-стратегии.', workerResult.error.message),
        kind: workerResult.error.kind,
      });
    }

    const response: BacktestResponse = {
      runId: randomUUID(),
      runtime: { name: 'PineTS', version: PINETS_VERSION, isolatedProcess: true },
      data: {
        provider: parentResult.provenance.provider,
        venue: parentResult.provenance.venue,
        marketType: 'perpetual',
        symbol,
        tradingViewTicker: tradingViewTicker(parsed.data.exchange, symbol),
        timeframe: parsed.data.timeframe,
        bars: selected.candles.length,
        firstBar: new Date(selected.candles[0]!.openTime).toISOString(),
        lastBar: new Date(selected.candles.at(-1)!.openTime).toISOString(),
        missingBars,
        fetchedPages: parentResult.provenance.pages,
        rawRows: parentResult.provenance.rawRows,
        sha256: candlesSha256(selected.candles),
        recovery: parentResult.provenance.recovery ?? null,
        barIndexOffset: parsed.data.barIndexOffset,
        instrument: {
          sizeDecimals: instrument.szDecimals,
          mintick: precision.mintick,
          minContract: precision.minContract,
          maxLeverage: instrument.maxLeverage,
          mintickModel: parsed.data.exchange === 'Binance'
            ? 'binance-futures-price-filter-v1'
            : 'hyperliquid-minimum-increment-v1',
        },
        intrabar: highDetailization && minuteResult ? {
          source: parsed.data.exchange === 'Binance'
            ? 'Binance Futures candles'
            : '0xArchive Hyperliquid candles',
          sourceTimeframe: '1m',
          replayTimeframe: '1m',
          bars1m: highDetailization.metadata.source.rows,
          replayBars: highDetailization.metadata.aggregate.bars,
          replayTicks: highDetailization.metadata.aggregate.ticks,
          missingBars1m: highDetailization.metadata.source.missingTimestamps.length,
          sourceSha256: highDetailization.metadata.source.sha256,
          aggregateSha256: highDetailization.metadata.aggregate.sha256,
          fetchedPages: minuteResult.provenance.pages,
          recovery: minuteResult.provenance.recovery ?? null,
        } : null,
      },
      configuration: {
        dateRange: parsed.data.dateRange,
        initialCapital: parsed.data.initialCapital,
        baseCurrency: parsed.data.baseCurrency,
        defaultOrderSizeValue: workerResult.execution.defaultOrderSizeValue,
        defaultOrderSizeType: workerResult.execution.defaultOrderSizeType,
        pyramiding: workerResult.execution.pyramiding,
        feeModel: parsed.data.feeModel,
        feeSchedule: venueFeeSchedule,
        liquidityAssumption: venueFeeSchedule ? 'all_taker' : 'uniform_manual',
        commissionType: workerResult.execution.commissionType,
        commissionValue: workerResult.execution.commissionValue,
        pineVersion: workerResult.execution.pineVersion,
        marginLongPercent: workerResult.execution.marginLongPercent,
        marginShortPercent: workerResult.execution.marginShortPercent,
        slippageTicks: workerResult.execution.slippageTicks,
        barDetailization: parsed.data.barDetailization,
        executionModelVersion: highDetailization ? 'minute-replay-v1' : 'default-v2',
        chartTimeframe: parsed.data.timeframe,
        scriptExecution: ['on_bar_close'],
        orderExecutionDelay: 'one_tick',
        calcOnOrderFills: parsed.data.calcOnOrderFills,
        calcOnEveryTick: parsed.data.calcOnEveryTick,
        calcOnEveryHistoryTick: parsed.data.calcOnEveryHistoryTick,
        limitOrderVerificationTicks: parsed.data.limitOrderVerificationTicks,
        processOrdersOnClose: workerResult.execution.processOrdersOnClose,
        timezone: 'UTC',
      },
      metrics: workerResult.metrics,
      trades: workerResult.trades,
      chart: { candles: chartCandles(selected.candles) },
      comparison: {
        status: 'NOT_APPLICABLE',
        reference: null,
        mismatchCount: 0,
        details: [
          bilingualMessage(
            'Matching individual Binance candles to a TradingView chart does not prove that every trade or strategy result will match.',
            'Совпадение отдельных свечей Binance с графиком TradingView не доказывает совпадения всех сделок или результатов стратегии.',
          ),
        ],
      },
      durationMs: Math.round(performance.now() - started),
      warnings: [
        ...seriesNotes,
        bilingualMessage(
          'No gaps were found in the parent candles used; missing data is never replaced with synthetic candles.',
          'В использованных родительских свечах нет пропусков; пропуски не заменяются искусственными данными.',
        ),
        ...(completeParentEndExclusive < endExclusive
          ? [bilingualMessage(
              `The selected period is not complete yet: only closed candles through ${new Date(completeParentEndExclusive).toISOString()} UTC were used. The remaining part was excluded.`,
              `Выбранный период ещё не завершён: учтены только закрытые свечи до ${new Date(completeParentEndExclusive).toISOString()} UTC. Остальная часть периода не вошла в результат.`,
            )]
          : []),
        ...(selected.excludedIncomplete > 0
          ? [bilingualMessage(
              `Open candles excluded: ${selected.excludedIncomplete}.`,
              `Исключено незакрытых свечей: ${selected.excludedIncomplete}.`,
            )]
          : []),
        ...(highDetailization
          ? [
              bilingualMessage(
                `Pine calculated on ${parsed.data.timeframe}; every order was checked against every one-minute candle inside the parent candle.`,
                `Pine рассчитан на ${parsed.data.timeframe}; исполнение каждой заявки проверено по каждой минутной свече внутри родительской свечи.`,
              ),
              bilingualMessage(
                'Inside each minute, the price path remains a deterministic four-point OHLC model.',
                'Внутри самой минуты путь цены остаётся детерминированной моделью OHLC из четырёх точек.',
              ),
            ]
          : parsed.data.timeframe === '1m'
            ? [
                bilingualMessage(
                  'No sub-minute candles are available on the 1m timeframe; the minute uses a deterministic four-point OHLC path.',
                  'На таймфрейме 1m нет доступных субминутных свечей: внутри минуты используется детерминированный путь OHLC из четырёх точек.',
                ),
              ]
            : [
                bilingualMessage(
                  `Bar detail: 4 points per ${parsed.data.timeframe} candle, as TradingView's Default without Bar Magnifier. Inside the candle price moves open → nearer extreme → farther extreme → close; minute candles were not used.`,
                  `Детализация: 4 точки на свечу ${parsed.data.timeframe}, как Default в TradingView без Bar Magnifier. Внутри свечи цена идёт: открытие → ближний экстремум → дальний → закрытие; минутные свечи не использовались.`,
                ),
              ]),
        parsed.data.exchange === 'Binance'
          ? bilingualMessage(
              `Pine syminfo.mintick = ${precision.mintick} and syminfo.mincontract = ${precision.minContract} from Binance Futures filters.`,
              `Pine syminfo.mintick = ${precision.mintick}, syminfo.mincontract = ${precision.minContract} по фильтрам Binance Futures.`,
            )
          : bilingualMessage(
              `Static Pine syminfo.mintick = 10^-(6 - szDecimals) = ${precision.mintick}. Hyperliquid's five-significant-digit rule is a separate future live-order validation rule.`,
              `Статический Pine syminfo.mintick = 10^-(6 - szDecimals) = ${precision.mintick}. Ограничение Hyperliquid в 5 значащих цифр — отдельное правило валидности будущих live-заявок.`,
            ),
        bilingualMessage(
          'A manual TradingView comparison validates only one specific script, market, configuration, and period—not universal compatibility.',
          'Ручная сверка с TradingView проверяет только конкретный скрипт, рынок, настройки и период, а не универсальную совместимость.',
        ),
        ...(parsed.data.exchange === 'Binance'
          ? [bilingualMessage(
              'Binance Futures candles can differ from future Hyperliquid or Lighter prices, funding, and execution.',
              'Свечи Binance Futures могут отличаться от цен, фандинга и исполнения будущей торговли на Hyperliquid или Lighter.',
            )]
          : []),
        bilingualMessage(
          'A backtest result is not proof of future profitability.',
          'Результат бэктеста не является доказательством будущей прибыльности.',
        ),
        ...(parsed.data.barIndexOffset > 0
          ? [bilingualMessage(
              `Explicit bar_index offset applied: ${parsed.data.barIndexOffset}.`,
              `Применено явное смещение bar_index: ${parsed.data.barIndexOffset}.`,
            )]
          : []),
        ...(workerResult.execution.legacyMarginDefaultsApplied
          ? [bilingualMessage(
              'The TradingView-compatible 0% margin default (unlimited leverage) was applied for Pine v5.',
              'Для Pine v5 применена совместимая с TradingView маржа 0% (бесконечное плечо).',
            )]
          : []),
        ...(venueFeeSchedule
          ? [
              bilingualMessage(
                `Fee assumption: Hyperliquid base-tier taker ${effectiveCommissionValue}% per fill; maker ${feeRateFractionToPercent(venueFeeSchedule.makerFeeRate)}% is shown only as a reference.`,
                `Допущение по комиссии: Hyperliquid base tier taker ${effectiveCommissionValue}% на каждое исполнение; maker ${feeRateFractionToPercent(venueFeeSchedule.makerFeeRate)}% показан только как справочная ставка.`,
              ),
              bilingualMessage(
                'Candles do not prove queue position, so the backtest conservatively treats every fill as taker and does not inflate profit with a maker assumption.',
                'Свечи не доказывают положение заявки в очереди, поэтому бэктест консервативно считает все исполнения taker и не завышает прибыль maker-допущением.',
              ),
              bilingualMessage(
                `Schedule ${venueFeeSchedule.scheduleId} is a fixed assumption; it does not prove a historical or account-specific fee tier.`,
                `Тариф ${venueFeeSchedule.scheduleId} является зафиксированным допущением; он не доказывает исторический или персональный тариф аккаунта.`,
              ),
            ]
          : [bilingualMessage(
              'The single commission entered by the user was applied; maker and taker are not distinguished.',
              'Использована единая ручная комиссия пользователя; maker/taker не различаются.',
            )]),
      ],
    };
    finished = true;
    return reply.send(response);
    } finally {
      finished = true;
      activeBacktest = false;
    }
  });

  const webRoot = path.join(projectRoot, 'dist', 'web');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: bilingualMessage('Not found.', 'Не найдено.') });
      }
      return reply.sendFile('index.html');
    });
  }
  return app;
}

export function isMainEntrypoint(moduleUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
}

const isMain = isMainEntrypoint(import.meta.url, process.argv[1]);
if (isMain) {
  const app = await buildApp();
  await app.listen({
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 8787),
  });
  let closing = false;
  const closeOnSignal = (): void => {
    if (closing) return;
    closing = true;
    void app.close().then(
      () => { process.exitCode = 0; },
      (error) => {
        app.log.error({ err: error }, 'Paper shutdown was not proven before process exit');
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGINT', closeOnSignal);
  process.once('SIGTERM', closeOnSignal);
}
