import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readPaperExperimentActivityV1 } from '../apps/api/src/paper-execution/paper-experiment-activity.js';
import { PaperExperimentStoreV1 } from '../apps/api/src/paper-execution/paper-experiment-store.js';
import { buildApp } from '../apps/api/src/server.js';

const roots: string[] = [];
const source = '//@version=6\nstrategy("Activity test")\n';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const settings = {
  accountModel: 'venue_shared_v2' as const, timeframe: '1h' as const,
  tracks: [{ venue: 'Hyperliquid' as const, market: 'HYPE' }, { venue: 'Lighter' as const, market: 'HYPE' }],
  capitalPerVenue: 1_000, orderSizePercentOfRealizedEquity: 10,
  hyperliquidMakerEntryFeePercent: 0.1, hyperliquidTakerExitFeePercent: 0.2,
  lighterMakerEntryFeePercent: 0.1, lighterTakerExitFeePercent: 0.2,
};

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'paper-activity-'));
  roots.push(root);
  const store = new PaperExperimentStoreV1(path.join(root, 'control'), () => Date.UTC(2026, 8, 29, 8));
  const detail = store.reserve({ request: {
    strategyId: randomUUID(), version: 1, sourceSha256: hash(source), settings, idempotencyKey: randomUUID(),
  }, strategyName: 'Activity test', source }).experiment;
  store.close();
  const runs = path.join(root, 'runs');
  const directory = path.join(runs, detail.id);
  mkdirSync(directory, { recursive: true });
  return { root, runs, directory, detail };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Paper activity from durable sources', () => {
  it('shows control milestones only when a run has no Nautilus ledger', () => {
    const { detail, runs, directory } = fixture();
    rmSync(directory, { recursive: true });
    expect(readPaperExperimentActivityV1({ detail, runtimeDirectory: runs }))
      .toMatchObject({ coverage: 'control_only', totalFills: null, fills: [], eventCoverage: 'key_milestones' });
    expect(readPaperExperimentActivityV1({ detail, runtimeDirectory: null }).coverage).toBe('control_only');
  });

  it('does not read retired Broker journals and never invents fills for them', () => {
    const { detail, runs, directory } = fixture();
    writeFileSync(path.join(directory, 'lighter.sqlite'), 'retired journal format');
    writeFileSync(path.join(directory, 'hyperliquid.sqlite'), 'retired journal format');
    const result = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs });
    expect(result).toMatchObject({ coverage: 'control_only', totalFills: null, fills: [], nextFillsCursor: null });
    expect(result.events.map((event) => event.kind)).toEqual(['created']);
  });

  it('rejects an invalid page size', () => {
    const { detail, runs } = fixture();
    expect(() => readPaperExperimentActivityV1({ detail, runtimeDirectory: runs, limit: 101 })).toThrow('between 1 and 100');
  });

  it('serves read-only activity through the API and 404s an unknown run', async () => {
    const { root, detail, runs } = fixture();
    const app = await buildApp({ strategyCatalogDir: null, paperExperimentsDir: path.join(root, 'control'),
      paperRunsDir: runs, paperRuntimeFactory: null });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/paper-experiments/${detail.id}/activity` });
      expect(response.statusCode).toBe(200);
      expect(response.json().activity).toMatchObject({ coverage: 'control_only', totalFills: null });
      const missing = await app.inject({ method: 'GET', url: `/api/paper-experiments/${randomUUID()}/activity` });
      expect(missing.statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
