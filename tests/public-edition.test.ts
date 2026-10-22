import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../apps/api/src/server';
import type { PaperExperimentStopProof } from '../apps/api/src/paper-execution/paper-experiment-controller';
import { EDITION, pythonStrategiesAvailable } from '../packages/shared/src/edition';

const stopProof = {
  outcome: 'interrupted', controlSlotReleaseProven: true, finalVenueDrainProven: false, reason: 'test',
} as const satisfies PaperExperimentStopProof;
const pythonSource = 'psr-python-strategy:examples/ema_cross:EmaCross';
const pythonSettings = {
  accountModel: 'python_live_v1' as const, strategyRef: 'examples/ema_cross:EmaCross', params: {},
  timeframe: '1m' as const, tracks: [{ venue: 'Lighter' as const, market: 'SOL' }],
  capitalPerVenue: 10_000, orderSizePercent: 10,
  lighterMakerFeePercent: 0, lighterTakerFeePercent: 0.05,
  hyperliquidMakerFeePercent: 0, hyperliquidTakerFeePercent: 0.05,
};
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('public edition', () => {
  it('runs the user\'s Python strategies in both editions', () => {
    expect(['full', 'public']).toContain(EDITION);
    expect(pythonStrategiesAvailable('full')).toBe(true);
    expect(pythonStrategiesAvailable('public')).toBe(true);
  });

  it('lists nothing without a strategy folder and launches a saved Python strategy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'psr-public-edition-'));
    directories.push(root);
    const preflight = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({ stop: async () => stopProof }));
    const app = await buildApp({
      strategyCatalogDir: path.join(root, 'catalog'), paperExperimentsDir: path.join(root, 'paper'),
      paperRuntimeFactory: { preflight, start, abortStart: async () => stopProof }, edition: 'public',
    });
    try {
      const listed = await app.inject({ method: 'GET', url: '/api/python-strategies' });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({ strategies: [], errors: [], packsConfigured: 0 });
      const saved = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        name: 'EMA Cross', source: pythonSource, backtestSettings: {}, paperSettings: pythonSettings } });
      expect(saved.statusCode, saved.body).toBe(201);
      const launch = await app.inject({ method: 'POST', url: '/api/paper-experiments', payload: {
        strategyId: saved.json().strategy.id, version: 1,
        sourceSha256: createHash('sha256').update(pythonSource).digest('hex'),
        settings: pythonSettings, idempotencyKey: randomUUID() } });
      expect(launch.statusCode, launch.body).toBe(201);
      expect(preflight).toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
