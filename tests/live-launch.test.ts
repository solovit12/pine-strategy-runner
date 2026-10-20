import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../apps/api/src/server.js';
import { createPinePaperFactory, liveStopReason } from '../apps/api/src/paper-execution/pine-paper-factory.js';
import { LiveSettingsStore } from '../apps/api/src/live-settings.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveStopOutcome } from '../apps/web/src/components/PaperRuns.js';
import type { VenueMarket } from '../apps/api/src/paper-execution/venue-markets.js';
import type { Candle } from '../packages/shared/src/contracts.js';

/** Live launch from the site (full edition): settings, engine switch, config handed to the engine. */
const root = path.resolve(import.meta.dirname, '..');
const python = path.join(root, '.local/nautilus-hl-fast5-rc7-20261018/.venv/bin/python');
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
  // LIVE trades the accounts added on the Accounts page; the engine reads each account's key file.
  const liveSecretsDir = path.join(directory, 'live-secrets');
  const accounts = new LiveSettingsStore(liveSecretsDir, null, {});
  const factory = createPinePaperFactory({ projectRoot: root, catalogDir, runtimeDir, pythonPath: python,
    liveTrading: process.env.PSR_LIVE_ENABLED === '1',
    liveAccount: (id, exchange) => accounts.accountForRun(id, exchange), dependencies: {
      checkRuntime: async () => {}, stopGraceMs: 30_000, catalog: async () => [sol],
      candles: async (_market, _settings, fromMs, toMs) => flat(fromMs, toMs),
      ...(spawnChild ? { spawn: spawnChild } : {}),
    } });
  const app = await buildApp({ strategyCatalogDir: catalogDir, paperExperimentsDir: path.join(directory, 'control'),
    paperRunsDir: runtimeDir, paperRuntimeFactory: factory, edition: 'full', liveSecretsDir, liveServerSecretsDir: null });
  apps.push(app);
  /** A Lighter account as the Accounts page adds it: a stand-in key, never a real one. */
  const addLighter = async (name: string, accountIndex: number) => {
    const created = await app.inject({ method: 'POST', url: '/api/live/accounts', payload: {
      exchange: 'lighter', name, enabled: true, accountIndex, apiKeyIndex: 4, apiKey: 'ab'.repeat(40) } });
    expect(created.statusCode, created.body).toBe(200);
    return created.json().account.id as string;
  };
  /** Saves the strategy with these settings and starts it. */
  const launch = async (settings: Record<string, unknown>) => {
    const saved = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
      name: `Live ${randomUUID().slice(0, 8)}`, source, backtestSettings, paperSettings: settings } });
    expect(saved.statusCode, saved.body).toBe(201);
    return app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
      strategyId: saved.json().strategy.id, version: 1, sourceSha256, settings, idempotencyKey: randomUUID() } });
  };
  return { app, runtimeDir, liveSecretsDir, addLighter, launch };
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
  it('starts Live only with a chosen, switched-on account for every exchange of the run', async () => {
    process.env.PSR_LIVE_ENABLED = '1';
    const { addLighter, launch } = await setup();
    const main = await addLighter('Main', 1); // a Lighter account; no Hyperliquid one
    const both = [{ venue: 'Lighter', market: 'SOL' }, { venue: 'Hyperliquid', market: 'SOL' }];
    const started = await launch({ ...liveSettings, tracks: both, live: { ...live, accounts: { lighter: main } } });
    expect(started.statusCode, started.body).not.toBe(201);
    expect(started.body).toContain('Choose the Hyperliquid account for this LIVE run');
    const unnamed = await launch({ ...liveSettings, live });
    expect(unnamed.body).toContain('Choose the Lighter account for this LIVE run');
  });

  it('is off until an account is added', async () => {
    const { app, launch } = await setup();
    const capabilities = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
    expect(capabilities.json().liveTrading).toBe(false);
    const started = await launch(liveSettings);
    expect(started.statusCode).toBe(422);
    expect(started.json().error).toBe('Live trading is not enabled on this engine.');
  });

  it.skipIf(!existsSync(python))('hands the account and limits to the engine, keeps one account in one run, closes on Stop', async () => {
    process.env.PSR_LIVE_ENABLED = '1';
    const children: ChildProcessWithoutNullStreams[] = [];
    const handed: Array<Record<string, unknown>> = [];
    const { app, runtimeDir, liveSecretsDir, addLighter, launch } = await setup((configPath) => {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      handed.push(config.live);
      // Offline: the same Live code path against the stand-in exchange.
      const offline = `${configPath}.offline.json`;
      writeFileSync(offline, JSON.stringify({ ...config, mode: 'offline', live: { ...config.live, exchange: 'sandbox' } }));
      const child = spawn(python, [path.join(root, 'apps/nautilus-paper/runtime.py'), '--config', offline], { stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      return child;
    });
    const main = await addLighter('Main', 1);
    const sub = await addLighter('Sub', 2);
    const capabilities = await app.inject({ method: 'GET', url: '/api/paper/capabilities' });
    expect(capabilities.json()).toMatchObject({ liveTrading: true, liveExchanges: ['lighter'] });
    const settings = { ...liveSettings, live: { ...live, accounts: { lighter: main } } };
    const started = await launch(settings);
    expect(started.statusCode, started.body).toBe(201);
    const id = started.json().experiment.id as string;
    expect(started.json().experiment.live).toBe(true);
    const runDir = path.join(runtimeDir, id);
    await until('clean Live start', () => events(runDir).some(e => e.type === 'event'
      && String(e.message).startsWith('LIVE run on Lighter mainnet (account "Main"): account clean')), 30_000);
    expect(handed[0]).toEqual({ exchange: 'real',
      accounts: { lighter: { id: main, name: 'Main', file: path.join(liveSecretsDir, 'accounts', `${main}.env`) } },
      dailyLossLimitPercent: '10', maxLeverage: '2', exchangeStopPercent: '0.5',
      exchangeStopFrom: 'strategy_stop', maxSlippagePercent: '3', maxPositionUsdc: '13', minimumOrderSize: true,
      stateFile: path.join(runtimeDir, 'live-daily-reference.json') });
    expect(JSON.stringify(handed[0])).not.toContain('ab'.repeat(20)); // the key itself never goes into a config
    const listed = await app.inject({ method: 'GET', url: '/api/paper-experiments' });
    expect(listed.json().experiments[0].live).toBe(true);
    const accountsNow = async () => (await app.inject({ method: 'GET', url: '/api/live/accounts' })).json().accounts
      .map((account: { name: string; runId: string | null }) => [account.name, account.runId]);
    expect(await accountsNow()).toEqual([['Main', id], ['Sub', null]]);

    // One account trades in one run at a time; another account starts its own Live run.
    const second = await launch(settings);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('The account "Main" is trading in another LIVE run. Choose another account or stop that run first.');
    const other = await launch({ ...liveSettings, live: { ...live, accounts: { lighter: sub } } });
    expect(other.statusCode, other.body).toBe(201);
    const otherId = other.json().experiment.id as string;
    expect(await accountsNow()).toEqual([['Main', id], ['Sub', otherId]]);

    for (const run of [otherId, id]) {
      const stopped = await app.inject({ method: 'POST', url: `/api/paper-experiments/${run}/stop` });
      expect(stopped.statusCode, stopped.body).toBe(200);
    }
    expect(await accountsNow()).toEqual([['Main', null], ['Sub', null]]);
    const final = (await app.inject({ method: 'GET', url: `/api/paper-experiments/${id}` })).json().experiment;
    expect(final.reason).toBe('Stopped by user. LIVE: every position of this run is closed on Lighter');
    expect(events(runDir).filter(e => e.type === 'failure')).toEqual([]);
    expect(events(runDir).some(e => e.type === 'phase' && e.stage === 'stopping'
      && String(e.message).includes('LIVE: closing every position of this run at market'))).toBe(true);
  }, 120_000);
});
