import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EXCHANGE_LIMITS, forecastRun, limitLevel, loadPercent, runLoadPlan, viewLevel, type ExchangeLoadRow,
} from '../packages/shared/src/exchange-load';
import {
  busiestMinute, ExchangeLoadMonitor, parseSocketTable, recordExchangeRefusal, recordExchangeRequest, resetExchangeLoadForTests,
} from '../apps/api/src/paper-execution/exchange-load';
import { PaperExperimentControllerError, PaperExperimentControllerV1 } from '../apps/api/src/paper-execution/paper-experiment-controller';
import { StartPaperExperimentSchema } from '../packages/shared/src/paper-experiment-contracts';
import type { StrategyDetail } from '../packages/shared/src/strategy-catalog-contracts';

const MINUTE = 60_000;
const row = (key: ExchangeLoadRow['key'], used: number, limit: number): ExchangeLoadRow => ({
  key, exchange: key.startsWith('lighter') ? 'Lighter' : 'Hyperliquid', label: key, scope: 'server', used, limit,
  perMinute: key !== 'hyperliquid-connections', parts: [],
});

const directories: string[] = [];
afterEach(async () => {
  resetExchangeLoadForTests();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('exchange limits: levels and the launch forecast', () => {
  it('colours at 70 % and over 90 %, and a refusal within the hour is red', () => {
    expect(limitLevel({ used: 41, limit: 60 })).toBe('ok');
    expect(limitLevel({ used: 42, limit: 60 })).toBe('near');
    expect(limitLevel({ used: 54, limit: 60 })).toBe('near');
    expect(limitLevel({ used: 55, limit: 60 })).toBe('over');
    expect(limitLevel({ used: 1, limit: 60, refusedAt: '2026-10-25T10:00:00.000Z' })).toBe('over');
    const view = { rows: [row('lighter-requests', 30, 60), row('hyperliquid-connections', 9, 10)] };
    expect(loadPercent(view)).toBe(90);
    expect(viewLevel(view)).toBe('near');
  });

  it('refuses a Live run with Hyperliquid that would open more connections than allowed, warns otherwise', () => {
    const view = { rows: [row('lighter-requests', 40, 60), row('hyperliquid-weight', 300, 1200), row('hyperliquid-connections', 9, 10)] };
    const paperOnLighter = forecastRun(view, runLoadPlan({ tracks: [{ venue: 'Lighter' }] }));
    expect(paperOnLighter.refusal).toBeNull();
    expect(paperOnLighter.warnings).toEqual([]);
    const paperOnHyperliquid = forecastRun(view, runLoadPlan({ tracks: [{ venue: 'Hyperliquid' }] }));
    expect(paperOnHyperliquid.refusal).toBeNull(); // Paper: a warning only
    expect(paperOnHyperliquid.warnings).toEqual(['hyperliquid-connections: 10 of 10 after this run starts.']);
    const live = forecastRun(view, runLoadPlan({ tracks: [{ venue: 'Lighter' }, { venue: 'Hyperliquid' }], live: {} }));
    expect(live.rows.map((item) => [item.key, item.used])).toEqual([
      ['lighter-requests', 46], ['hyperliquid-weight', 336], ['hyperliquid-connections', 11]]);
    expect(live.refusal).toContain('needs 2 more Hyperliquid connections: 11 of 10');
    expect(live.warnings).toEqual(['lighter-requests: 46 of 60 a minute after this run starts.',
      'hyperliquid-connections: 11 of 10 after this run starts.']);
    // Live on Lighter only opens no Hyperliquid connection.
    expect(forecastRun(view, runLoadPlan({ tracks: [{ venue: 'Lighter' }], live: {} })).refusal).toBeNull();
  });
});

describe('exchange load monitor', () => {
  it('finds the busiest rolling minute of the last hour', () => {
    const now = 10 * 60 * MINUTE;
    for (let index = 0; index < 30; index += 1) recordExchangeRequest('lighter', 1, now - 50 * MINUTE + index * 1_000);
    for (let index = 0; index < 12; index += 1) recordExchangeRequest('lighter', 1, now - 5 * MINUTE + index * 10_000);
    recordExchangeRequest('lighter', 1, now - 2 * 60 * MINUTE); // older than an hour
    for (let index = 0; index < 3; index += 1) recordExchangeRequest('hyperliquid', 20 + index, now - MINUTE + index);
    expect(busiestMinute('lighter', now)).toEqual({ requests: 30, weight: 30 });
    expect(busiestMinute('hyperliquid', now)).toEqual({ requests: 3, weight: 63 });
  });

  it('reads established connections from the system socket table', () => {
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 30C5AD03:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1',
      '   1: 0100007F:1F91 30C5AD03:01BB 06 00000000:00000000 00:00000000 00000000  1000        0 22222 1',
      '   0: 0000000000000000FFFF00000100007F:9C40 0000000000000000FFFF000033C5AD03:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1',
    ].join('\n');
    expect(parseSocketTable(table)).toEqual([
      { key: '0100007F:1F90>30C5AD03:01BB', ip: '3.173.197.48', port: 443, inode: '11111' },
      { key: '0000000000000000FFFF00000100007F:9C40>0000000000000000FFFF000033C5AD03:01BB', ip: '3.173.197.51', port: 443, inode: '33333' },
    ]);
  });

  it('counts runs by their setup, other programs once their connections last, and each account', async () => {
    let now = 100 * MINUTE;
    let intents = 4;
    const table = () => [
      'header',
      // another program: two streams to Hyperliquid
      `   0: 0100007F:A001 30C5AD03:01BB 01 00000000:00000000 00:00000000 00000000  1001        0 501 1`,
      `   1: 0100007F:A002 33C5AD03:01BB 01 00000000:00000000 00:00000000 00000000  1001        0 502 1`,
      // this engine's own run: counted by its setup, not here
      `   2: 0100007F:A003 30C5AD03:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 601 1`,
      // not Hyperliquid
      `   3: 0100007F:A004 0A000001:01BB 01 00000000:00000000 00:00000000 00000000  1001        0 701 1`,
    ].join('\n');
    const fetched: string[] = [];
    const monitor = new ExchangeLoadMonitor({
      now: () => now,
      runs: () => [
        { id: 'paper-1', lighter: true, hyperliquid: true, live: false },
        { id: 'live-1', lighter: true, hyperliquid: true, live: true,
          accounts: { lighter: 'lighter-main', hyperliquid: 'hyper-main' }, orders: { lighter: intents, hyperliquid: 0 } },
      ],
      account: (id) => (id === 'hyper-main' ? { name: 'Hyperliquid main', accountAddress: '0x1111111111111111111111111111111111111111' }
        : { name: 'Lighter main' }),
      sockets: async () => ({ table: table(), own: new Set(['601']) }),
      resolveHost: async () => ['3.173.197.48', '3.173.197.51'],
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        fetched.push(String(init?.body));
        return new Response(JSON.stringify({ nRequestsUsed: 1840, nRequestsCap: 11950 }), { status: 200 });
      }) as typeof fetch,
    });
    await monitor.sample();
    let view = await monitor.view();
    const used = (key: string) => view.rows.find((item) => item.key === key && item.scope === 'server')?.used;
    expect(used('hyperliquid-connections')).toBe(3); // Paper 1 + Live 2; others not yet lasting
    expect(used('lighter-requests')).toBe(EXCHANGE_LIMITS.lighterRequests / 10); // the Live run's position checks
    expect(used('hyperliquid-weight')).toBe(36); // the Live run's position checks
    now += 2 * MINUTE;
    await monitor.sample();
    view = await monitor.view();
    expect(used('hyperliquid-connections')).toBe(5);
    expect(used('hyperliquid-weight')).toBe(36 + 20); // and the order budget read of the first view
    expect(view.rows.find((item) => item.key === 'hyperliquid-connections')?.parts)
      .toEqual([{ label: '2 run(s) on Hyperliquid', value: 3 }, { label: 'other programs on this server', value: 2 }]);
    const accounts = view.rows.filter((item) => item.scope === 'account').map((item) => [item.key, item.account, item.used, item.limit]);
    expect(accounts).toEqual([['lighter-orders', 'Lighter main', 0, 60], ['hyperliquid-orders', 'Hyperliquid main', 1840, 11950]]);
    expect(fetched).toEqual(['{"type":"userRateLimit","user":"0x1111111111111111111111111111111111111111"}']); // cached
    now += 30_000;
    intents = 9;
    await monitor.sample();
    view = await monitor.view();
    expect(view.rows.find((item) => item.key === 'lighter-orders')?.used).toBe(5); // 4 -> 9 within a minute

    recordExchangeRefusal('lighter', now);
    view = await monitor.view();
    expect(limitLevel(view.rows.find((item) => item.key === 'lighter-requests')!)).toBe('over');
  });
});

