import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../apps/api/src/server';
import { PAPER_CATALOG_MARKETS } from '../packages/shared/src/strategy-catalog-contracts';

const source = `//@version=6
strategy("Range levels", overlay=true)
if bar_index == 2
    strategy.entry("Long", strategy.long)
`;

const backtestSettings = {
  exchange: 'Binance',
  marketType: 'Perpetual',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  dateRange: { start: '2026-09-01', end: '2026-09-07' },
  initialCapital: 10_000,
  baseCurrency: 'USDT',
  defaultOrderSizeValue: 0.01,
  defaultOrderSizeType: 'fixed',
  pyramiding: 0,
  feeModel: 'manual',
  commissionType: 'percent',
  commissionValue: 0,
  slippageTicks: 0,
};

const paperSettings = {
  timeframe: '1h',
  tracks: PAPER_CATALOG_MARKETS.slice(0, 10).flatMap((market) => [
    { venue: 'Hyperliquid', market },
    { venue: 'Lighter', market },
  ]),
  capitalPerTrack: 10_000,
  targetOrderValue: 500,
  hyperliquidFeePercent: null,
  lighterFeePercent: null,
};

function payload() {
  return {
    name: 'Range levels pilot',
    source,
    backtestSettings,
    paperSettings,
    metadata: {
      description: 'Trusted source strategy adapted for historical comparison.',
      origin: 'imported-paper-bot / range_v2',
      fidelity: 'single-market historical approximation',
    },
  };
}

