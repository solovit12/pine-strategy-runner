import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../apps/api/src/server';
import {
  PaperExperimentControllerV1, SERVER_SHUTDOWN_REASON, type PaperExperimentRuntimeFactory, type PaperExperimentStopProof,
} from '../apps/api/src/paper-execution/paper-experiment-controller';
import { PaperExperimentStoreError, PaperExperimentStoreV1 } from '../apps/api/src/paper-execution/paper-experiment-store';
import { MAX_CONCURRENT_PAPER_EXPERIMENTS as MAX_RUNS, StartPaperExperimentSchema } from '../packages/shared/src/paper-experiment-contracts';
import type { StrategyDetail } from '../packages/shared/src/strategy-catalog-contracts';

const source = `//@version=6
strategy("Pilot", overlay=true)
if bar_index == 2
    strategy.entry("Long", strategy.long)
`;
const hash = createHash('sha256').update(source).digest('hex');
const interruptedStopProof = {
  outcome: 'interrupted', controlSlotReleaseProven: true, finalVenueDrainProven: false,
  reason: 'Paper run stopped before both venues completed.',
} as const satisfies PaperExperimentStopProof;
const completedStopProof = {
  outcome: 'completed', controlSlotReleaseProven: true, finalVenueDrainProven: true,
  reason: null,
} as const satisfies PaperExperimentStopProof;
const settings = {
  accountModel: 'venue_shared_v2',
  timeframe: '1h',
  tracks: [
    { venue: 'Hyperliquid', market: 'HYPE' },
    { venue: 'Hyperliquid', market: 'BTC' },
    { venue: 'Lighter', market: 'HYPE' },
    { venue: 'Lighter', market: 'BTC' },
  ],
  capitalPerVenue: 10_000,
  orderSizePercentOfRealizedEquity: 10,
  hyperliquidMakerEntryFeePercent: 0,
  hyperliquidTakerExitFeePercent: 0,
  lighterMakerEntryFeePercent: 0,
  lighterTakerExitFeePercent: 0,
};
const legacySettings = {
  timeframe: '1h', tracks: settings.tracks,
  capitalPerTrack: 10_000, targetOrderValue: 500,
  hyperliquidFeePercent: null, lighterFeePercent: null,
};
const sharedV1Settings = {
  accountModel: 'venue_shared_v1', timeframe: '1h', tracks: settings.tracks,
  capitalPerVenue: 10_000, orderSizePercentOfRealizedEquity: 10,
  hyperliquidFeePercent: 0, lighterFeePercent: 0,
};
const backtestSettings = {
  exchange: 'Binance', marketType: 'Perpetual', symbol: 'HYPEUSDT', timeframe: '1h',
  dateRange: { start: '2026-09-01', end: '2026-09-07' },
  initialCapital: 10_000, baseCurrency: 'USDT', defaultOrderSizeValue: 0.01,
  defaultOrderSizeType: 'fixed', pyramiding: 0, feeModel: 'manual',
  commissionType: 'percent', commissionValue: 0, slippageTicks: 0,
};

const directories: string[] = [];
async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pine-paper-control-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function saveStrategy(app: Awaited<ReturnType<typeof buildApp>>) {
  const result = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
    name: 'Pilot', source, backtestSettings, paperSettings: settings,
  } });
  expect(result.statusCode, result.body).toBe(201);
  return result.json().strategy.id as string;
}

/** Starts more runs until `active` of the run limit are taken (each must start). */
async function fillSlots(app: Awaited<ReturnType<typeof buildApp>>, strategyId: string, from: number, status = 201) {
  const started = [];
  for (let active = from; active < MAX_RUNS; active += 1) {
    const response = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(strategyId) });
    expect(response.statusCode, response.body).toBe(status);
    started.push(response);
  }
  return started;
}

function launch(strategyId: string, idempotencyKey = randomUUID()) {
  return { strategyId, version: 1, sourceSha256: hash, settings, idempotencyKey };
}

