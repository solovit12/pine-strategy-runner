import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../apps/api/src/server.js';
import { createPinePaperFactory } from '../apps/api/src/paper-execution/pine-paper-factory.js';
import type { VenueMarket } from '../apps/api/src/paper-execution/venue-markets.js';
import type { Candle } from '../packages/shared/src/contracts.js';

const root = path.resolve(import.meta.dirname, '..');
const python = path.join(root, '.local/nautilus-hl-fast5-20261001/.venv/bin/python');
const MINUTE = 60_000;
const source = `//@version=5
strategy("Pine live e2e", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=10)
if strategy.position_size == 0
    strategy.entry("L", strategy.long)
strategy.exit("XL", "L", profit=100, loss=100)
`;
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const paperSettings = {
  accountModel: 'pine_live_v1' as const, timeframe: '1m' as const,
  tracks: [{ venue: 'Lighter' as const, market: 'SOL' }],
  capitalPerVenue: 10_000, orderSizePercent: 10,
  lighterMakerFeePercent: 0, lighterTakerFeePercent: 0.05,
  hyperliquidMakerFeePercent: 0, hyperliquidTakerFeePercent: 0.05,
};
const backtestSettings = {
  exchange: 'Hyperliquid', marketType: 'Perpetual', symbol: 'SOL', timeframe: '1m',
  dateRange: { start: '2026-09-01', end: '2026-09-02' }, initialCapital: 10_000, baseCurrency: 'USDC',
  defaultOrderSizeValue: 10, defaultOrderSizeType: 'percent_of_equity', pyramiding: 1,
  feeModel: 'manual', commissionType: 'percent', commissionValue: 0.05, slippageTicks: 0,
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

describe.skipIf(!existsSync(python))('generic Pine Paper in real offline Nautilus Sandbox', () => {
  it('mirrors history as shadow trades, reports a shadow exit and executes the next Pine entry for real', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pine-paper-'));
    temporary.push(directory);
    const catalogDir = path.join(directory, 'catalog');
    const runtimeDir = path.join(directory, 'runs');
    let child: ChildProcessWithoutNullStreams | null = null;
    const factory = createPinePaperFactory({ projectRoot: root, catalogDir, runtimeDir, pythonPath: python, dependencies: {
      checkRuntime: async () => {}, stopGraceMs: 5_000,
      catalog: async () => [sol],
      candles: async (_market, _settings, fromMs, toMs) => flat(fromMs, toMs),
      spawn: (configPath) => {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const offline = `${configPath}.offline.json`;
        writeFileSync(offline, JSON.stringify({ ...config, mode: 'offline' }));
        child = spawn(python, [path.join(root, 'apps/nautilus-paper/runtime.py'), '--config', offline], { stdio: ['pipe', 'pipe', 'pipe'] });
        return child;
      },
    } });
    const app = await buildApp({ strategyCatalogDir: catalogDir, paperExperimentsDir: path.join(directory, 'control'),
      paperRunsDir: runtimeDir, paperRuntimeFactory: factory });
    apps.push(app);
    const saved = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
      name: 'Pine live e2e', source, backtestSettings, paperSettings } });
    expect(saved.statusCode, saved.body).toBe(201);
    const started = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
      strategyId: saved.json().strategy.id, version: 1, sourceSha256, settings: paperSettings, idempotencyKey: randomUUID() } });
    expect(started.statusCode, started.body).toBe(201);
    const id = started.json().experiment.id as string;
    const runDir = path.join(runtimeDir, id);
    const send = (item: object) => child!.stdin.write(JSON.stringify(item) + '\n');
    const prices = (bid: string, ask: string) => send({ cmd: 'frame', venue: 'lighter', market: 'SOL',
      bids: [[bid, '1000.000']], asks: [[ask, '1000.000']] });

    await until('Nautilus child', () => child !== null && events(runDir).some(e => e.type === 'phase'), 30_000);
    await new Promise(resolve => setTimeout(resolve, 800));
    send({ cmd: 'socket', venue: 'lighter', state: 'CONNECTED' });
    prices('100.00', '100.10');
    await until('initial Pine evaluation', () => events(runDir).some(e => e.type === 'pine_bar'), 20_000);
    const first = events(runDir).find(e => e.type === 'pine_bar')!;
    expect(first.openTrades).toBe(1); // opened by the history emulator: shadow only

    // Take-profit of the shadow trade: reported without any Sandbox fill.
    await new Promise(resolve => setTimeout(resolve, 400));
    prices('101.10', '101.20');
    await until('shadow take-profit', () => events(runDir).some(e => e.type === 'pine_fill' && e.orderId === 'XL'), 10_000);
    expect(events(runDir).filter(e => e.type === 'fill')).toHaveLength(0);
    prices('100.00', '100.10');
    // A live venue stream never goes quiet; keep the offline feed current.
    const feed = setInterval(() => prices('100.00', '100.10'), 300);

    // Next closed bar: Pine is flat and enters; the market entry executes for real.
    try {
      await until('real Pine entry', () => events(runDir).some(e => e.type === 'fill' && e.kind === 'entry'), 75_000);
    } catch (error) {
      console.log(JSON.stringify(events(runDir).filter(e => e.type !== 'snapshot' && !(e.type === 'event' && /diagnostic|latency/.test(e.message))).slice(-30), null, 1));
      throw error;
    }
    const entry = events(runDir).find(e => e.type === 'fill' && e.kind === 'entry')!;
    expect(entry.positionSide).toBe('long');
    expect(Number(entry.quantity)).toBeCloseTo(9.99, 3); // 10% of 10 000 USDC at 100.10
    await until('Pine entry report', () => events(runDir).some(e => e.type === 'pine_fill' && e.orderId === 'L'), 5_000);
    const report = events(runDir).find(e => e.type === 'pine_fill' && e.orderId === 'L')!;
    expect(Number(report.price)).toBeCloseTo(100.1, 6);

    clearInterval(feed);
    const stopped = await app.inject({ method: 'POST', url: `/api/paper-experiments/${id}/stop`,
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(events(runDir).filter(e => e.type === 'failure')).toEqual([]);
  }, 150_000);

  it('runs a Python strategy from a private pack in-process: quote-driven entry and take-profit', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'python-paper-'));
    temporary.push(directory);
    const pack = path.join(directory, 'owner_pack');
    mkdirSync(pack);
    writeFileSync(path.join(pack, 'quote_long.py'), [
      'from psr_sdk import Param, Strategy',
      'class QuoteLong(Strategy):',
      '    name = "Quote long"',
      '    timeframe = "1m"',
      '    warmup_bars = 50',
      '    params = {"tp": Param(int, 100, min=1)}',
      '    def on_quote(self, ctx, quote):',
      '        if ctx.position == 0 and not ctx.state.get("done") and not ctx.orders:',
      '            ctx.entry("L", "long")',
      '            ctx.exit("XL", "L", profit_ticks=ctx.params["tp"], loss_ticks=500)',
      '    def on_fill(self, ctx, fill):',
      '        if fill.category == "exit":',
      '            ctx.state["done"] = True',
      '',
    ].join('\n'));
    const catalogDir = path.join(directory, 'catalog');
    const runtimeDir = path.join(directory, 'runs');
    let child: ChildProcessWithoutNullStreams | null = null;
    const factory = createPinePaperFactory({ projectRoot: root, catalogDir, runtimeDir, pythonPath: python, strategyPacks: [pack],
      dependencies: {
        checkRuntime: async () => {}, stopGraceMs: 5_000,
        catalog: async () => [sol],
        candles: async (_market, _settings, fromMs, toMs) => flat(fromMs, toMs),
        spawn: (configPath) => {
          const config = JSON.parse(readFileSync(configPath, 'utf8'));
          const offline = `${configPath}.offline.json`;
          writeFileSync(offline, JSON.stringify({ ...config, mode: 'offline' }));
          child = spawn(python, [path.join(root, 'apps/nautilus-paper/runtime.py'), '--config', offline], { stdio: ['pipe', 'pipe', 'pipe'] });
          return child;
        },
      } });
    const app = await buildApp({ strategyCatalogDir: catalogDir, paperExperimentsDir: path.join(directory, 'control'),
      paperRunsDir: runtimeDir, paperRuntimeFactory: factory, edition: 'full' });
    apps.push(app);
    const listed = await app.inject({ method: 'GET', url: '/api/python-strategies' });
    expect(listed.statusCode, listed.body).toBe(200);
    const pythonSource = 'psr-python-strategy:owner_pack/quote_long:QuoteLong';
    const pythonSettings = { ...paperSettings, accountModel: 'python_live_v1' as const,
      strategyRef: 'owner_pack/quote_long:QuoteLong', params: { tp: 100 } };
    const saved = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
      name: 'Quote long', source: pythonSource, backtestSettings: {}, paperSettings: pythonSettings } });
    expect(saved.statusCode, saved.body).toBe(201);
    const started = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
      strategyId: saved.json().strategy.id, version: 1, sourceSha256: createHash('sha256').update(pythonSource).digest('hex'),
      settings: pythonSettings, idempotencyKey: randomUUID() } });
    expect(started.statusCode, started.body).toBe(201);
    const runDir = path.join(runtimeDir, started.json().experiment.id as string);
    const send = (item: object) => child!.stdin.write(JSON.stringify(item) + '\n');
    const prices = (bid: string, ask: string) => send({ cmd: 'frame', venue: 'lighter', market: 'SOL',
      bids: [[bid, '1000.000']], asks: [[ask, '1000.000']] });
    await until('Nautilus child', () => child !== null && events(runDir).some(e => e.type === 'phase'), 30_000);
    await new Promise(resolve => setTimeout(resolve, 800));
    send({ cmd: 'socket', venue: 'lighter', state: 'CONNECTED' });
    const feed = setInterval(() => prices('100.00', '100.10'), 300);
    try {
      await until('Python entry', () => events(runDir).some(e => e.type === 'fill' && e.kind === 'entry'), 20_000);
      clearInterval(feed);
      await new Promise(resolve => setTimeout(resolve, 300));
      prices('101.20', '101.30');
      await until('take-profit', () => events(runDir).some(e => e.type === 'fill' && e.kind === 'exit'), 10_000);
    } catch (error) {
      console.log(JSON.stringify(events(runDir).filter(e => e.type !== 'snapshot').slice(-20), null, 1));
      throw error;
    } finally { clearInterval(feed); }
    expect(events(runDir).some(e => e.type === 'event' && /Quote long: warmed up on \d+ bars/.test(e.message))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'nautilus-manifest.json'), 'utf8'));
    expect(manifest.pythonStrategy).toMatchObject({ id: 'owner_pack/quote_long:QuoteLong', pack: 'owner_pack', builtin: false });
    const stopped = await app.inject({ method: 'POST', url: `/api/paper-experiments/${started.json().experiment.id}/stop` });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(events(runDir).filter(e => e.type === 'failure')).toEqual([]);
  }, 120_000);
});
