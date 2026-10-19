/**
 * Generic Pine Paper: any saved Pine strategy on any Lighter / Hyperliquid
 * USDC perpetuals (up to MAX_MARKETS_PER_VENUE per venue).
 *
 * - Pine evaluates each closed bar of the venue's own candles in an isolated
 *   worker (packages/pine-runtime/src/live-engine.ts). History before the
 *   start only warms the strategy; from the start on Pine sees real fills only.
 * - Its pending orders and open trades go to the Nautilus child, which
 *   executes them in real time against live order books (pine_orders.py) and
 *   reports every executed Pine order back; the next re-run includes it.
 * - The backtest is never consulted. The run starts flat: Pine trades opened
 *   before the start are mirrored without real size.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BACKTEST_TIMEFRAME_MS, PINE_TIMEFRAME, type Candle } from '../../../../packages/shared/src/contracts.js';
import type { PaperExperimentRuntimeView } from '../../../../packages/shared/src/paper-experiment-contracts.js';
import {
  MAX_MARKETS_PER_RUN, MAX_MARKETS_PER_VENUE, PYTHON_STRATEGY_SOURCE_PREFIX,
  type PineLivePaperSettingsV1,
  type PythonLivePaperSettingsV1,
} from '../../../../packages/shared/src/strategy-catalog-contracts.js';
import type { PineLiveExecutionSettings, PineLiveFill, PineLiveRunResult } from '../../../../packages/pine-runtime/src/live-engine.js';
import { StrategyCatalogV1 } from '../strategy-catalog.js';
import type { PaperExperimentRuntimeFactory, PaperExperimentStopProof, PaperTrackUpdate } from './paper-experiment-controller.js';
import type { PaperExperimentSnapshot } from './paper-experiment-store.js';
import { NautilusPaperLedger, type NautilusPaperMessageV1 } from './nautilus-paper-ledger.js';
import {
  NAUTILUS_FAST_PAPER_VERSION, NAUTILUS_PAPER_VERSION, assertNoLiveNautilusProcess, checkNautilusRuntime, isFatalNautilusLogLine, ownedNautilusRuns,
} from './nautilus-process.js';
import { aggregateCandles, seriesSourcePlan, seriesWindow, type SeriesRequest } from '../../../../packages/pine-runtime/src/series-requests.js';
import { PineLiveClient } from './pine-live-client.js';
import { fetchClosedCandles, fetchVenueCatalog, pineMintick, type PaperVenueKey, type VenueMarket } from './venue-markets.js';

type StopProof = Extract<PaperExperimentStopProof, { outcome: 'interrupted' }>;
type Proposed = Parameters<PaperExperimentRuntimeFactory['preflight']>[0];

/** Closed bars of history Pine evaluates before the Paper start. */
export const PINE_LIVE_HISTORY_BARS = 1_500;
/** Python strategies declare their own warm-up; bounded by the 1 MiB command limit. */
const PYTHON_MAX_WARMUP_BARS = 3_000;

type LiveSettings = PineLivePaperSettingsV1 | PythonLivePaperSettingsV1;

/** One Python strategy of a configured pack, as reported by list_strategies.py. */
export interface PythonStrategyInfo {
  readonly id: string;
  readonly pack: string;
  readonly builtin: boolean;
  readonly packSha256: string;
  readonly name: string;
  readonly description: string;
  readonly timeframe: string;
  readonly warmupBars: number;
  readonly pyramiding: number;
  readonly maxPositionsPerVenue?: number | null;
  readonly params: Record<string, { type: string; default: unknown; min: number | null; max: number | null;
    choices: unknown[] | null; label: string; help: string }>;
}

