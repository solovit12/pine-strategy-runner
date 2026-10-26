import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../apps/api/src/server';
import { ENGINE_TOKEN_HEADER, type EngineConnection } from '../apps/api/src/engine-proxy';
import type { PaperExperimentRuntimeFactory, PaperExperimentStopProof } from '../apps/api/src/paper-execution/paper-experiment-controller';

const token = 'e'.repeat(48);
const source = `//@version=5
strategy("Split", overlay=true)
if bar_index == 2
    strategy.entry("Long", strategy.long)
`;
const hash = createHash('sha256').update(source).digest('hex');
const settings = {
  accountModel: 'pine_live_v1', timeframe: '15m',
  tracks: [{ venue: 'Hyperliquid', market: 'HYPE' }, { venue: 'Lighter', market: 'HYPE' }],
  capitalPerVenue: 10_000, orderSizePercent: 10,
  hyperliquidMakerFeePercent: 0.015, hyperliquidTakerFeePercent: 0.045, lighterMakerFeePercent: 0, lighterTakerFeePercent: 0,
};
const backtestSettings = {
  exchange: 'Binance', marketType: 'Perpetual', symbol: 'HYPEUSDT', timeframe: '15m',
  dateRange: { start: '2026-09-01', end: '2026-09-07' },
  initialCapital: 10_000, baseCurrency: 'USDT', defaultOrderSizeValue: 10,
  defaultOrderSizeType: 'percent_of_equity', pyramiding: 1, feeModel: 'manual',
  commissionType: 'percent', commissionValue: 0.045, slippagePercent: 0,
};
const stopProof = {
  outcome: 'interrupted', controlSlotReleaseProven: true, finalVenueDrainProven: false, reason: 'Stopped.',
} as const satisfies PaperExperimentStopProof;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'psr-split-'));
  directories.push(root);
  const start = vi.fn(async () => ({ stop: async () => stopProof }));
  const factory: PaperExperimentRuntimeFactory = { preflight: async () => undefined, abortStart: async () => stopProof, start };
  const shared = { strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'),
    paperRunsDir: path.join(root, 'runs') };
  const engineApp = await buildApp({ ...shared, role: 'engine', engineToken: token, paperRuntimeFactory: factory });
  let engineUp = true;
  // The site reaches the engine through injected HTTP; no network port is opened.
  const engine: EngineConnection = {
    url: 'http://127.0.0.1:8788', token,
    fetch: async (input, init) => {
      if (!engineUp) throw new TypeError('fetch failed');
      const url = new URL(String(input));
      const result = await engineApp.inject({
        method: (init?.method ?? 'GET') as 'GET', url: url.pathname + url.search,
        headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined,
      });
      return new Response(result.rawPayload, { status: result.statusCode,
        headers: { 'content-type': String(result.headers['content-type'] ?? 'application/json') } });
    },
  };
  const site = () => buildApp({ ...shared, role: 'site', engine });
  return { engineApp, site, start, stopEngine: () => { engineUp = false; } };
}

describe('Paper engine and site as separate processes', () => {
  it('lets only the site call the engine, and the engine serves only Paper', async () => {
    const { engineApp } = await setup();
    try {
      expect((await engineApp.inject({ method: 'GET', url: '/api/paper/capabilities' })).statusCode).toBe(401);
      expect((await engineApp.inject({ method: 'GET', url: '/api/paper/capabilities',
        headers: { [ENGINE_TOKEN_HEADER]: 'x'.repeat(48) } })).statusCode).toBe(401);
      const allowed = await engineApp.inject({ method: 'GET', url: '/api/paper/capabilities', headers: { [ENGINE_TOKEN_HEADER]: token } });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().available).toBe(true);
      const library = await engineApp.inject({ method: 'GET', url: '/api/strategies', headers: { [ENGINE_TOKEN_HEADER]: token } });
      expect(library.statusCode).toBe(404);
    } finally { await engineApp.close(); }
  });

  it('launches through the site, and a site restart leaves the run with the engine', async () => {
    const { engineApp, site, start } = await setup();
    try {
      const first = await site();
      const saved = await first.inject({ method: 'POST', url: '/api/strategies', payload: {
        name: 'Split', source, backtestSettings, paperSettings: settings } });
      expect(saved.statusCode, saved.body).toBe(201);
      const strategyId = saved.json().strategy.id as string;
      const launch = { strategyId, version: 1, sourceSha256: hash, settings, idempotencyKey: randomUUID() };
      const foreign = await first.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch,
        headers: { origin: 'https://other.example' } });
      expect(foreign.statusCode).toBe(403);
      expect(start).not.toHaveBeenCalled();
      const started = await first.inject({ method: 'POST', url: '/api/paper-experiments', payload: launch });
      expect(started.statusCode, started.body).toBe(201);
      const id = started.json().experiment.id as string;
      expect(start).toHaveBeenCalledTimes(1);
      const health = (await first.inject({ method: 'GET', url: '/api/health' })).json();
      expect(health).toMatchObject({ role: 'site', mode: 'backtest-and-paper', paper: { configured: true, acceptingNewRun: true } });
      await first.close(); // the site restarts; the engine keeps the run

      const second = await site();
      try {
        const detail = await second.inject({ method: 'GET', url: `/api/paper-experiments/${id}` });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().experiment.status).toBe('waiting_for_data');
        const stopped = await second.inject({ method: 'POST', url: `/api/paper-experiments/${id}/stop` });
        expect(stopped.statusCode, stopped.body).toBe(200);
        expect(stopped.json().experiment.status).toBe('interrupted');
      } finally { await second.close(); }
    } finally { await engineApp.close(); }
  });

  it('saves a Backtest draft without Paper markets but launches only with markets', async () => {
    const { engineApp, site, start } = await setup();
    const app = await site();
    try {
      const draft = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        name: 'Draft', source, backtestSettings, paperSettings: { ...settings, tracks: [] } } });
      expect(draft.statusCode, draft.body).toBe(201);
      const launch = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
        strategyId: draft.json().strategy.id, version: 1, sourceSha256: hash,
        settings: { ...settings, tracks: [] }, idempotencyKey: randomUUID() } });
      expect(launch.statusCode).toBe(400);
      expect(JSON.stringify(launch.json().details)).toContain('Choose at least one market.');
      expect(start).not.toHaveBeenCalled();
    } finally { await app.close(); await engineApp.close(); }
  });

  it('keeps backtests and the library usable while the engine is down', async () => {
    const { engineApp, site, stopEngine } = await setup();
    const app = await site();
    try {
      stopEngine();
      const capabilities = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.json()).toMatchObject({ available: false, reason: expect.stringMatching(/engine is not running/) });
      const runs = await app.inject({ method: 'GET', url: '/api/paper-experiments' });
      expect(runs.statusCode).toBe(503);
      expect(runs.json().kind).toBe('PAPER_ENGINE_UNAVAILABLE');
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ role: 'site', mode: 'backtest-only' });
      expect((await app.inject({ method: 'GET', url: '/api/strategies' })).statusCode).toBe(200);
    } finally { await app.close(); await engineApp.close(); }
  });
});