const tempDirs: string[] = [];
async function tempCatalogDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pine-strategy-catalog-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('strategy catalog API', () => {
  it('keeps names unique and deletes a strategy for good', async () => {
    const app = await buildApp({ strategyCatalogDir: await tempCatalogDir() });
    try {
      const first = await app.inject({ method: 'POST', url: '/api/strategies', payload: payload() });
      expect(first.statusCode, first.body).toBe(201);
      const twin = await app.inject({ method: 'POST', url: '/api/strategies', payload: { ...payload(), name: '  range LEVELS pilot ' } });
      expect(twin.statusCode).toBe(409);
      expect(twin.json()).toMatchObject({ kind: 'NAME_TAKEN' });
      const other = await app.inject({ method: 'POST', url: '/api/strategies', payload: { ...payload(), name: 'Other' } });
      expect(other.statusCode, other.body).toBe(201);
      const renameClash = await app.inject({ method: 'POST', url: `/api/strategies/${other.json().strategy.id}/versions`, payload: {
        ...payload(), expectedVersion: 1 } });
      expect(renameClash.statusCode).toBe(409);
      expect(renameClash.json().kind).toBe('NAME_TAKEN');
      const resave = await app.inject({ method: 'POST', url: `/api/strategies/${first.json().strategy.id}/versions`, payload: {
        ...payload(), expectedVersion: 1 } });
      expect(resave.statusCode, resave.body).toBe(201);

      const id = first.json().strategy.id as string;
      const crossSite = await app.inject({ method: 'DELETE', url: `/api/strategies/${id}`, headers: { origin: 'https://evil.example', host: 'localhost' } });
      expect(crossSite.statusCode).toBe(403);
      const deleted = await app.inject({ method: 'DELETE', url: `/api/strategies/${id}` });
      expect(deleted.statusCode).toBe(204);
      expect((await app.inject({ method: 'GET', url: `/api/strategies/${id}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/strategies' })).json().strategies.map((item: { name: string }) => item.name)).toEqual(['Other']);
      expect((await app.inject({ method: 'DELETE', url: `/api/strategies/${id}` })).statusCode).toBe(404);
      const reuse = await app.inject({ method: 'POST', url: '/api/strategies', payload: payload() });
      expect(reuse.statusCode, reuse.body).toBe(201);
    } finally { await app.close(); }
  });

  it('keeps code and both settings drafts through server restart; saving replaces the stored copy', async () => {
    const strategyCatalogDir = await tempCatalogDir();
    const app = await buildApp({ strategyCatalogDir });
    let id = '';
    try {
      const created = await app.inject({ method: 'POST', url: '/api/strategies', payload: payload() });
      expect(created.statusCode, created.body).toBe(201);
      const first = created.json();
      id = first.strategy.id;
      expect(first.strategy.currentVersion).toBe(1);
      expect(first.version.source).toBe(source);
      expect(first.version.paperSettings.tracks).toHaveLength(20);
      expect(first.version.paperSettings.hyperliquidFeePercent).toBeNull();
      expect(first.version.metadata.origin).toContain('range_v2');
      expect(first.version.backtestSettings).not.toHaveProperty('source');

      const secondSource = `${source}\n// refined setting\n`;
      const second = await app.inject({ method: 'POST', url: `/api/strategies/${id}/versions`, payload: {
        ...payload(),
        source: secondSource,
        expectedVersion: 1,
        paperSettings: { ...paperSettings, targetOrderValue: 300 },
      } });
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json().strategy.currentVersion).toBe(2);
      const firstAfterSave = await app.inject({ method: 'GET', url: `/api/strategies/${id}/versions/1` });
      expect(firstAfterSave.statusCode).toBe(404);
    } finally {
      await app.close();
    }

    const reopened = await buildApp({ strategyCatalogDir });
    try {
      const list = await reopened.inject({ method: 'GET', url: '/api/strategies' });
      expect(list.statusCode).toBe(200);
      expect(list.json().strategies).toHaveLength(1);
      const current = await reopened.inject({ method: 'GET', url: `/api/strategies/${id}` });
      expect(current.statusCode).toBe(200);
      expect(current.json().version.version).toBe(2);
      expect(current.json().version.paperSettings.targetOrderValue).toBe(300);
      const history = await reopened.inject({ method: 'GET', url: `/api/strategies/${id}/versions` });
      expect(history.json().versions.map((version: { version: number }) => version.version)).toEqual([2]);
    } finally {
      await reopened.close();
    }
  });

  it('rejects invalid Pine, malformed settings, and stale revisions without changing the saved version', async () => {
    const app = await buildApp({ strategyCatalogDir: await tempCatalogDir() });
    try {
      const missingStrategy = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        ...payload(), source: '//@version=6\nindicator("Not a strategy")',
      } });
      expect(missingStrategy.statusCode).toBe(400);
      const invalidCommission = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        ...payload(), backtestSettings: { ...backtestSettings, commissionValue: undefined },
      } });
      expect(invalidCommission.statusCode).toBe(400);
      const duplicateTrack = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        ...payload(), paperSettings: { ...paperSettings, tracks: [paperSettings.tracks[0], paperSettings.tracks[0]] },
      } });
      expect(duplicateTrack.statusCode).toBe(400);
      const oneVenue = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        ...payload(), paperSettings: { ...paperSettings, tracks: paperSettings.tracks.filter((track) => track.venue === 'Lighter') },
      } });
      expect(oneVenue.statusCode).toBe(400);
      const created = await app.inject({ method: 'POST', url: '/api/strategies', payload: payload() });
      expect(created.statusCode).toBe(201);
      const id = created.json().strategy.id;
      const stale = await app.inject({ method: 'POST', url: `/api/strategies/${id}/versions`, payload: {
        ...payload(), expectedVersion: 2,
      } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().kind).toBe('VERSION_CONFLICT');
      const current = await app.inject({ method: 'GET', url: `/api/strategies/${id}` });
      expect(current.json().strategy.currentVersion).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('recognizes a real strategy after apostrophes in comments without trusting strings or comments', async () => {
    const app = await buildApp({ strategyCatalogDir: await tempCatalogDir() });
    try {
      const commentedSource = `//@version=6
// Today's settings don't alter the strategy declaration below.
// strategy("This comment is not code")
strategy("A string may contain // and don't confuse the lexer", overlay=true)
`;
      const created = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        ...payload(), source: commentedSource,
      } });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().version.source).toBe(commentedSource);

      const commentOnly = await app.inject({ method: 'POST', url: '/api/strategies', payload: {
        ...payload(), source: '//@version=6\n// Trader\'s strategy("Only a comment")\nindicator("No real strategy")',
      } });
      expect(commentOnly.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('stays explicitly disabled when no writable catalog directory is configured', async () => {
    const app = await buildApp({ strategyCatalogDir: null });
    try {
      const capabilities = await app.inject({ method: 'GET', url: '/api/strategy-catalog/capabilities' });
      expect(capabilities.json().enabled).toBe(false);
      expect(capabilities.json().paperLaunchEnabled).toBe(false);
      const save = await app.inject({ method: 'POST', url: '/api/strategies', payload: payload() });
      expect(save.statusCode).toBe(503);
      expect(save.json().kind).toBe('STRATEGY_CATALOG_NOT_CONFIGURED');
    } finally {
      await app.close();
    }
  });
});
