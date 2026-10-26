import { performance } from 'node:perf_hooks';

import { runPineWorker } from '../apps/api/src/worker-client.js';
import { buildMinuteReplayDetailizationData } from '../packages/market-data/src/high-detailization.js';
import type { Candle } from '../packages/shared/src/contracts.js';

const MINUTE_MS = 60_000;
const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_DAYS = 180;
const DEFAULT_WORKER_MEMORY_MB = 384;
const DEFAULT_TIMEOUT_MS = 120_000;
const START = Date.UTC(2025, 0, 1);

function integerArgument(name: string, fallback: number, min: number, max: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function syntheticMinute(openTime: number, index: number): Candle {
  const price = 100 + (index % 100) / 100;
  return {
    openTime,
    open: price,
    high: price + 0.1,
    low: price - 0.1,
    close: price,
    volume: 1,
    closeTime: openTime + MINUTE_MS - 1,
    quoteAssetVolume: price,
    numberOfTrades: 1,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

function aggregateHour(minutes: Candle[], hourIndex: number): Candle {
  const offset = hourIndex * 60;
  const first = minutes[offset]!;
  const last = minutes[offset + 59]!;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let quoteAssetVolume = 0;
  for (let index = offset; index < offset + 60; index += 1) {
    const minute = minutes[index]!;
    high = Math.max(high, minute.high);
    low = Math.min(low, minute.low);
    quoteAssetVolume += minute.quoteAssetVolume;
  }
  return {
    openTime: first.openTime,
    open: first.open,
    high,
    low,
    close: last.close,
    volume: 60,
    closeTime: last.closeTime,
    quoteAssetVolume,
    numberOfTrades: 60,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

const days = integerArgument('days', DEFAULT_DAYS, MIN_DAYS, MAX_DAYS);
const workerMemoryMb = integerArgument('worker-memory-mb', DEFAULT_WORKER_MEMORY_MB, 128, 4_096);
const timeoutMs = integerArgument('timeout-ms', DEFAULT_TIMEOUT_MS, 1_000, 600_000);
const executionMinutes = days * 24 * 60;

console.log(JSON.stringify({
  phase: 'start',
  days,
  executionMinutes,
  workerMemoryMb,
  timeoutMs,
}));

const totalStarted = performance.now();
try {
  const minutes = Array.from(
    { length: executionMinutes },
    (_, index) => syntheticMinute(START + index * MINUTE_MS, index),
  );
  const parents = Array.from(
    { length: executionMinutes / 60 },
    (_, index) => aggregateHour(minutes, index),
  );
  const preparationStarted = performance.now();
  const detailization = buildMinuteReplayDetailizationData(parents, minutes, {
    tickSize: 0.1,
    symbol: 'BTCUSDT',
    parentTimeframe: '1h',
    materializeReplayTicks: false,
  });
  const preparationMs = performance.now() - preparationStarted;
  const workerStarted = performance.now();
  const result = await runPineWorker({
    source: `//@version=5
strategy("Execution-minute capacity probe", overlay=true)
if bar_index == 0
    strategy.entry("Long", strategy.long)
`,
    candles: parents,
    barIndexOffset: 0,
    market: {
      tickerId: 'BINANCE:BTCUSDT.P',
      symbol: 'BTCUSDT',
      exchange: 'Binance',
      quoteCurrency: 'USDT',
      timeframe: '1h',
      pineTimeframe: '60',
      mintick: 0.1,
      minContract: 0.001,
    },
    highReplay: {
      replayBars: detailization.replayBars,
      replayTicks: detailization.replayTicks,
      deriveTicksFromBars: true,
    },
    execution: {
      initialCapital: 10_000,
      defaultOrderSizeValue: 0.01,
      defaultOrderSizeType: 'fixed',
      pyramiding: 1,
      commissionType: 'percent',
      commissionValue: 0.045,
      slippagePercent: 0.1,
    },
  }, undefined, { timeoutMs, memoryMb: workerMemoryMb });
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
  const memory = process.memoryUsage();
  const mainMaxRssMb = Math.round(process.resourceUsage().maxRSS / 1_024);
  const workerMaxRssMb = Math.round(result.resourceUsage.maxRssKb / 1_024);
  console.log(JSON.stringify({
    phase: 'complete',
    status: 'PASS',
    days,
    executionMinutes,
    parentBars: parents.length,
    replayBars: detailization.replayBars.length,
    replayTicks: detailization.metadata.aggregate.ticks,
    preparationMs: Math.round(preparationMs),
    workerMs: Math.round(performance.now() - workerStarted),
    totalMs: Math.round(performance.now() - totalStarted),
    mainRssMb: Math.round(memory.rss / 1_048_576),
    mainHeapUsedMb: Math.round(memory.heapUsed / 1_048_576),
    mainMaxRssMb,
    workerMaxRssMb,
    conservativeProcessTreeMaxRssMb: mainMaxRssMb + workerMaxRssMb,
    workerMemoryMb,
  }));
} catch (error) {
  console.error(JSON.stringify({
    phase: 'complete',
    status: 'FAIL',
    days,
    executionMinutes,
    totalMs: Math.round(performance.now() - totalStarted),
    workerMemoryMb,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