describe('Paper experiment control API', () => {
  it('accepts reordered market selections while pinning saved order and preserving strict values and idempotency', async () => {
    const root = await tempRoot();
    const markets = ['HYPE', 'SOL', 'XRP', 'SUI', 'DOGE'];
    const savedSettings = { ...settings, tracks: ['Hyperliquid', 'Lighter'].flatMap(venue =>
      markets.map(market => ({ venue, market }))) };
    const preflight = vi.fn(async (proposed: Parameters<PaperExperimentRuntimeFactory['preflight']>[0]) => {
      // Nautilus also performs this exact saved-settings check. The controller
      // must pass the original order through instead of weakening that guard.
      expect(JSON.stringify(proposed.settings)).toBe(JSON.stringify(savedSettings));
    });
    const start = vi.fn(async (_snapshot: Parameters<PaperExperimentRuntimeFactory['start']>[0]) => ({
      stop: async () => interruptedStopProof,
    }));
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'),
      paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: {
        preflight, start, abortStart: async () => interruptedStopProof,
      } });
    let experimentId = '';
    try {
      const saved = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        name: 'Five markets grouped by venue', source, backtestSettings, paperSettings: savedSettings,
      } });
      expect(saved.statusCode, saved.body).toBe(201);
      const request = { ...launch(saved.json().strategy.id), settings: { ...savedSettings,
        tracks: markets.flatMap(market => [{ venue: 'Hyperliquid', market }, { venue: 'Lighter', market }]),
      } };
      const untouched = structuredClone(request);
      const first = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: request });
      expect(first.statusCode, first.body).toBe(201);
      experimentId = first.json().experiment.id;
      expect(first.json().experiment.settings).toEqual(savedSettings);
      expect(first.json().experiment.accounts).toHaveLength(2);
      expect(start.mock.calls[0]![0].settings).toEqual(savedSettings);
      expect(request).toEqual(untouched);

      const repeated = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
        ...request, settings: { ...request.settings, tracks: [...request.settings.tracks].reverse() },
      } });
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(repeated.json().experiment.id).toBe(experimentId);
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      for (const change of [
        { capitalPerVenue: 11_000 },
        { lighterMakerEntryFeePercent: 0.1 },
        { tracks: request.settings.tracks.filter(track => !(track.venue === 'Lighter' && track.market === 'DOGE')) },
      ]) {
        const changed = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
          ...request, settings: { ...request.settings, ...change },
        } });
        expect(changed.statusCode, changed.body).toBe(409);
        expect(changed.json().kind).toBe('IDEMPOTENCY_CONFLICT');
        const fresh = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
          ...request, idempotencyKey: randomUUID(), settings: { ...request.settings, ...change },
        } });
        expect(fresh.statusCode, fresh.body).toBe(409);
        expect(fresh.json().kind).toBe('SOURCE_VERSION_CONFLICT');
      }
      expect(start).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
    // The existing exact request checksum must still validate after reopening;
    // no stored hash/schema migration or rewrite is required.
    const store = new PaperExperimentStoreV1(path.join(root, 'paper'));
    try { expect(store.get(experimentId)?.settings).toEqual(savedSettings); }
    finally { store.close(); }
  });

  it('reports the real blocker and creates no pretend active session by default', async () => {
    const root = await tempRoot();
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper') });
    try {
      const id = await saveStrategy(app);
      const capabilities = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.json()).toMatchObject({ available: false, maxTracksPerVenue: 15, maxTracksPerExperiment: 30, maxConcurrentExperiments: MAX_RUNS });
      expect(capabilities.json().reason).toBe('Paper launch is not enabled on this server.');
      const rejected = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      expect(rejected.statusCode, rejected.body).toBe(422);
      expect(rejected.json().kind).toBe('PAPER_UNAVAILABLE');
      const list = await app.inject({ method: 'GET', url: '/api/paper-experiments' });
      expect(list.statusCode).toBe(200);
      expect(list.json().experiments).toEqual([]);
    } finally { await app.close(); }
  });

  it('rejects cross-origin browser requests to start or stop Paper', async () => {
    const root = await tempRoot();
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper') });
    try {
      const id = await saveStrategy(app);
      const headers = { origin: 'https://other.example' };
      const started = await app.inject({ method: 'POST', url: '/api/paper-experiments', headers, payload: launch(id) });
      expect(started.statusCode).toBe(403);
      expect(started.json().kind).toBe('PAPER_ORIGIN_FORBIDDEN');
      const stopped = await app.inject({ method: 'POST', url: `/api/paper-experiments/${randomUUID()}/stop`, headers });
      expect(stopped.statusCode).toBe(403);
      expect(stopped.json().kind).toBe('PAPER_ORIGIN_FORBIDDEN');
      const opaque = await app.inject({ method: 'POST', url: '/api/paper-experiments',
        headers: { 'sec-fetch-site': 'cross-site' }, payload: launch(id) });
      expect(opaque.statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('pins exact saved source/settings, admits one group atomically, and stops the actual owner', async () => {
    const root = await tempRoot();
    let report!: Parameters<PaperExperimentRuntimeFactory['start']>[1];
    let pinned!: Parameters<PaperExperimentRuntimeFactory['start']>[0];
    const stop = vi.fn(async () => interruptedStopProof);
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => interruptedStopProof,
      start: async (snapshot, notify) => {
        // Keep the first run's owner; a parallel second run must not replace it.
        pinned ??= snapshot;
        report ??= notify;
        return { stop };
      },
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const strategyId = await saveStrategy(app);
      const request = launch(strategyId);
      const first = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: request });
      expect(first.statusCode, first.body).toBe(201);
      const experiment = first.json().experiment;
      expect(experiment.status).toBe('waiting_for_data');
      expect(experiment.trackCount).toBe(4);
      expect(experiment.accounts).toHaveLength(2);
      const history = await app.inject({ method: 'GET', url: '/api/paper-experiments' });
      expect(history.json().experiments[0]).toMatchObject({
        venues: ['Hyperliquid', 'Lighter'], markets: ['HYPE', 'BTC'],
        timeframe: '1h', capitalPerVenue: 10_000,
      });
      expect(new Set(experiment.tracks.map((track: { trackId: string }) => track.trackId)).size).toBe(4);
      expect(new Set(experiment.tracks.map((track: { runId: string }) => track.runId)).size).toBe(2);
      expect(new Set(experiment.tracks.map((track: { accountId: string }) => track.accountId)).size).toBe(2);
      expect(experiment.tracks.filter((track: { venue: string }) => track.venue === 'Lighter').map((track: { accountId: string }) => track.accountId)).toEqual([
        experiment.accounts[1].accountId, experiment.accounts[1].accountId,
      ]);
      expect(pinned.source).toBe(source);
      expect(pinned.sourceSha256).toBe(hash);
      expect(pinned.settings).toEqual(settings);
      expect(pinned.accounts).toHaveLength(2);

      const repeated = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: request });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json().experiment.id).toBe(experiment.id);
      const conflict = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: { ...request, settings: { ...settings, capitalPerVenue: 11_000 } } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().kind).toBe('IDEMPOTENCY_CONFLICT');
      const unsavedSettings = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
        ...launch(strategyId), settings: { ...settings, capitalPerVenue: 11_000 },
      } });
      expect(unsavedSettings.statusCode).toBe(409);
      expect(unsavedSettings.json().kind).toBe('SOURCE_VERSION_CONFLICT');
      const second = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(strategyId) });
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json().experiment.id).not.toBe(experiment.id);
      await fillSlots(app, strategyId, 2);
      const full = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
      expect(full.json()).toMatchObject({ available: false, maxConcurrentExperiments: MAX_RUNS });
      expect(full.json().reason).toMatch(new RegExp(`${MAX_RUNS} Paper experiments are already active`));
      const third = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(strategyId) });
      expect(third.statusCode).toBe(409);
      expect(third.json().kind).toBe('PAPER_EXPERIMENT_LIMIT');

      report(experiment.tracks[0].trackId, { status: 'running', events: 11, signals: 1 });
      const detail = await app.inject({ method: 'GET', url: `/api/paper-experiments/${experiment.id}` });
      expect(detail.json().experiment.status).toBe('running');
      expect(detail.json().experiment.tracks[0]).toMatchObject({ events: 11, signals: 1 });
      const stopped = await app.inject({ method: 'POST', url: `/api/paper-experiments/${experiment.id}/stop` });
      expect(stopped.statusCode, stopped.body).toBe(200);
      expect(stopped.json().experiment.status).toBe('interrupted');
      expect(stop).toHaveBeenCalledTimes(1);
      const repeatedStop = await app.inject({ method: 'POST', url: `/api/paper-experiments/${experiment.id}/stop` });
      expect(repeatedStop.statusCode).toBe(200);
      expect(stop).toHaveBeenCalledTimes(1);

      const newVersion = await app.inject({ method: 'POST', url: `/api/strategies/${strategyId}/versions`, payload: {
        name: 'Pilot changed', source: `${source}\n// changed`, backtestSettings,
        paperSettings: settings, expectedVersion: 1,
      } });
      expect(newVersion.statusCode, newVersion.body).toBe(201);
      expect(pinned.source).toBe(source);
      expect(pinned.strategyVersion).toBe(1);
    } finally { await app.close(); }

    const reopened = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper') });
    try {
      const list = await reopened.inject({ method: 'GET', url: '/api/paper-experiments' });
      expect(list.json().experiments).toHaveLength(MAX_RUNS);
      for (const item of list.json().experiments) {
        expect(item).toMatchObject({ status: 'interrupted', strategyVersion: 1, sourceSha256: hash });
      }
    } finally { await reopened.close(); }
  });

  it('stops runs for a server shutdown with that reason and starts them again on the next engine', async () => {
    const root = await tempRoot();
    const dirs = { strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper') };
    const stopReasons: (string | undefined)[] = [];
    const started: string[] = [];
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => interruptedStopProof,
      start: async (snapshot) => {
        started.push(snapshot.experimentId);
        return { stop: async (reason?: string) => {
          stopReasons.push(reason);
          return { ...interruptedStopProof, reason: reason ? `${reason} Every position is closed.` : interruptedStopProof.reason };
        } };
      },
    };
    let strategyId = '';
    let shutDown = '';
    let ownerStopped = '';
    const app = await buildApp({ ...dirs, paperRuntimeFactory: factory });
    try {
      strategyId = await saveStrategy(app);
      shutDown = (await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(strategyId) })).json().experiment.id;
      ownerStopped = (await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(strategyId) })).json().experiment.id;
      expect((await app.inject({ method: 'POST', url: `/api/paper-experiments/${ownerStopped}/stop` })).statusCode).toBe(200);
    } finally { await app.close(); }
    expect(stopReasons).toEqual([undefined, SERVER_SHUTDOWN_REASON]);
    expect(JSON.parse(await readFile(path.join(dirs.paperExperimentsDir, 'resume-after-restart.json'), 'utf8')).ids).toEqual([shutDown]);

    const next = await buildApp({ ...dirs, paperRuntimeFactory: factory });
    try {
      await next.ready();
      await vi.waitFor(() => expect(started).toHaveLength(3));
      const runs = (await next.inject({ method: 'GET', url: '/api/paper-experiments' })).json().experiments as
        { id: string; status: string; reason: string | null; strategyId: string; strategyVersion: number }[];
      expect(runs.find(run => run.id === shutDown)).toMatchObject({ status: 'interrupted',
        reason: `${SERVER_SHUTDOWN_REASON} Every position is closed.` });
      expect(runs.find(run => run.id === ownerStopped)?.reason).not.toContain(SERVER_SHUTDOWN_REASON);
      expect(runs.find(run => run.id === started[2])).toMatchObject({ status: 'waiting_for_data', strategyId, strategyVersion: 1 });
      await expect(readFile(path.join(dirs.paperExperimentsDir, 'resume-after-restart.json'))).rejects.toThrow();
    } finally { await next.close(); }
  });

  it('does not resume a shutdown run after the resume window', async () => {
    const root = await tempRoot();
    const dirs = { strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper') };
    const started: string[] = [];
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => interruptedStopProof,
      start: async (snapshot) => { started.push(snapshot.experimentId); return { stop: async (reason?: string) => ({ ...interruptedStopProof, reason: reason ?? 'x' }) }; },
    };
    const app = await buildApp({ ...dirs, paperRuntimeFactory: factory });
    try {
      const strategyId = await saveStrategy(app);
      await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(strategyId) });
    } finally { await app.close(); }
    const file = path.join(dirs.paperExperimentsDir, 'resume-after-restart.json');
    const entry = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...entry, at: entry.at - 7 * 60 * 60 * 1000 }));
    const next = await buildApp({ ...dirs, paperRuntimeFactory: factory });
    try {
      await next.ready();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(started).toHaveLength(1);
      await expect(readFile(file)).rejects.toThrow();
    } finally { await next.close(); }
  });

  it('keeps a stopping run in its slot until the owner actually stops', async () => {
    const root = await tempRoot();
    let releaseStop!: () => void;
    // Only the first stop hangs; the parallel run stops normally when the app closes.
    const stop = vi.fn(async () => interruptedStopProof);
    stop.mockImplementationOnce(() => new Promise<PaperExperimentStopProof>((resolve) => { releaseStop = () => resolve(interruptedStopProof); }));
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => interruptedStopProof,
      start: async () => ({ stop }),
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const id = await saveStrategy(app);
      const first = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      const experimentId = first.json().experiment.id as string;
      expect(first.json().experiment.tracks.every((track: { status: string }) => track.status === 'waiting_for_data')).toBe(true);
      const parallel = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      expect(parallel.statusCode, parallel.body).toBe(201);
      await fillSlots(app, id, 2);
      const pendingStop = app.inject({ method: 'POST', url: `/api/paper-experiments/${experimentId}/stop` });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      const whileStopping = await app.inject({ method: 'GET', url: `/api/paper-experiments/${experimentId}` });
      expect(whileStopping.json().experiment.status).toBe('stopping');
      const busy = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
      expect(busy.json().available).toBe(false);
      expect(busy.json().reason).toMatch(/already active/);
      const third = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      expect(third.statusCode).toBe(409);
      expect(third.json().kind).toBe('PAPER_EXPERIMENT_LIMIT');
      releaseStop();
      const stopped = await pendingStop;
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json().experiment.status).toBe('interrupted');
      const freed = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
      expect(freed.json().available).toBe(true);
    } finally { await app.close(); }
  });

  it('retains the active slot after a failed stop and allows a safe stop retry', async () => {
    const root = await tempRoot();
    let stopAttempts = 0;
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => interruptedStopProof,
      start: async () => ({ stop: async () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error('owner is still draining');
        return interruptedStopProof;
      } }),
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const id = await saveStrategy(app);
      const first = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      const experimentId = first.json().experiment.id as string;
      const rejected = await app.inject({ method: 'POST', url: `/api/paper-experiments/${experimentId}/stop` });
      expect(rejected.statusCode).toBe(503);
      expect(rejected.json().experiment.status).toBe('stopping');
      expect(rejected.json().experiment.reason).toMatch(/owner is still draining/);
      const second = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      expect(second.statusCode, second.body).toBe(201);
      await fillSlots(app, id, 2);
      const third = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      expect(third.statusCode).toBe(409);
      const retried = await app.inject({ method: 'POST', url: `/api/paper-experiments/${experimentId}/stop` });
      expect(retried.statusCode).toBe(200);
      expect(retried.json().experiment.status).toBe('interrupted');
      expect(stopAttempts).toBe(2);
    } finally { await app.close(); }
  });

  it('does not release the slot when a stop returns without shutdown proof', async () => {
    const root = await tempRoot();
    let proof: PaperExperimentStopProof | null = null;
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => interruptedStopProof,
      start: async () => ({ stop: async () => proof as PaperExperimentStopProof }),
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const id = await saveStrategy(app);
      const first = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      const experimentId = first.json().experiment.id as string;
      const unproven = await app.inject({ method: 'POST', url: `/api/paper-experiments/${experimentId}/stop` });
      expect(unproven.statusCode).toBe(503);
      expect(unproven.json().experiment.status).toBe('stopping');
      expect(unproven.json().experiment.reason).toMatch(/did not prove a releasable/);
      const parallel = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      expect(parallel.statusCode, parallel.body).toBe(201);
      await fillSlots(app, id, 2);
      const busy = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
      expect(busy.json().available).toBe(false);
      proof = interruptedStopProof;
      const retried = await app.inject({ method: 'POST', url: `/api/paper-experiments/${experimentId}/stop` });
      expect(retried.statusCode).toBe(200);
      expect(retried.json().experiment.status).toBe('interrupted');
      expect((await app.inject({ method: 'GET', url: '/api/paper/capabilities' })).json().available).toBe(true);
    } finally { await app.close(); }
  });

  it('records a completed run only after every track completes and the final two-venue drain is proved', async () => {
    const root = await tempRoot();
    let report!: Parameters<PaperExperimentRuntimeFactory['start']>[1];
    const stop = vi.fn(async () => completedStopProof);
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => interruptedStopProof,
      start: async (_snapshot, notify) => { report = notify; return { stop }; },
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const id = await saveStrategy(app);
      const first = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      const experiment = first.json().experiment;
      for (const track of experiment.tracks) report(track.trackId, { status: 'completed' });
      await vi.waitFor(async () => {
        const final = await app.inject({ method: 'GET', url: `/api/paper-experiments/${experiment.id}` });
        expect(final.json().experiment.status).toBe('completed');
      });
      expect(stop).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  it('does not close the control journal while shutdown cannot prove the runtime stopped', async () => {
    const root = await tempRoot();
    let stopAttempts = 0;
    const controller = new PaperExperimentControllerV1({
      directory: path.join(root, 'paper'), catalogConfigured: true,
      runtimeFactory: {
        preflight: async () => undefined,
        abortStart: async () => interruptedStopProof,
        start: async () => ({ stop: async () => {
          stopAttempts += 1;
          if (stopAttempts === 1) throw new Error('owner still holds a market feed');
          return interruptedStopProof;
        } }),
      },
    });
    const strategyId = randomUUID();
    const saved = {
      strategy: { id: strategyId },
      version: { version: 1, sourceSha256: hash, paperSettings: settings, name: 'Pilot', source, metadata: {} },
    } as StrategyDetail;
    const admitted = await controller.start(StartPaperExperimentSchema.parse(launch(strategyId)), saved);
    await expect(controller.close()).rejects.toThrow('owner still holds a market feed');
    expect(controller.get(admitted.experiment.id)?.status).toBe('stopping');
    expect(controller.list().filter((item) => item.status === 'stopping')).toHaveLength(1);
    await controller.close();
    expect(stopAttempts).toBe(2);
    const reopened = new PaperExperimentStoreV1(path.join(root, 'paper'));
    try { expect(reopened.get(admitted.experiment.id)?.status).toBe('interrupted'); }
    finally { reopened.close(); }
  });

  it('stops both venue accounts when even one market is interrupted', async () => {
    const root = await tempRoot();
    let report!: Parameters<PaperExperimentRuntimeFactory['start']>[1];
    let releaseStop!: () => void;
    const stop = vi.fn(() => new Promise<PaperExperimentStopProof>((resolve) => { releaseStop = () => resolve(interruptedStopProof); }));
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => interruptedStopProof,
      start: async (_snapshot, notify) => { report = notify; return { stop }; },
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const id = await saveStrategy(app);
      const first = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      const experiment = first.json().experiment;
      report(experiment.tracks[0].trackId, { status: 'running' });
      report(experiment.tracks[1].trackId, { status: 'interrupted', reason: 'Market feed lost an accepted event.' });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      const pending = await app.inject({ method: 'GET', url: `/api/paper-experiments/${experiment.id}` });
      expect(pending.json().experiment.status).toBe('stopping');
      expect(pending.json().experiment.reason).toContain('Market feed lost');
      releaseStop();
      await vi.waitFor(async () => {
        const final = await app.inject({ method: 'GET', url: `/api/paper-experiments/${experiment.id}` });
        expect(final.json().experiment.status).toBe('interrupted');
        expect(final.json().experiment.reason).toContain('Market feed lost an accepted event.');
      });
    } finally { await app.close(); }
  });

  it('keeps the first venue failure when a later track reports a shutdown symptom', async () => {
    const root = await tempRoot();
    const primary = 'lighter external failure: original market-data fault';
    const secondary = 'Lighter one-market owner is not running.';
    let report!: Parameters<PaperExperimentRuntimeFactory['start']>[1];
    let releaseStop: (() => void) | undefined;
    const stop = vi.fn(() => new Promise<PaperExperimentStopProof>((resolve) => {
      releaseStop = () => resolve({ ...interruptedStopProof, reason: primary });
    }));
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => interruptedStopProof,
      start: async (_snapshot, notify) => { report = notify; return { stop }; },
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'),
      paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    let experimentId = '';
    try {
      const strategyId = await saveStrategy(app);
      const started = await app.inject({ method: 'POST', url: '/api/paper-experiments',
        payload: launch(strategyId) });
      experimentId = started.json().experiment.id as string;
      const tracks = started.json().experiment.tracks as { trackId: string }[];
      report(tracks[0]!.trackId, { status: 'interrupted', reason: primary });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      report(tracks[1]!.trackId, { status: 'interrupted', reason: secondary });
      releaseStop?.();
      await vi.waitFor(async () => {
        const detail = await app.inject({ method: 'GET', url: `/api/paper-experiments/${experimentId}` });
        expect(detail.json().experiment.status).toBe('interrupted');
        expect(detail.json().experiment.reason).toBe(primary);
      });
    } finally {
      releaseStop?.();
      await app.close();
    }
    const reopened = new PaperExperimentStoreV1(path.join(root, 'paper'));
    try { expect(reopened.get(experimentId)?.reason).toBe(primary); }
    finally { reopened.close(); }
  });

  it('frees a failed-start slot only after cleanup is proved and never reuses its key as success', async () => {
    const root = await tempRoot();
    const abortStart = vi.fn(async () => interruptedStopProof);
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart,
      start: async () => { throw new Error('second venue did not initialize'); },
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const id = await saveStrategy(app);
      const request = launch(id);
      const failed = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: request });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().experiment.status).toBe('interrupted');
      expect(abortStart).toHaveBeenCalledTimes(1);
      const repeated = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: request });
      expect(repeated.statusCode).toBe(503);
      expect(repeated.json().kind).toBe('PAPER_START_FAILED');
    } finally { await app.close(); }
  });

  it('holds the slot when a failed start cannot prove cleanup', async () => {
    const root = await tempRoot();
    let cleanupCanFinish = false;
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => undefined,
      abortStart: async () => {
        if (!cleanupCanFinish) throw new Error('first venue owner is still live');
        return interruptedStopProof;
      },
      start: async () => { throw new Error('second venue failed'); },
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const id = await saveStrategy(app);
      const failed = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().experiment.status).toBe('stopping');
      expect(failed.json().experiment.reason).toMatch(/first venue owner is still live/);
      const secondFailed = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      expect(secondFailed.statusCode).toBe(503);
      const moreFailed = await fillSlots(app, id, 2, 503);
      const third = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) });
      expect(third.statusCode).toBe(409);
      cleanupCanFinish = true;
      for (const held of [failed, secondFailed, ...moreFailed]) {
        const stopped = await app.inject({ method: 'POST', url: `/api/paper-experiments/${held.json().experiment.id}/stop` });
        expect(stopped.statusCode).toBe(200);
        expect(stopped.json().experiment.status).toBe('interrupted');
      }
    } finally { await app.close(); }
  });

  it('rejects a source mismatch before creating a session', async () => {
    const root = await tempRoot();
    const factory: PaperExperimentRuntimeFactory = { preflight: async () => undefined, abortStart: async () => interruptedStopProof, start: async () => ({ stop: async () => interruptedStopProof }) };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const id = await saveStrategy(app);
      const response = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: { ...launch(id), sourceSha256: 'a'.repeat(64) } });
      expect(response.statusCode).toBe(409);
      expect(response.json().kind).toBe('SOURCE_VERSION_CONFLICT');
      expect((await app.inject({ method: 'GET', url: '/api/paper-experiments' })).json().experiments).toEqual([]);
    } finally { await app.close(); }
  });

  it('keeps a legacy per-track draft readable but requires an explicit venue-shared saved version for launch', async () => {
    const root = await tempRoot();
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper') });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        name: 'Legacy draft', source, backtestSettings, paperSettings: legacySettings,
      } });
      expect(created.statusCode, created.body).toBe(201);
      const strategyId = created.json().strategy.id;
      expect(created.json().version.paperSettings).toEqual(legacySettings);
      const oldLaunch = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
        ...launch(strategyId), settings: legacySettings,
      } });
      expect(oldLaunch.statusCode).toBe(400);
      expect(oldLaunch.json().kind).toBe('INVALID_PAPER_EXPERIMENT');
      const oldVersionWithNewSettings = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(strategyId) });
      expect(oldVersionWithNewSettings.statusCode).toBe(422);
      expect(oldVersionWithNewSettings.json().kind).toBe('UNSUPPORTED_STRATEGY');
      const explicit = await app.inject({ method: 'POST', url: `/api/strategies/${strategyId}/versions`, payload: {
        name: 'Venue-shared draft', source, backtestSettings, paperSettings: settings, expectedVersion: 1,
      } });
      expect(explicit.statusCode, explicit.body).toBe(201);
      expect(explicit.json().version.paperSettings).toEqual(settings);
      // Saving replaces the strategy: only the current copy stays in the library.
      const prior = await app.inject({ method: 'GET', url: `/api/strategies/${strategyId}/versions/1` });
      expect(prior.statusCode).toBe(404);
      const sharedLaunch = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
        ...launch(strategyId), version: 2,
      } });
      expect(sharedLaunch.statusCode).toBe(422);
      expect(sharedLaunch.json().kind).toBe('PAPER_UNAVAILABLE');
      expect((await app.inject({ method: 'GET', url: '/api/paper-experiments' })).json().experiments).toEqual([]);
    } finally { await app.close(); }
  });

  it('admits only up to the concurrent limit when one launch more than it races', async () => {
    const root = await tempRoot();
    const start = vi.fn(async () => ({ stop: async () => interruptedStopProof }));
    const factory: PaperExperimentRuntimeFactory = {
      preflight: async () => { await Promise.resolve(); },
      abortStart: async () => interruptedStopProof,
      start,
    };
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'), paperRuntimeFactory: factory });
    try {
      const id = await saveStrategy(app);
      const responses = await Promise.all(Array.from({ length: MAX_RUNS + 1 },
        () => app.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch(id) })));
      expect(responses.map((response) => response.statusCode).sort()).toEqual([...Array(MAX_RUNS).fill(201), 409]);
      expect(start).toHaveBeenCalledTimes(MAX_RUNS);
      expect((await app.inject({ method: 'GET', url: '/api/paper-experiments' })).json().experiments).toHaveLength(MAX_RUNS);
    } finally { await app.close(); }
  });

  it('rejects more than ten markets on either venue at the server boundary', async () => {
    const root = await tempRoot();
    const app = await buildApp({ strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper') });
    try {
      const id = await saveStrategy(app);
      const hyperMarkets = ['BTC', 'ETH', 'HYPE', 'SOL', 'XRP', 'ZEC', 'NEAR', 'UNI', 'PUMP', 'LIT'];
      const invalid = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
        ...launch(id),
        settings: {
          ...settings,
          tracks: [
            ...hyperMarkets.map((market) => ({ venue: 'Hyperliquid', market })),
            { venue: 'Hyperliquid', market: 'BTC' },
            { venue: 'Lighter', market: 'BTC' },
          ],
        },
      } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().kind).toBe('INVALID_PAPER_EXPERIMENT');
      expect(invalid.json().details.some((issue: { message: string }) => issue.message.includes('no more than 10 Hyperliquid'))).toBe(true);
    } finally { await app.close(); }
  });

  it('reads a historical per-track experiment without turning its balances into venue-shared cash', async () => {
    const root = await tempRoot();
    const directory = path.join(root, 'paper');
    const store = new PaperExperimentStoreV1(directory);
    const request = StartPaperExperimentSchema.parse(launch(randomUUID()));
    const { experiment } = store.reserve({
      request,
      strategyName: 'Historical per-track run', source,
    });
    store.setStatus(experiment.id, 'completed');
    store.close();
    const database = new DatabaseSync(path.join(directory, 'experiments.sqlite'));
    const historicalRequest = { ...request, settings: legacySettings };
    database.prepare('UPDATE paper_experiments SET settings_json = ?, request_sha256 = ? WHERE id = ?')
      .run(JSON.stringify(legacySettings), createHash('sha256').update(JSON.stringify(historicalRequest)).digest('hex'), experiment.id);
    database.close();

    const api = await buildApp({ strategyCatalogDir: null, paperExperimentsDir: directory });
    try {
      const response = await api.inject({ method: 'GET', url: `/api/paper-experiments/${experiment.id}` });
      expect(response.statusCode).toBe(200);
      const historical = response.json().experiment;
      expect(historical.accountModel).toBe('legacy_per_track');
      expect(historical.settings).toEqual(legacySettings);
      expect(historical.accounts).toHaveLength(4);
      expect(new Set(historical.tracks.map((track: { accountId: string }) => track.accountId)).size).toBe(4);
      expect(historical.accounts.every((account: { startingCash: number }) => account.startingCash === 10_000)).toBe(true);
    } finally { await api.close(); }
  });

  it('keeps a historical shared V1 experiment readable without allowing a V2 runtime snapshot', async () => {
    const root = await tempRoot();
    const directory = path.join(root, 'paper');
    const store = new PaperExperimentStoreV1(directory);
    const request = StartPaperExperimentSchema.parse(launch(randomUUID()));
    const { experiment } = store.reserve({ request, strategyName: 'Historical shared run', source });
    store.setStatus(experiment.id, 'completed');
    store.close();
    const database = new DatabaseSync(path.join(directory, 'experiments.sqlite'));
    const historicalRequest = { ...request, settings: sharedV1Settings };
    database.prepare('UPDATE paper_experiments SET settings_json = ?, request_sha256 = ? WHERE id = ?')
      .run(JSON.stringify(sharedV1Settings), createHash('sha256').update(JSON.stringify(historicalRequest)).digest('hex'), experiment.id);
    database.close();
    const reopened = new PaperExperimentStoreV1(directory);
    try {
      const historical = reopened.get(experiment.id)!;
      expect(historical.accountModel).toBe('venue_shared_v1');
      expect(historical.accounts).toHaveLength(2);
      expect(new Set(historical.tracks.map((track) => track.accountId)).size).toBe(2);
      expect(() => reopened.snapshot(experiment.id)).toThrow(/Only fee-split venue-shared V2/);
    } finally { reopened.close(); }
  });

  it('rejects a changed saved balance even when the Paper settings JSON remains valid', async () => {
    const root = await tempRoot();
    const directory = path.join(root, 'paper');
    const store = new PaperExperimentStoreV1(directory);
    const { experiment } = store.reserve({
      request: StartPaperExperimentSchema.parse(launch(randomUUID())),
      strategyName: 'Pinned pilot', source,
    });
    store.close();
    const database = new DatabaseSync(path.join(directory, 'experiments.sqlite'));
    database.prepare('UPDATE paper_experiments SET settings_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...settings, capitalPerVenue: 900_000 }), experiment.id);
    database.close();
    const reopened = new PaperExperimentStoreV1(directory);
    try {
      expect(() => reopened.get(experiment.id)).toThrow(/Pinned Paper settings differ/);
    } finally { reopened.close(); }
  });

  it('rejects a market row that differs from the pinned Paper setup', async () => {
    const root = await tempRoot();
    const directory = path.join(root, 'paper');
    const store = new PaperExperimentStoreV1(directory);
    const { experiment } = store.reserve({
      request: StartPaperExperimentSchema.parse(launch(randomUUID())),
      strategyName: 'Pinned pilot', source,
    });
    store.close();
    const database = new DatabaseSync(path.join(directory, 'experiments.sqlite'));
    database.prepare("UPDATE paper_experiment_tracks SET market = 'SOL' WHERE experiment_id = ? AND venue = 'Hyperliquid' AND market = 'HYPE'")
      .run(experiment.id);
    database.close();
    const reopened = new PaperExperimentStoreV1(directory);
    try {
      expect(() => reopened.get(experiment.id)).toThrow(/tracks differ from the pinned/);
    } finally { reopened.close(); }
  });

  it('does not steal a live owner and marks only a proven-dead owner interrupted after restart', async () => {
    const root = await tempRoot();
    const directory = path.join(root, 'paper');
    const strategyId = randomUUID();
    const request = StartPaperExperimentSchema.parse(launch(strategyId));
    const first = new PaperExperimentStoreV1(directory);
    const { experiment } = first.reserve({ request, strategyName: 'Pilot', source });
    first.updateTrack(experiment.id, experiment.tracks[0]!.trackId, { status: 'running', events: 9 });
    first.setStatus(experiment.id, 'running');
    first.close();

    const sameProcess = new PaperExperimentStoreV1(directory);
    expect(() => sameProcess.reconcileAfterRestart()).toThrow(PaperExperimentStoreError);
    expect(sameProcess.get(experiment.id)?.status).toBe('running');
    sameProcess.close();

    const liveObserver = await buildApp({ strategyCatalogDir: null, paperExperimentsDir: directory });
    try {
      const detail = await liveObserver.inject({ method: 'GET', url: `/api/paper-experiments/${experiment.id}` });
      expect(detail.json().experiment.status).toBe('running');
      const capability = await liveObserver.inject({ method: 'GET', url: '/api/paper/capabilities' });
      expect(capability.json()).toMatchObject({ available: false });
      expect(capability.json().reason).toMatch(/active Paper experiment|active experiment/);
    } finally { await liveObserver.close(); }

    const database = new DatabaseSync(path.join(directory, 'experiments.sqlite'));
    database.prepare('UPDATE paper_experiments SET owner_pid = ? WHERE id = ?').run(999_999_999, experiment.id);
    database.close();
    const readOnlyApi = await buildApp({ strategyCatalogDir: null, paperExperimentsDir: directory });
    try {
      const response = await readOnlyApi.inject({ method: 'GET', url: `/api/paper-experiments/${experiment.id}` });
      expect(response.statusCode).toBe(200);
      const interrupted = response.json().experiment;
      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.reason).toMatch(/ambiguous market events/);
      expect(interrupted.tracks[0]).toMatchObject({ status: 'interrupted', events: 9 });
      expect(interrupted.endedAt).not.toBeNull();
    } finally { await readOnlyApi.close(); }
  });

  it('keeps the original stop failure visible after a proven-dead owner is interrupted', async () => {
    const root = await tempRoot();
    const directory = path.join(root, 'paper');
    const store = new PaperExperimentStoreV1(directory);
    const { experiment } = store.reserve({
      request: StartPaperExperimentSchema.parse(launch(randomUUID())),
      strategyName: 'Pilot', source,
    });
    const failedTrack = experiment.tracks.find((track) => track.venue === 'Lighter')!;
    const trackFailure = 'Independent Lighter price source became stale.';
    const stopFailure = 'Paper runtime stop failed after the stale price source.';
    store.updateTrack(experiment.id, failedTrack.trackId, {
      status: 'stopping', reason: trackFailure, events: 17,
    });
    store.setStatus(experiment.id, 'stopping', stopFailure);
    store.close();

    const database = new DatabaseSync(path.join(directory, 'experiments.sqlite'));
    database.prepare('UPDATE paper_experiments SET owner_pid = ? WHERE id = ?')
      .run(999_999_999, experiment.id);
    database.close();

    const restarted = new PaperExperimentStoreV1(directory);
    try {
      restarted.reconcileAfterRestart();
      const interrupted = restarted.get(experiment.id)!;
      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.reason).toBe(`${stopFailure} Paper controller process ended; ambiguous market events cannot be replayed.`);
      expect(interrupted.tracks.find((track) => track.trackId === failedTrack.trackId)).toMatchObject({
        status: 'interrupted', events: 17,
        reason: `${trackFailure} Paper controller process ended; ambiguous market events cannot be replayed.`,
      });
      expect(interrupted.tracks.find((track) => track.trackId !== failedTrack.trackId)?.reason)
        .toBe('Paper controller process ended; ambiguous market events cannot be replayed.');
      expect(restarted.activeExperimentId()).toBeNull();

      restarted.reconcileAfterRestart();
      expect(restarted.get(experiment.id)?.reason).toBe(interrupted.reason);
    } finally { restarted.close(); }
  });
});
