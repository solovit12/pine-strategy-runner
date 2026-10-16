import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../apps/api/src/server.js';
import { createPinePaperFactory, liveStopReason } from '../apps/api/src/paper-execution/pine-paper-factory.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveStopOutcome } from '../apps/web/src/components/PaperRuns.js';
import type { VenueMarket } from '../apps/api/src/paper-execution/venue-markets.js';
import type { Candle } from '../packages/shared/src/contracts.js';

/** Live launch from the site (full edition): settings, engine switch, config handed to the engine. */
const root = path.resolve(import.meta.dirname, '..');
const python = path.join(root, '.local/nautilus-hl-fast5-20261001/.venv/bin/python');
const MINUTE = 60_000;
const source = `//@version=5
strategy("Live launch", overlay=true)
if strategy.position_size == 0
    strategy.entry("L", strategy.long)
`;
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const live = { dailyLossLimitPercent: 10, maxLeverage: 2, exchangeStopPercent: 0.5, exchangeStopFrom: 'strategy_stop' as const,
  maxSlippagePercent: 3, maxPositionUsdc: 13, minimumOrderSize: true };
const liveSettings = {
  accountModel: 'pine_live_v1' as const, timeframe: '1m' as const,
  tracks: [{ venue: 'Lighter' as const, market: 'SOL' }],
  capitalPerVenue: 10_000, orderSizePercent: 10,
  lighterMakerFeePercent: 0, lighterTakerFeePercent: 0,
  hyperliquidMakerFeePercent: 0.015, hyperliquidTakerFeePercent: 0.045,
  live,
};
const backtestSettings = {
  exchange: 'Hyperliquid', marketType: 'Perpetual', symbol: 'SOL', timeframe: '1m',
  dateRange: { start: '2026-09-01', end: '2026-09-02' }, initialCapital: 10_000, baseCurrency: 'USDC',
  defaultOrderSizeValue: 10, defaultOrderSizeType: 'percent_of_equity', pyramiding: 1,
  feeModel: 'manual', commissionType: 'percent', commissionValue: 0, slippageTicks: 0,
};
const sol: VenueMarket = { venue: 'lighter', market: 'SOL', marketId: '2', sizeStep: 0.001, minBaseQuantity: 0.001,
  minQuote: 10, priceStep: 0.01, maxPriceDecimals: 2, feeMultiplier: 1 };

function flat(fromMs: number, toMs: number): Candle[] {
  const result: Candle[] = [];
  const end = Math.min(toMs, Math.floor(Date.now() / MINUTE) * MINUTE);
  for (let open = Math.ceil(fromMs / MINUTE) * MINUTE; open < end; open += MINUTE) {
    result.push({ openTime: open, open: 100, high: 100.05, low: 99.95, close: 100, volume: 1, closeTime: open + MINUTE - 1,
      quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0 });
  }
  return result;
}

const temporary: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  delete process.env.PSR_LIVE_ENABLED;
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function events(runDir: string): Array<Record<string, any>> {
  const file = path.join(runDir, 'nautilus.sqlite');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT payload_json FROM nautilus_records ORDER BY seq').all() as { payload_json: string }[])
      .map(row => JSON.parse(row.payload_json));
  } finally { db.close(); }
}

async function until(label: string, check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function setup(spawnChild?: (configPath: string) => ChildProcessWithoutNullStreams) {
  const directory = mkdtempSync(path.join(tmpdir(), 'live-launch-'));
  temporary.push(directory);
  const catalogDir = path.join(directory, 'catalog');
  const runtimeDir = path.join(directory, 'runs');
  // LIVE needs a connected account: a stand-in key (never a real one) saved the way the setup page saves it.
  const liveSecretsDir = path.join(directory, 'live-secrets');
  if (process.env.PSR_LIVE_ENABLED === '1') {
    mkdirSync(liveSecretsDir, { mode: 0o700 });
    writeFileSync(path.join(liveSecretsDir, 'lighter-mainnet.env'),
      `LIGHTER_ACCOUNT_INDEX=1\nLIGHTER_API_KEY_INDEX=4\nLIGHTER_API_SECRET=${'ab'.repeat(40)}\n`, { mode: 0o600 });
  }
  const factory = createPinePaperFactory({ projectRoot: root, catalogDir, runtimeDir, pythonPath: python,
    liveTrading: process.env.PSR_LIVE_ENABLED === '1', dependencies: {
      checkRuntime: async () => {}, stopGraceMs: 30_000, catalog: async () => [sol],
      candles: async (_market, _settings, fromMs, toMs) => flat(fromMs, toMs),
      ...(spawnChild ? { spawn: spawnChild } : {}),
    } });
  const app = await buildApp({ strategyCatalogDir: catalogDir, paperExperimentsDir: path.join(directory, 'control'),
    paperRunsDir: runtimeDir, paperRuntimeFactory: factory, edition: 'full', liveSecretsDir, liveServerSecretsDir: null });
  apps.push(app);
  const saved = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
    name: 'Live launch', source, backtestSettings, paperSettings: liveSettings } });
  expect(saved.statusCode, saved.body).toBe(201);
  const start = () => app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
    strategyId: saved.json().strategy.id, version: 1, sourceSha256, settings: liveSettings, idempotencyKey: randomUUID() } });
  return { app, runtimeDir, start };
}