/** Strategies of every configured private pack. */
export async function listPythonStrategies(python: string, projectRoot: string, packs: readonly string[]):
  Promise<{ strategies: PythonStrategyInfo[]; errors: { pack: string; module: string; error: string }[] }> {
  const script = path.join(projectRoot, 'apps/nautilus-paper/list_strategies.py');
  const { stdout } = await promisify(execFile)(python, [script, ...packs.flatMap(pack => ['--pack', pack])],
    { cwd: projectRoot, env: { PATH: process.env.PATH, PYTHONUNBUFFERED: '1' }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}
/**
 * A venue candle is read this long after its bar closed. Measured from Tokyo on 2026-10-10:
 * Hyperliquid's REST candle was final 0.3 s after the close, Lighter's 0.6 s. Each later read
 * re-checks the previous candle and logs a revision (`candleRevised`).
 */
export const SETTLE_MS: Record<PaperVenueKey, number> = { hyperliquid: 500, lighter: 1_000 };
/** How often the run checks for a closed bar. */
const BOUNDARY_TICK_MS = 250;
/** Without a new candle (no trades) the previous orders are re-confirmed after this. */
const NO_CANDLE_RELEASE_MS = 20_000;
/**
 * A Live stop closes positions at market, re-sending the rest for up to 30 s, then the node
 * stops (up to 20 s): the process is never killed while it is still closing real positions.
 */
const LIVE_STOP_GRACE_MS = 75_000;

export interface PinePaperFactoryOptions {
  readonly projectRoot: string;
  readonly catalogDir: string;
  readonly runtimeDir: string;
  readonly pythonPath?: string;
  readonly hyperliquidFastBook?: boolean;
  /** Absolute paths of private strategy packs (PSR_STRATEGY_PACKS). */
  readonly strategyPacks?: readonly string[];
  /** Live trading with real money is switched on and a key is saved on this machine. */
  readonly liveTrading?: boolean | (() => boolean);
  /** Folder with the Lighter credentials file the engine reads. */
  readonly liveSecretsDir?: string;
  readonly dependencies?: {
    readonly listStrategies?: () => Promise<{ strategies: PythonStrategyInfo[] }>;
    readonly catalog?: (venue: PaperVenueKey, signal: AbortSignal) => Promise<VenueMarket[]>;
    readonly candles?: (market: VenueMarket, settings: LiveSettings, fromMs: number, toMs: number,
      signal: AbortSignal) => Promise<Candle[]>;
    readonly spawn?: (configPath: string) => ChildProcessWithoutNullStreams;
    readonly checkRuntime?: () => Promise<void>;
    readonly now?: () => number;
    readonly stopGraceMs?: number;
  };
}

interface Track {
  readonly key: string; // python track key
  readonly venue: PaperVenueKey;
  readonly display: 'Lighter' | 'Hyperliquid';
  readonly market: VenueMarket;
  readonly mintick: number;
  lastOpenTime: number;
  /** The last candle given to the strategy, re-checked against the venue on the next read. */
  lastCandle: Candle | null;
  /** Bars evaluated by Pine; the last one closed at this exclusive time. */
  barCloseMs: number;
  /** Python reports not yet handed to the Pine worker. */
  newFills: Array<PineLiveFill & { seq: number }>;
  /** Highest Python report sequence included in a Pine re-run, per fill time. */
  sentFills: Array<{ seq: number; time: number }>;
  lastResult: PineLiveRunResult | null;
  busy: boolean;
  boundaryWaitSince: number | null;
  lastDataErrorAt: number;
}

interface Actor {
  snapshot: PaperExperimentSnapshot;
  settings: LiveSettings;
  /** Present for Python strategies: their bars go to the Nautilus child, not to Pine. */
  python: PythonStrategyInfo | null;
  directory: string;
  ledger: NautilusPaperLedger;
  report: (id: string, update: PaperTrackUpdate) => void;
  abort: AbortController;
  child: ChildProcessWithoutNullStreams | null;
  childExit: Promise<void> | null;
  exited: boolean;
  pine: PineLiveClient | null;
  tracks: Track[];
  startMs: number;
  task: Promise<void> | null;
  loop: Promise<void> | null;
  timer: ReturnType<typeof setInterval> | null;
  stopPromise: Promise<StopProof> | null;
  stopping: boolean;
  failure: string | null;
  /** Why an orderly stop was asked for when it is not the owner's Stop (a server shutdown). */
  stopReason?: string;
  /** The engine's own final stop reason (a Live run ends it with the closes' outcome). */
  engineStopReason: string | null;
  seq: number;
  childSeq: number;
  logBytes: number;
  view: PaperExperimentRuntimeView;
  lastMessageAt: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1600);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Venue candle (inclusive close) -> SDK bar (exclusive close). */
const pythonBar = (candle: Candle) => ({ openTime: candle.openTime, closeTime: candle.closeTime + 1, open: candle.open,
  high: candle.high, low: candle.low, close: candle.close, volume: candle.volume });
const pythonTrackKey = (venue: PaperVenueKey, market: string) => (market === 'HYPE' ? venue : `${venue}:${market}`);

/** A note when the venue's later copy of a candle differs from the one a strategy already used. */
export function candleRevisionMessage(seen: Candle, later: Candle): string | null {
  const revised = (['open', 'high', 'low', 'close'] as const).filter(field => seen[field] !== later[field]);
  if (!revised.length) return null;
  return `Candle ${new Date(seen.openTime).toISOString()} was revised by the venue after the strategy used it: `
    + `${revised.map(field => `${field} ${seen[field]} -> ${later[field]}`).join('; ')}.`;
}

/**
 * Final reason of a Live run: why it stopped, then the engine's own outcome of the closes ("every
 * position of this run is closed" or which positions are still open). Without that outcome (the
 * engine had to be ended) the owner is told to check the Lighter app.
 */
export function liveStopReason(failure: string | null, engineStopReason: string | null): string {
  const outcome = engineStopReason?.match(/LIVE: (every position of this run is closed|positions still open)[^]*$/)?.[0]
    ?? 'LIVE: the engine did not confirm how the closes ended; check the positions in the Lighter app.';
  const base = failure ?? 'Stopped by user.';
  return base.includes(outcome) ? base : `${base} ${outcome}`;
}

export function isPineLiveSettings(settings: Proposed['settings']): settings is Proposed['settings'] & PineLivePaperSettingsV1 {
  return settings.accountModel === 'pine_live_v1';
}

export function isLiveSettings(settings: Proposed['settings']): settings is Proposed['settings'] & LiveSettings {
  return settings.accountModel === 'pine_live_v1' || settings.accountModel === 'python_live_v1';
}

function assertInput(input: Proposed): LiveSettings {
  const settings = input.settings;
  if (!isLiveSettings(settings)) throw new Error('Live Paper requires Pine or Python live settings.');
  if (sha256(input.source) !== input.sourceSha256) throw new Error('Saved strategy source hash differs.');
  if (settings.accountModel === 'python_live_v1' && input.source !== `${PYTHON_STRATEGY_SOURCE_PREFIX}${settings.strategyRef}`) {
    throw new Error('Saved Python strategy reference differs from its Paper settings.');
  }
  if (settings.tracks.length < 1) throw new Error('Choose at least one market.');
  for (const venue of ['Lighter', 'Hyperliquid'] as const) {
    if (settings.tracks.filter(track => track.venue === venue).length > MAX_MARKETS_PER_VENUE) {
      throw new Error(`Choose no more than ${MAX_MARKETS_PER_VENUE} ${venue} markets.`);
    }
  }
  for (const fee of [settings.lighterMakerFeePercent, settings.lighterTakerFeePercent,
    settings.hyperliquidMakerFeePercent, settings.hyperliquidTakerFeePercent]) {
    if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0 || fee > 100) throw new Error('Enter explicit maker and taker fees for both venues.');
  }
  return settings;
}

function executionSettings(backtest: Record<string, unknown> | undefined, settings: LiveSettings,
  venue: PaperVenueKey): PineLiveExecutionSettings {
  const value = (name: string) => backtest?.[name];
  const venueDefault = value('feeModel') === 'venue_default_all_taker_v1';
  return {
    initialCapital: Number(value('initialCapital') ?? 10_000),
    defaultOrderSizeValue: Number(value('defaultOrderSizeValue') ?? 100),
    defaultOrderSizeType: (value('defaultOrderSizeType') ?? 'percent_of_equity') as PineLiveExecutionSettings['defaultOrderSizeType'],
    pyramiding: Number(value('pyramiding') ?? 1),
    commissionType: venueDefault ? 'percent' : (value('commissionType') ?? 'percent') as PineLiveExecutionSettings['commissionType'],
    commissionValue: venueDefault
      ? (venue === 'lighter' ? settings.lighterTakerFeePercent : settings.hyperliquidTakerFeePercent) ?? 0
      : Number(value('commissionValue') ?? 0),
    ...(typeof value('marginLongPercent') === 'number' ? { marginLongPercent: value('marginLongPercent') as number } : {}),
    ...(typeof value('marginShortPercent') === 'number' ? { marginShortPercent: value('marginShortPercent') as number } : {}),
  };
}

export function createPinePaperFactory(options: PinePaperFactoryOptions): PaperExperimentRuntimeFactory {
  const actors = new Map<string, Actor>();
  const python = options.pythonPath ?? path.join(options.projectRoot, '.local/nautilus-hl-fast5-rc7-20261018/.venv/bin/python');
  const hyperliquidFastBook = options.hyperliquidFastBook === true;
  const version = hyperliquidFastBook ? NAUTILUS_FAST_PAPER_VERSION : NAUTILUS_PAPER_VERSION;
  const script = path.join(options.projectRoot, 'apps/nautilus-paper/runtime.py');
  const now = options.dependencies?.now ?? Date.now;
  const packs = options.strategyPacks ?? [];
  const listStrategies = options.dependencies?.listStrategies ?? (() => listPythonStrategies(python, options.projectRoot, packs));
  async function pythonStrategy(ref: string): Promise<PythonStrategyInfo> {
    const found = (await listStrategies()).strategies.find(row => row.id === ref);
    if (!found) throw new Error(`Python strategy ${ref} is not available in the configured strategy packs.`);
    return found;
  }
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1' };
  // A Live run's engine reads the Lighter key itself from the closed server file.
  const liveSecretsDir = options.liveSecretsDir ?? process.env.PSR_LIVE_SECRETS_DIR;
  const liveEnv = { ...env, PSR_LIVE_ENABLED: '1', ...(liveSecretsDir ? { PSR_LIVE_SECRETS_DIR: liveSecretsDir } : {}) };
  const liveAllowed = () => (typeof options.liveTrading === 'function' ? options.liveTrading() : options.liveTrading === true);
  function assertLive(settings: LiveSettings): void {
    if (!settings.live) return;
    if (!liveAllowed()) throw new Error('Live trading is not enabled on this engine.');
    if (settings.tracks.some(track => track.venue !== 'Lighter')) throw new Error('Live trading supports Lighter markets only.');
  }
  const catalogFor = options.dependencies?.catalog ?? ((venue, signal) => fetchVenueCatalog(venue, { signal }));
  const candlesFor = options.dependencies?.candles
    ?? ((market, settings, fromMs, toMs, signal) => fetchClosedCandles(market, settings.timeframe, fromMs, toMs, { signal, now }));

  function record(actor: Actor, body: Record<string, unknown>): void {
    const envelope = { ...body, v: 1, seq: actor.seq + 1, at: new Date().toISOString(), runId: actor.snapshot.experimentId };
    actor.ledger.append(envelope as NautilusPaperMessageV1);
    actor.seq++;
  }
  function notify(actor: Actor, update: PaperTrackUpdate): void {
    for (const track of actor.snapshot.tracks) actor.report(track.trackId, update);
  }
  function fail(actor: Actor, reason: string): void {
    if (!actor.failure) {
      actor.failure = reason;
      try { record(actor, { type: 'failure', message: reason }); }
      catch (error) { actor.failure += `; event journal failed: ${message(error)}`; }
    }
    void stop(actor).catch(() => undefined);
    try { notify(actor, { status: 'interrupted', reason: actor.failure }); } catch { /* stop continues */ }
  }
  function owner(actor: Actor): void {
    writeFileSync(path.join(actor.directory, 'nautilus-owner.json'), JSON.stringify({
      experimentId: actor.snapshot.experimentId, parentPid: process.pid,
      childPid: actor.child?.pid ?? null, exited: actor.exited, updatedAt: new Date().toISOString(),
    }) + '\n', { mode: 0o600 });
  }
  function writeChild(actor: Actor, data: object): void {
    if (!actor.child || actor.exited || !actor.child.stdin.writable) throw new Error('Nautilus command channel is closed.');
    const line = JSON.stringify(data) + '\n';
    if (Buffer.byteLength(line) > 1_000_000) throw new Error('Pine order set exceeds the 1 MB command limit.');
    actor.child.stdin.write(line);
  }
  async function waitExit(actor: Actor, ms: number): Promise<boolean> {
    if (!actor.childExit || actor.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([actor.childExit.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  function stop(actor: Actor, reason?: string): Promise<StopProof> {
    if (reason) actor.stopReason ??= reason;
    if (actor.stopPromise) return actor.stopPromise;
    actor.stopping = true;
    actor.view = { ...actor.view, stage: 'stopping' };
    actor.abort.abort();
    if (actor.timer) clearInterval(actor.timer);
    actor.stopPromise = (async () => {
      try {
        record(actor, { type: 'phase', stage: 'stopping', message: actor.failure ?? `${actor.stopReason ?? 'Stop requested;'} ${actor.settings.live
          ? 'LIVE: closing every position on Lighter at market.' : 'Closing both virtual accounts.'}` });
      } catch { /* still stop */ }
      await Promise.race([Promise.allSettled([actor.task, actor.loop]), new Promise(resolve => setTimeout(resolve, 3_000))]);
      actor.pine?.close();
      if (actor.child && !actor.exited) {
        try { writeChild(actor, { cmd: 'stop', reason: actor.failure ?? 'user' }); } catch { /* escalate below */ }
        if (!await waitExit(actor, options.dependencies?.stopGraceMs ?? (actor.settings.live ? LIVE_STOP_GRACE_MS : 10_000))) {
          actor.failure ??= 'Nautilus did not acknowledge Stop; its process was terminated.';
          actor.child.kill('SIGTERM');
          if (!await waitExit(actor, 3_000)) {
            actor.child.kill('SIGKILL');
            if (!await waitExit(actor, 3_000)) throw new Error('Nautilus process exit is not proven; Paper slot remains occupied.');
          }
        }
      }
      let reason = actor.settings.live
        ? liveStopReason(actor.failure ?? actor.stopReason ?? null, actor.engineStopReason)
        : actor.failure ?? actor.stopReason ?? 'Stopped by user. Any open virtual positions remain in the audit snapshot; no automatic liquidation or resume.';
      try { record(actor, { type: 'stopped', reason }); }
      catch (error) { reason += `; could not write final event: ${message(error)}`; }
      owner(actor);
      actor.ledger.close();
      actors.delete(actor.snapshot.experimentId);
      ownedNautilusRuns.delete(actor.snapshot.experimentId);
      return { outcome: 'interrupted', controlSlotReleaseProven: true, finalVenueDrainProven: false, reason };
    })();
    void actor.stopPromise.catch(() => { actor.stopPromise = null; });
    return actor.stopPromise;
  }

  function trackOf(actor: Actor, venue: unknown, market: unknown): Track | undefined {
    return actor.tracks.find(track => track.display === venue && track.market.market === market);
  }

  function accept(actor: Actor, line: string): void {
    if (!line.startsWith('PSR_EVENT=')) {
      if (isFatalNautilusLogLine(line, Boolean(actor.settings.live))) fail(actor, `Nautilus runtime error: ${line.slice(0, 800)}`);
      return;
    }
    const raw = JSON.parse(line.slice('PSR_EVENT='.length)) as Record<string, unknown>;
    if (raw.v !== 1 || raw.seq !== actor.childSeq + 1 || raw.runId !== actor.snapshot.experimentId) throw new Error('Nautilus event sequence or run binding is invalid.');
    actor.childSeq++;
    actor.lastMessageAt = now();
    actor.ledger.append({ ...raw, sourceSeq: raw.seq, seq: actor.seq + 1 } as NautilusPaperMessageV1);
    actor.seq++;
    if (raw.type === 'pine_fill') {
      const track = trackOf(actor, raw.venue, raw.market);
      if (!track) throw new Error('Pine fill for an unselected market.');
      track.newFills.push({
        seq: raw.reportSeq as number, orderId: raw.orderId as string, category: raw.category as 'entry' | 'exit',
        price: Number(raw.price), time: raw.time as number, leg: raw.leg as PineLiveFill['leg'],
        ...(typeof raw.qty === 'string' ? { qty: Number(raw.qty) } : {}),
        ...(typeof raw.tradeKey === 'string' ? { tradeKey: raw.tradeKey } : {}),
      });
    } else if (raw.type === 'snapshot') {
      actor.view = actor.ledger.snapshot()!;
      if (!actor.stopping) {
        for (const track of actor.snapshot.tracks) {
          const observed = actor.view.tracks?.find(row => row.venue === track.venue && row.market === track.market);
          actor.report(track.trackId, { status: actor.view.stage, ...(observed ? { events: observed.publicFrames,
            signals: observed.signals, intents: observed.intents, fills: observed.fills } : {}) });
        }
      }
    } else if (raw.type === 'phase' && (raw.stage === 'recovering' || raw.stage === 'running') && !actor.stopping) {
      actor.view = { ...actor.view, stage: raw.stage };
      notify(actor, { status: raw.stage });
    } else if (raw.type === 'failure') {
      fail(actor, typeof raw.message === 'string' ? raw.message : 'Nautilus reported an error.');
    } else if (raw.type === 'stopped') {
      if (typeof raw.reason === 'string') actor.engineStopReason = raw.reason;
      if (!actor.stopping) fail(actor, typeof raw.reason === 'string' ? raw.reason : 'Nautilus stopped unexpectedly.');
    }
  }

  function attach(actor: Actor, child: ChildProcessWithoutNullStreams): void {
    actor.child = child;
    actor.childExit = new Promise(resolve => {
      child.once('close', (code, signal) => {
        actor.exited = true;
        try { owner(actor); } catch { /* ledger below records failure */ }
        resolve();
        if (!actor.stopping) fail(actor, `Nautilus process exited unexpectedly (code ${code}, signal ${signal}).`);
      });
    });
    child.on('error', error => fail(actor, `Nautilus process error: ${message(error)}`));
    child.stdin.on('error', error => { if (!actor.stopping) fail(actor, `Nautilus input error: ${message(error)}`); });
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        try {
          actor.logBytes += Buffer.byteLength(chunk);
          if (actor.logBytes > 1024 * 1024 * 1024) throw new Error('Nautilus log reached the 1 GiB per-run limit.');
          appendFileSync(path.join(actor.directory, 'nautilus.log'), chunk, { mode: 0o600 });
          pending += chunk;
          if (pending.length > 1024 * 1024) throw new Error('Nautilus emitted an oversized log line.');
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, '');
            pending = pending.slice(newline + 1);
            accept(actor, line);
          }
        } catch (error) { fail(actor, message(error)); }
      });
      stream.on('end', () => { if (pending.trim() && !actor.stopping) fail(actor, 'Nautilus output ended with an incomplete event/log line.'); });
    }
    owner(actor);
  }

  /** Orders Python may execute. Market entries decided before the start are not opened late. */
  function orderSet(actor: Actor, track: Track, result: PineLiveRunResult, fillsThrough: number) {
    const frameMs = BACKTEST_TIMEFRAME_MS[actor.settings.timeframe];
    const orders = result.orders.filter(order => !(order.category === 'entry' && order.type === 'market'
      && order.placedTime + frameMs <= actor.startMs));
    return { cmd: 'pine_orders', venue: track.venue, market: track.market.market, barCloseMs: result.barCloseMs,
      fillsThrough, orders, trades: result.trades };
  }

  async function evaluate(actor: Actor, track: Track, append: Candle[]): Promise<void> {
    if (actor.python) {
      // A Python strategy decides inside the Nautilus process; it just receives the closed bars.
      writeChild(actor, { cmd: 'bar', venue: track.venue, market: track.market.market, bars: append.map(pythonBar) });
      track.barCloseMs = append.at(-1)!.closeTime + 1;
      return;
    }
    const fills = track.newFills.splice(0);
    const { result, durationMs } = await actor.pine!.run(track.key, append, fills.map(({ seq: _seq, ...fill }) => fill));
    if (actor.stopping) return;
    track.sentFills.push(...fills.map(fill => ({ seq: fill.seq, time: fill.time })));
    // Pine has seen every fill executed before the bar it just closed.
    const fillsThrough = track.sentFills.filter(fill => fill.time < result.barCloseMs).reduce((max, fill) => Math.max(max, fill.seq), 0);
    track.sentFills = track.sentFills.filter(fill => fill.time >= result.barCloseMs || fill.seq === fillsThrough);
    for (const outcome of result.fillOutcomes) {
      if (outcome.applied || outcome.reason === 'after_last_bar') continue;
      if (!fills.some(fill => fill.time === outcome.fill.time && fill.orderId === outcome.fill.orderId)) continue;
      record(actor, { type: 'event', venue: track.display, market: track.market.market,
        message: `Pine did not book real fill of "${outcome.fill.orderId}" (${outcome.reason}); its real quantity will be reconciled.` });
    }
    track.lastResult = result;
    track.barCloseMs = result.barCloseMs;
    writeChild(actor, orderSet(actor, track, result, fillsThrough));
    const side = result.positionSize > 0 ? 'long' : result.positionSize < 0 ? 'short' : 'flat';
    record(actor, { type: 'pine_bar', venue: track.display, market: track.market.market, barCloseMs: result.barCloseMs,
      orders: result.orders.length, openTrades: result.trades.length, positionSize: result.positionSize,
      closedTrades: result.closedTradesSinceStart, netProfit: Number(result.netProfitSinceStart.toFixed(8)), durationMs,
      message: `Pine closed bar ${new Date(result.barCloseMs).toISOString()}: Pine position ${side}`
        + `${result.positionSize ? ` ${Math.abs(result.positionSize)}` : ''}, ${result.orders.length} working order(s)`
        + `${result.unsupported.length ? `; unsupported: ${result.unsupported.join('; ')}` : ''}.` });
  }

  async function onBoundary(actor: Actor): Promise<void> {
    // Venues have separate public rate limits: update them concurrently.
    const venues = [...new Set(actor.tracks.map(track => track.venue))];
    await Promise.all(venues.map(venue => onVenueBoundary(actor, actor.tracks.filter(track => track.venue === venue))));
  }

  async function onVenueBoundary(actor: Actor, tracks: Track[]): Promise<void> {
    const frameMs = BACKTEST_TIMEFRAME_MS[actor.settings.timeframe];
    const t = now();
    // Latest bar close that has settled on this venue.
    const due = Math.floor((t - SETTLE_MS[tracks[0]!.venue]) / frameMs) * frameMs;
    const ready = tracks.filter(track => due > track.barCloseMs && !track.busy);
    for (const track of ready) track.busy = true;
    // Every market is requested at once (within the venue budget); evaluation stays in market order.
    const reads = ready.map(track => candlesFor(track.market, actor.settings, track.lastOpenTime, due, actor.abort.signal)
      .then(candles => ({ candles }), (error: unknown) => ({ error })));
    try {
      for (const [index, track] of ready.entries()) {
        if (actor.stopping) return;
        const read = await reads[index]!;
        try {
          if ('error' in read) {
            // Public data is retried on the next tick; working orders keep executing meanwhile.
            if (!actor.stopping && t - track.lastDataErrorAt >= 60_000) {
              track.lastDataErrorAt = t;
              record(actor, { type: 'event', venue: track.display, market: track.market.market,
                message: `Candle request failed, retrying: ${message(read.error)}` });
            }
            continue;
          }
          const seen = track.lastCandle;
          const recheck = seen && read.candles.find(candle => candle.openTime === seen.openTime);
          const revision = seen && recheck ? candleRevisionMessage(seen, recheck) : null;
          if (revision) record(actor, { type: 'event', venue: track.display, market: track.market.market, message: revision });
          const candles = read.candles.filter(candle => candle.openTime > track.lastOpenTime && candle.openTime + frameMs <= due);
          if (actor.stopping) return;
          if (candles.length > 0) {
            track.boundaryWaitSince = null;
            try {
              await evaluate(actor, track, candles);
              track.lastOpenTime = candles.at(-1)!.openTime;
              track.lastCandle = candles.at(-1)!;
            } catch (error) {
              // Pine is deterministic: an error on live bars repeats on every re-run.
              if (!actor.stopping) fail(actor, `Pine strategy failed on live data: ${message(error)}`);
              return;
            }
          } else {
            track.boundaryWaitSince ??= t;
            if (t - track.boundaryWaitSince >= NO_CANDLE_RELEASE_MS && track.lastResult && !actor.python) {
              // No trades in the bar: Pine has nothing new to evaluate. Re-confirm its orders for the new bar.
              track.boundaryWaitSince = null;
              track.barCloseMs = due;
              const fillsThrough = track.sentFills.reduce((max, fill) => (fill.time < track.lastResult!.barCloseMs ? Math.max(max, fill.seq) : max), 0);
              writeChild(actor, { ...orderSet(actor, track, track.lastResult, fillsThrough), barCloseMs: due });
              record(actor, { type: 'event', venue: track.display, market: track.market.market,
                message: `No ${track.market.market} candle for the bar closing ${new Date(due).toISOString()} (no trades); Pine orders kept.` });
            }
          }
        } catch (error) {
          if (!actor.stopping) fail(actor, `Pine bar update failed: ${message(error)}`);
          return;
        }
      }
    } finally {
      for (const track of ready) track.busy = false;
    }
  }

  async function prepare(actor: Actor): Promise<void> {
    try {
      const settings = actor.settings;
      const frameMs = BACKTEST_TIMEFRAME_MS[settings.timeframe];
      const catalog = new StrategyCatalogV1(options.catalogDir);
      let backtest: Record<string, unknown> | undefined;
      try { backtest = catalog.get(actor.snapshot.strategyId, actor.snapshot.strategyVersion)?.version.backtestSettings as Record<string, unknown> | undefined; }
      finally { catalog.close(); }
      const venues = [...new Set(settings.tracks.map(track => track.venue.toLowerCase() as PaperVenueKey))];
      const catalogs = new Map<PaperVenueKey, VenueMarket[]>();
      for (const venue of venues) catalogs.set(venue, await catalogFor(venue, actor.abort.signal));
      if (actor.stopping) return;
      const startMs = now();
      actor.startMs = startMs;
      const history: Array<{ track: Track; candles: Candle[] }> = [];
      for (const selected of settings.tracks) {
        const venue = selected.venue.toLowerCase() as PaperVenueKey;
        const market = catalogs.get(venue)!.find(row => row.market === selected.market);
        if (!market) throw new Error(`${selected.venue} ${selected.market} is not an active perpetual right now.`);
        const lastClose = Math.floor(startMs / frameMs) * frameMs;
        const historyBars = actor.python ? Math.min(PYTHON_MAX_WARMUP_BARS, Math.max(2, actor.python.warmupBars)) : PINE_LIVE_HISTORY_BARS;
        const candles = await candlesFor(market, settings, lastClose - historyBars * frameMs, lastClose, actor.abort.signal);
        if (actor.stopping) return;
        if (candles.length < 2) throw new Error(`${selected.venue} ${selected.market} has too little candle history.`);
        const mintick = pineMintick(market, candles.at(-1)!.close);
        const track: Track = { key: pythonTrackKey(venue, market.market), venue, display: selected.venue, market, mintick,
          lastOpenTime: candles.at(-1)!.openTime, lastCandle: candles.at(-1)!, barCloseMs: 0, newFills: [], sentFills: [], lastResult: null, busy: false,
          boundaryWaitSince: null, lastDataErrorAt: 0 };
        history.push({ track, candles });
        record(actor, { type: 'event', venue: selected.venue, market: market.market,
          message: `Loaded ${candles.length} closed ${settings.timeframe} candles of ${selected.venue} ${market.market}; mintick ${mintick}.` });
      }
      actor.tracks = history.map(row => row.track);
      if (!actor.python) {
      // One Pine worker per run; per venue the Pine commission follows that venue's fee.
      const execution = executionSettings(backtest, settings, actor.tracks[0]!.venue);
      // request.security history: loaded once per timeframe from the track's own exchange.
      const loadSeries = async (key: string, request: SeriesRequest): Promise<Candle[]> => {
        const track = actor.tracks.find(row => row.key === key);
        if (!track) throw new Error(`Unknown Paper track ${key}.`);
        const window = seriesWindow(request);
        const plan = seriesSourcePlan(request.timeframeMs);
        const loaded = await candlesFor(track.market, { ...settings, timeframe: plan.interval as typeof settings.timeframe },
          window.startInclusive, window.endExclusive, actor.abort.signal);
        const candles = aggregateCandles(loaded, request.timeframeMs, plan.factor, { allowSparse: true });
        record(actor, { type: 'event', venue: track.display, market: track.market.market,
          message: `Loaded ${candles.length} closed ${request.timeframe} candles for request.security.` });
        return candles;
      };
      actor.pine = new PineLiveClient(actor.snapshot.source, execution, startMs, undefined, loadSeries);
      await actor.pine.ready();
      }
      for (const { track, candles } of actor.python ? [] : history) {
        await actor.pine!.addTrack(track.key, {
          tickerId: `${track.display.toUpperCase()}:${track.market.market.replace(':', '_')}USDC.P`, symbol: track.market.market,
          exchange: track.display, quoteCurrency: 'USDC', mintick: track.mintick, minContract: track.market.sizeStep,
          pineTimeframe: PINE_TIMEFRAME[settings.timeframe],
        }, candles);
      }
      const config = {
        v: 1, runId: actor.snapshot.experimentId, parentPid: process.pid, sourceSha256: actor.snapshot.sourceSha256,
        eventOutboxPath: path.join(actor.directory, 'nautilus-events.jsonl'),
        strategyVersion: actor.snapshot.strategyVersion,
        nativeStrategy: actor.python ? 'python_strategy_v1' : 'pine_orders_v1',
        ...(actor.python && settings.accountModel === 'python_live_v1' ? { strategy: {
          ref: settings.strategyRef, packPaths: [...packs], params: settings.params, packSha256: actor.python.packSha256,
        } } : {}),
        capitalPerVenue: String(settings.capitalPerVenue), orderSizePercent: String(settings.orderSizePercent),
        timeframeMs: frameMs,
        fees: {
          lighter: { makerPercent: String(settings.lighterMakerFeePercent), takerPercent: String(settings.lighterTakerFeePercent) },
          hyperliquid: { makerPercent: String(settings.hyperliquidMakerFeePercent), takerPercent: String(settings.hyperliquidTakerFeePercent) },
        },
        tracks: actor.tracks.map(track => ({ venue: track.venue, market: track.market.market })),
        // HIP-3 markets: the ordinary Hyperliquid fee times the market's multiplier, per track.
        marketFees: Object.fromEntries(actor.tracks.filter(track => track.market.feeMultiplier !== 1).map(track => [track.key, {
          makerPercent: String(Number(((settings.hyperliquidMakerFeePercent ?? 0) * track.market.feeMultiplier).toFixed(10))),
          takerPercent: String(Number(((settings.hyperliquidTakerFeePercent ?? 0) * track.market.feeMultiplier).toFixed(10))),
        }])),
        minticks: Object.fromEntries(actor.tracks.map(track => [track.key, String(track.mintick)])),
        maxQuoteAgeMs: 1000, maxBookAgeMs: 1000, maxVenueSourceAgeMs: 2000, maxTrackQuietMs: 30_000,
        mode: 'public', hyperliquidFastBook,
        ...(settings.live ? { live: {
          exchange: 'lighter',
          ...(settings.live.dailyLossLimitPercent !== undefined
            ? { dailyLossLimitPercent: String(settings.live.dailyLossLimitPercent) } : {}),
          // The day's starting equity, kept between runs on this server.
          stateFile: path.join(options.runtimeDir, 'live-daily-reference.json'),
          maxLeverage: String(settings.live.maxLeverage),
          exchangeStopPercent: String(settings.live.exchangeStopPercent), exchangeStopFrom: settings.live.exchangeStopFrom,
          ...(settings.live.maxSlippagePercent !== undefined ? { maxSlippagePercent: String(settings.live.maxSlippagePercent) } : {}),
          ...(settings.live.maxPositionUsdc !== undefined ? { maxPositionUsdc: String(settings.live.maxPositionUsdc) } : {}),
          ...(settings.live.minimumOrderSize ? { minimumOrderSize: true } : {}),
        } } : {}),
      };
      const configFile = path.join(actor.directory, 'nautilus-config.json');
      writeFileSync(configFile, JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });
      record(actor, { type: 'phase', stage: 'waiting_for_data', message: settings.live
        ? 'LIVE: starting Nautilus with the real Lighter account and public market data.'
        : 'Starting Nautilus with two virtual USDC accounts and public market data.' });
      actor.view = { ...actor.view, stage: 'waiting_for_data' };
      const child = options.dependencies?.spawn?.(configFile) ?? spawn(python, [script, '--config', configFile], {
        cwd: options.projectRoot, env: settings.live ? liveEnv : env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      attach(actor, child);
      actor.lastMessageAt = now();
      if (actor.python) {
        // Warm-up bars (orders ignored), then the strategy starts flat.
        for (const { track, candles } of history) {
          writeChild(actor, { cmd: 'bars', venue: track.venue, market: track.market.market, bars: candles.map(pythonBar) });
          track.barCloseMs = candles.at(-1)!.closeTime + 1;
        }
      } else {
        // Initial evaluation over history: shadow trades and resting orders.
        for (const { track } of history) {
          await evaluate(actor, track, []);
          if (actor.stopping) return;
        }
      }
      actor.timer = setInterval(() => {
        if (actor.stopping) return;
        if (now() - actor.lastMessageAt > 60_000) return fail(actor, 'No Nautilus heartbeat for 60 seconds.');
        if (!actor.loop) actor.loop = onBoundary(actor).finally(() => { actor.loop = null; });
      }, BOUNDARY_TICK_MS);
    } catch (error) { if (!actor.stopping) fail(actor, `Paper startup failed: ${message(error)}`); }
  }

  return {
    admissionLimits: { maxTracksPerVenue: MAX_MARKETS_PER_VENUE, maxTracksPerExperiment: MAX_MARKETS_PER_RUN },
    async preflight(input) {
      assertLive(assertInput(input));
      const catalog = new StrategyCatalogV1(options.catalogDir);
      try {
        const saved = catalog.get(input.strategyId, input.strategyVersion)?.version;
        if (!saved || saved.source !== input.source || saved.sourceSha256 !== input.sourceSha256
          || JSON.stringify(saved.paperSettings) !== JSON.stringify(input.settings)) throw new Error('Saved strategy or Paper settings changed before launch.');
      } finally { catalog.close(); }
      if (input.settings.accountModel === 'python_live_v1') {
        const info = await pythonStrategy(input.settings.strategyRef);
        const unknown = Object.keys(input.settings.params).filter(name => !(name in info.params));
        if (unknown.length) throw new Error(`Unknown parameter(s) for ${info.name}: ${unknown.join(', ')}.`);
      }
      assertNoLiveNautilusProcess(options.runtimeDir);
      if (options.dependencies?.checkRuntime) await options.dependencies.checkRuntime();
      else await checkNautilusRuntime(python, script, options.projectRoot, env, hyperliquidFastBook);
    },
    async start(snapshot, report) {
      const settings = assertInput(snapshot);
      assertLive(settings);
      if (actors.has(snapshot.experimentId)) throw new Error('This Paper factory already owns this run.');
      const pythonInfo = settings.accountModel === 'python_live_v1' ? await pythonStrategy(settings.strategyRef) : null;
      const directory = path.join(options.runtimeDir, snapshot.experimentId);
      mkdirSync(options.runtimeDir, { recursive: true, mode: 0o700 });
      mkdirSync(directory, { mode: 0o700 });
      const ledger = new NautilusPaperLedger(directory, snapshot);
      const actor: Actor = {
        snapshot, settings, python: pythonInfo, directory, ledger, report, abort: new AbortController(), child: null, childExit: null,
        exited: false, pine: null, tracks: [], startMs: 0, task: null, loop: null, timer: null, stopPromise: null,
        stopping: false, failure: null, engineStopReason: null, seq: 0, childSeq: 0, logBytes: 0, lastMessageAt: now(),
        view: { engine: 'nautilus', stage: 'warming_up', fundingTreatment: 'excluded', observedAt: new Date().toISOString(), accounts: [] },
      };
      actors.set(snapshot.experimentId, actor);
      ownedNautilusRuns.add(snapshot.experimentId);
      const runtimeSources = Object.fromEntries(readdirSync(path.dirname(script))
        .filter(name => name.endsWith('.py')).sort()
        .map(name => [name, sha256(readFileSync(path.join(path.dirname(script), name)))]));
      writeFileSync(path.join(directory, 'nautilus-manifest.json'), JSON.stringify({
        engine: 'nautilus', version, hyperliquidFastBook, sourceSha256: snapshot.sourceSha256,
        strategyId: snapshot.strategyId, strategyVersion: snapshot.strategyVersion, settings: snapshot.settings,
        executionModel: 'pine-live-orders-v1',
        signalModel: pythonInfo ? 'python-sdk-in-process-v1' : 'pine-rerun-per-closed-bar-v1',
        ...(pythonInfo ? { pythonStrategy: { id: pythonInfo.id, pack: pythonInfo.pack, packSha256: pythonInfo.packSha256,
          builtin: pythonInfo.builtin } } : {}),
        startModel: 'flat-start-shadow-history-v1', freshnessModel: 'venue-stream-liveness-v1',
        historyBars: pythonInfo ? Math.min(PYTHON_MAX_WARMUP_BARS, pythonInfo.warmupBars) : PINE_LIVE_HISTORY_BARS, feeModel: 'actual-liquidity-side-v1', fundingTreatment: 'excluded', runtimeSources,
      }) + '\n', { flag: 'wx', mode: 0o600 });
      record(actor, { type: 'phase', stage: 'warming_up', message: pythonInfo
        ? `Loading closed ${settings.timeframe} candles per market to warm up ${pythonInfo.name}.`
        : `Loading ${PINE_LIVE_HISTORY_BARS} closed ${settings.timeframe} candles per market and starting Pine.` });
      notify(actor, { status: 'warming_up' });
      actor.task = prepare(actor);
      return { stop: (reason?: string) => stop(actor, reason), snapshot: () => actor.view };
    },
    async abortStart(snapshot) {
      const actor = actors.get(snapshot.experimentId);
      return actor ? stop(actor) : { outcome: 'interrupted', controlSlotReleaseProven: true, finalVenueDrainProven: false,
        reason: 'No Nautilus process was created for this failed start.' };
    },
  };
}

/** Routes each launch to the engine its saved settings were prepared for. */
export function createPaperRuntimeRouter(hourly: PaperExperimentRuntimeFactory | null,
  pine: PaperExperimentRuntimeFactory): PaperExperimentRuntimeFactory {
  const pick = (settings: Proposed['settings']) => {
    if (isLiveSettings(settings)) return pine;
    if (!hourly) throw new Error('This Paper settings model is not enabled on this server.');
    return hourly;
  };
  const owners = new Map<string, PaperExperimentRuntimeFactory>();
  return {
    admissionLimits: pine.admissionLimits!,
    preflight: (input) => pick(input.settings).preflight(input),
    async start(snapshot, report) {
      const factory = pick(snapshot.settings);
      owners.set(snapshot.experimentId, factory);
      return factory.start(snapshot, report);
    },
    abortStart: (snapshot) => (owners.get(snapshot.experimentId) ?? pick(snapshot.settings)).abortStart(snapshot),
  };
}