describe('Live launch', () => {
  it('is refused when an exchange limit would be exceeded, but a run resumed after a restart is not judged', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'psr-exchange-load-'));
    directories.push(root);
    const refusals: string[] = [];
    const controller = new PaperExperimentControllerV1({
      directory: path.join(root, 'paper'), catalogConfigured: true, liveTrading: true, liveExchanges: () => ['lighter'],
      runtimeFactory: { preflight: async () => { throw new Error('preflight reached'); }, abortStart: async () => { throw new Error('unused'); },
        start: async () => { throw new Error('unused'); } },
      liveLoadRefusal: async () => { refusals.push('asked'); return 'Hyperliquid connections: 11 of 10.'; },
    });
    try {
      const source = '//@version=6\nstrategy("Live", overlay=true)\nstrategy.entry("L", strategy.long)\n';
      const sourceSha256 = createHash('sha256').update(source).digest('hex');
      const settings = {
        accountModel: 'pine_live_v1' as const, timeframe: '1m' as const, tracks: [{ venue: 'Lighter' as const, market: 'SOL' }],
        capitalPerVenue: 10_000, orderSizePercent: 10, lighterMakerFeePercent: 0, lighterTakerFeePercent: 0,
        hyperliquidMakerFeePercent: 0.015, hyperliquidTakerFeePercent: 0.045,
        live: { maxLeverage: 2, exchangeStopPercent: 0.5, exchangeStopFrom: 'strategy_stop' as const, accounts: { lighter: 'lighter-main-1' } },
      };
      const strategyId = randomUUID();
      const request = StartPaperExperimentSchema.parse({ strategyId, version: 1, sourceSha256, settings, idempotencyKey: randomUUID() });
      const saved = { strategy: { id: strategyId },
        version: { version: 1, sourceSha256, paperSettings: request.settings, name: 'Live', source, metadata: {} } } as unknown as StrategyDetail;
      const refused = await controller.start(request, saved).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PaperExperimentControllerError);
      expect((refused as PaperExperimentControllerError).kind).toBe('PAPER_EXPERIMENT_LIMIT');
      expect((refused as Error).message).toBe('Hyperliquid connections: 11 of 10.');
      await expect(controller.start(request, saved, { resumed: true })).rejects.toThrow('preflight reached');
      expect(refusals).toEqual(['asked']);
    } finally {
      await controller.close();
    }
  });
});
