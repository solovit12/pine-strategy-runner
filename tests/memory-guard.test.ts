import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MemoryGuard, memoryGuardDecision, memoryGuardLimits, parseMemAvailableMb, parseVmRssMb,
} from '../apps/api/src/paper-execution/memory-guard';
import { PaperExperimentControllerV1, type PaperExperimentStopProof } from '../apps/api/src/paper-execution/paper-experiment-controller';
import { StartPaperExperimentSchema } from '../packages/shared/src/paper-experiment-contracts';
import type { StrategyDetail } from '../packages/shared/src/strategy-catalog-contracts';

const limits = { runMemoryLimitMb: 2048, minFreeMemoryMb: 1024 };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Memory guard decision', () => {
  it('stops a run over its own limit, else the largest run when the server is under its reserve', () => {
    const runs = [{ id: 'a', rssMb: 900 }, { id: 'b', rssMb: 2100 }, { id: 'c', rssMb: 1500 }];
    expect(memoryGuardDecision(runs, 5000, limits)).toMatchObject({ id: 'b' });
    expect(memoryGuardDecision(runs, 5000, limits)!.reason).toContain('2100 MB, over its limit of 2048 MB');
    const small = [{ id: 'a', rssMb: 900 }, { id: 'c', rssMb: 1500 }];
    expect(memoryGuardDecision(small, 5000, limits)).toBeNull();
    expect(memoryGuardDecision(small, null, limits)).toBeNull();
    const reserve = memoryGuardDecision(small, 800, limits);
    expect(reserve).toMatchObject({ id: 'c' });
    expect(reserve!.reason).toContain('800 MB of free memory, under its reserve of 1024 MB; the largest run (1500 MB)');
    // Right after a stop the reserve rule waits for the memory to come back; a run's own limit does not.
    expect(memoryGuardDecision(small, 800, limits, { reserveCooling: true })).toBeNull();
    expect(memoryGuardDecision(runs, 800, limits, { reserveCooling: true })).toMatchObject({ id: 'b' });
    expect(memoryGuardDecision([], 100, limits)).toBeNull();
  });

  it('reads its limits from the environment and /proc', () => {
    expect(memoryGuardLimits({})).toEqual(limits);
    expect(memoryGuardLimits({ PSR_RUN_MEMORY_LIMIT_MB: '3072', PSR_MIN_FREE_MEMORY_MB: '' })).toEqual({ runMemoryLimitMb: 3072, minFreeMemoryMb: 1024 });
    expect(() => memoryGuardLimits({ PSR_MIN_FREE_MEMORY_MB: '1.5' })).toThrow('PSR_MIN_FREE_MEMORY_MB');
    expect(() => memoryGuardLimits({ PSR_RUN_MEMORY_LIMIT_MB: '10' })).toThrow('at least 64');
    expect(parseMemAvailableMb('MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:    2097152 kB\n')).toBe(2048);
    expect(parseMemAvailableMb('MemTotal: 1 kB\n')).toBeNull();
    expect(parseVmRssMb('Name:\tpython\nVmRSS:\t  1048576 kB\nThreads: 9\n')).toBe(1024);
  });

  it('stops one run at a time and never the same run twice', async () => {
    let now = 0;
    let rss: Record<string, number> = { a: 2500, b: 2400 };
    let available = 4000;
    const stops: [string, string][] = [];
    const finish: (() => void)[] = [];
    const guard = new MemoryGuard({
      activeRunIds: () => Object.keys(rss), runsDir: '/unused', limits, now: () => now,
      stopRun: (id, reason) => { stops.push([id, reason]); return new Promise<void>((resolve) => { finish.push(resolve); }); },
      read: async () => ({ availableMb: available, rssMb: async (id) => rss[id] ?? null }),
    });
    expect(await guard.check()).toMatchObject({ id: 'a' });
    // While `a` is still stopping, `b` over its own limit stops too; `a` is not asked again.
    expect(await guard.check()).toMatchObject({ id: 'b' });
    expect(await guard.check()).toBeNull();
    for (const done of finish) done();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stops.map(([id]) => id)).toEqual(['a', 'b']);

    rss = { c: 1200, d: 1300 };
    available = 900;
    now = 30_000;
    expect(await guard.check()).toBeNull(); // the reserve waits a minute after the last stop
    now = 200_000;
    expect(await guard.check()).toMatchObject({ id: 'd' });
  });
});

describe('Memory guard stop', () => {
  it('stops a run the ordinary way with its reason, keeps the LIVE closes outcome once and does not resume it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'psr-memory-guard-'));
    directories.push(root);
    const stopReasons: (string | undefined)[] = [];
    const controller = new PaperExperimentControllerV1({
      directory: path.join(root, 'paper'), catalogConfigured: true,
      runtimeFactory: {
        preflight: async () => undefined,
        abortStart: async () => { throw new Error('unused'); },
        start: async () => ({ stop: async (reason?: string) => {
          stopReasons.push(reason);
          return { outcome: 'interrupted', controlSlotReleaseProven: true, finalVenueDrainProven: false,
            reason: `${reason ?? 'Stopped by user.'} LIVE: every position of this run is closed.` } satisfies PaperExperimentStopProof;
        } }),
      },
    });
    const source = '//@version=6\nstrategy("Guarded", overlay=true)\nstrategy.entry("L", strategy.long)\n';
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const settings = {
      accountModel: 'venue_shared_v2', timeframe: '1h', tracks: [{ venue: 'Hyperliquid', market: 'BTC' }, { venue: 'Lighter', market: 'BTC' }],
      capitalPerVenue: 10_000, orderSizePercentOfRealizedEquity: 10,
      hyperliquidMakerEntryFeePercent: 0, hyperliquidTakerExitFeePercent: 0, lighterMakerEntryFeePercent: 0, lighterTakerExitFeePercent: 0,
    };
    const strategyId = randomUUID();
    const start = () => {
      const request = StartPaperExperimentSchema.parse({ strategyId, version: 1, sourceSha256, settings, idempotencyKey: randomUUID() });
      const saved = { strategy: { id: strategyId },
        version: { version: 1, sourceSha256, paperSettings: request.settings, name: 'Guarded', source, metadata: {} } } as unknown as StrategyDetail;
      return controller.start(request, saved);
    };
    const guarded = (await start()).experiment.id;
    const other = (await start()).experiment.id;
    expect(controller.runningIds().sort()).toEqual([guarded, other].sort());

    const reason = 'Memory guard: this run used 2100 MB.';
    const stopped = await controller.stop(guarded, reason);
    expect(stopped).toMatchObject({ status: 'interrupted', reason: `${reason} LIVE: every position of this run is closed.` });
    expect(controller.runningIds()).toEqual([other]);

    await controller.close();
    expect(stopReasons).toEqual([reason, 'Server shutdown: the system stopped the engine.']);
    // Only the run the shutdown stopped starts again on the next engine.
    expect(JSON.parse(await readFile(path.join(root, 'paper', 'resume-after-restart.json'), 'utf8')).ids).toEqual([other]);
  });
});