describe('Live stop outcome', () => {
  const closed = 'LIVE: every position of this run is closed on Lighter';
  const open = 'LIVE: positions still open on Lighter after the stop: SOL 5 (no exchange-side stop) — close them in the Lighter app';

  it("takes the engine's own outcome into the final reason", () => {
    expect(liveStopReason(null, `user; ${closed}`)).toBe(`Stopped by user. ${closed}`);
    expect(liveStopReason(null, `user; ${open}`)).toBe(`Stopped by user. ${open}`);
    expect(liveStopReason(null, null)).toBe('Stopped by user. LIVE: the engine did not confirm how the closes ended; check the positions in the Lighter app.');
    // An engine halt already carries the outcome in its own reason: not repeated.
    const halt = `LIVE halt: daily loss limit reached; ${open}`;
    expect(liveStopReason(halt, halt)).toBe(halt);
    expect(liveStopReason('No Nautilus heartbeat for 60 seconds.', null)).toMatch(/^No Nautilus heartbeat.*did not confirm/);
  });

  it('shows on the run page whether every position is closed', () => {
    const page = (reason: string) => renderToStaticMarkup(createElement(LiveStopOutcome,
      { detail: { live: true, status: 'interrupted', reason } }));
    expect(page(`Stopped by user. ${closed}`)).toContain('Every position of this run is closed on Lighter.');
    const left = page(`Stopped by user. ${open}`);
    expect(left).toContain('Positions may still be open on Lighter.');
    expect(left).toContain('SOL 5');
    expect(page('Stopped by user. LIVE: the engine did not confirm how the closes ended; check the positions in the Lighter app.'))
      .toContain('Positions may still be open on Lighter.');
    expect(renderToStaticMarkup(createElement(LiveStopOutcome, { detail: { live: true, status: 'running', reason: null } }))).toBe('');
  });
});

describe('Live launch', () => {
  it('refuses Hyperliquid markets in Live settings', async () => {
    const { app } = await setup();
    const saved = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
      name: 'Live HL', source, backtestSettings,
      paperSettings: { ...liveSettings, tracks: [{ venue: 'Hyperliquid', market: 'SOL' }] } } });
    expect(saved.statusCode).toBe(400);
    expect(saved.body).toContain('Live trading supports Lighter markets only.');
  });

  it('is off until a Lighter account is connected', async () => {
    const { app, start } = await setup();
    const capabilities = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
    expect(capabilities.json().liveTrading).toBe(false);
    const started = await start();
    expect(started.statusCode).toBe(422);
    expect(started.json().error).toBe('Live trading is not enabled on this engine.');
  });

  it.skipIf(!existsSync(python))('hands the limits to the engine, labels the run and closes it on Stop', async () => {
    process.env.PSR_LIVE_ENABLED = '1';
    let child: ChildProcessWithoutNullStreams | null = null;
    let handed: Record<string, unknown> | null = null;
    const { app, runtimeDir, start } = await setup((configPath) => {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      handed = config.live;
      // Offline: the same Live code path against the stand-in exchange.
      const offline = `${configPath}.offline.json`;
      writeFileSync(offline, JSON.stringify({ ...config, mode: 'offline', live: { ...config.live, exchange: 'sandbox' } }));
      child = spawn(python, [path.join(root, 'apps/nautilus-paper/runtime.py'), '--config', offline], { stdio: ['pipe', 'pipe', 'pipe'] });
      return child;
    });
    const capabilities = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
    expect(capabilities.json().liveTrading).toBe(true);
    const started = await start();
    expect(started.statusCode, started.body).toBe(201);
    const id = started.json().experiment.id as string;
    expect(started.json().experiment.live).toBe(true);
    const runDir = path.join(runtimeDir, id);
    await until('clean Live start', () => events(runDir).some(e => e.type === 'event'
      && String(e.message).startsWith('LIVE run on Lighter mainnet: account clean')), 30_000);
    expect(handed).toEqual({ exchange: 'lighter', dailyLossLimitPercent: '10', maxLeverage: '2', exchangeStopPercent: '0.5',
      exchangeStopFrom: 'strategy_stop', maxSlippagePercent: '3', maxPositionUsdc: '13', minimumOrderSize: true, stateFile: path.join(runtimeDir, 'live-daily-reference.json') });
    const listed = await app.inject({ method: 'GET', url: '/api/paper-experiments' });
    expect(listed.json().experiments[0].live).toBe(true);

    // One Live run at a time: a second one would share the Lighter account and API key.
    expect((await app.inject({ method: 'GET', url: '/api/paper/capabilities' })).json().liveActive).toBe(true);
    const second = await start();
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('A LIVE run is already active. Stop it before starting another LIVE run.');

    const stopped = await app.inject({ method: 'POST', url: `/api/paper-experiments/${id}/stop` });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/paper/capabilities' })).json().liveActive).toBe(false);
    const final = (await app.inject({ method: 'GET', url: `/api/paper-experiments/${id}` })).json().experiment;
    expect(final.reason).toBe('Stopped by user. LIVE: every position of this run is closed on Lighter');
    expect(events(runDir).filter(e => e.type === 'failure')).toEqual([]);
    expect(events(runDir).some(e => e.type === 'phase' && e.stage === 'stopping'
      && String(e.message).includes('LIVE: closing every position on Lighter at market'))).toBe(true);
  }, 90_000);
});
