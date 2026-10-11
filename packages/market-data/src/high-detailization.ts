import { createHash } from 'node:crypto';
import { BACKTEST_TIMEFRAME_MS, type BacktestTimeframe, type Candle } from '../../shared/src/contracts.js';

export const MINUTE_MS = 60_000;
export const TEN_MINUTES_MS = 10 * MINUTE_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const HIGH_AGGREGATION_VERSION = '1m-to-10m-v1';
export const MINUTE_REPLAY_VERSION = '1m-direct-replay-v1';
export const HIGH_PATH_VERSION = 'distance-path-v1';
export const VOLUME_ABSOLUTE_TOLERANCE = 1e-8;
export const VOLUME_RELATIVE_TOLERANCE = 1e-10;

export type IntrabarDataErrorKind =
  | 'INTRABAR_DATA_INCOMPLETE'
  | 'INTRABAR_DUPLICATE_TIMESTAMP'
  | 'INTRABAR_TIME_ORDER_INVALID'
  | 'INTRABAR_OHLC_INVALID'
  | 'INTRABAR_PARENT_MISMATCH'
  | 'INTRABAR_FETCH_FAILED';

export class IntrabarDataError extends Error {
  constructor(
    public readonly kind: IntrabarDataErrorKind,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'IntrabarDataError';
  }
}

export interface ReplayBar extends Candle {
  parentBarIndex: number;
  replayBarIndex: number;
}

export type ReplayTickStage = 'open' | 'firstExtreme' | 'secondExtreme' | 'close';

export interface ReplayTick {
  parentBarIndex: number;
  replayBarIndex: number;
  stage: ReplayTickStage;
  sequence: number;
  sourceOpenTime: number;
  price: number;
  priceTicks: number;
}

export interface HighDetailizationMetadata {
  source: {
    symbol: string;
    interval: '1m';
    startInclusive: number;
    endExclusive: number;
    fetchedAt: string | null;
    rows: number;
    pages: number | null;
    rawBytes: number | null;
    sha256: string;
    missingTimestamps: number[];
    duplicateTimestamps: number[];
    cache: 'memory' | 'fixture' | 'network';
  };
  aggregate: {
    version: typeof HIGH_AGGREGATION_VERSION | typeof MINUTE_REPLAY_VERSION;
    replayTimeframe: '10m' | '1m';
    bars: number;
    ticks: number;
    sha256: string;
    pathVersion: typeof HIGH_PATH_VERSION;
    volumeAbsoluteTolerance: number;
    volumeRelativeTolerance: number;
  };
}

export interface HighDetailizationData {
  replayBars: ReplayBar[];
  replayTicks: ReplayTick[];
  metadata: HighDetailizationMetadata;
}

export interface BuildHighDetailizationOptions {
  tickSize: number;
  sourceSha256?: string;
  fetchedAt?: string;
  pages?: number;
  rawBytes?: number;
  cache?: 'memory' | 'fixture' | 'network';
}

export interface BuildMinuteReplayOptions extends BuildHighDetailizationOptions {
  symbol: string;
  parentTimeframe: Exclude<BacktestTimeframe, '1m'>;
  /** The production worker can derive the four deterministic ticks per minute lazily. */
  materializeReplayTicks?: boolean;
}

const CANDLE_NUMBER_FIELDS: Array<keyof Candle> = [
  'openTime',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'closeTime',
  'quoteAssetVolume',
  'numberOfTrades',
  'takerBuyBaseAssetVolume',
  'takerBuyQuoteAssetVolume',
  'ignore',
];

function assertFiniteCandle(candle: Candle): void {
  for (const field of CANDLE_NUMBER_FIELDS) {
    if (!Number.isFinite(candle[field])) {
      throw new IntrabarDataError('INTRABAR_OHLC_INVALID', 'Intrabar candle contains a non-finite ' + field + '.', {
        openTime: candle.openTime,
        field,
      });
    }
  }
  if (!Number.isInteger(candle.openTime) || !Number.isInteger(candle.closeTime) || !Number.isInteger(candle.numberOfTrades)) {
    throw new IntrabarDataError('INTRABAR_OHLC_INVALID', 'Intrabar candle timestamps and trade count must be integers.', {
      openTime: candle.openTime,
    });
  }
}

function assertOhlc(candle: Candle, scope: 'intrabar' | 'parent'): void {
  assertFiniteCandle(candle);
  const invalidRange = candle.low > candle.high
    || candle.open < candle.low
    || candle.open > candle.high
    || candle.close < candle.low
    || candle.close > candle.high;
  const invalidTotals = candle.volume < 0
    || candle.quoteAssetVolume < 0
    || candle.numberOfTrades < 0
    || candle.takerBuyBaseAssetVolume < 0
    || candle.takerBuyQuoteAssetVolume < 0;
  if (invalidRange || invalidTotals) {
    const kind = scope === 'intrabar' ? 'INTRABAR_OHLC_INVALID' : 'INTRABAR_PARENT_MISMATCH';
    throw new IntrabarDataError(kind, 'Invalid ' + scope + ' OHLCV values at ' + candle.openTime + '.', {
      openTime: candle.openTime,
    });
  }
}

function assertMinuteTiming(candle: Candle): void {
  if (candle.openTime % MINUTE_MS !== 0 || candle.closeTime !== candle.openTime + MINUTE_MS - 1) {
    throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', 'A 1m candle is not aligned to a complete UTC minute.', {
      openTime: candle.openTime,
      closeTime: candle.closeTime,
    });
  }
}

function aggregateGroup(candles: Candle[], openTime: number, closeTime: number): Candle {
  const first = candles[0];
  const last = candles.at(-1);
  if (!first || !last) {
    throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', 'Cannot aggregate an empty candle group.');
  }
  return {
    openTime,
    open: first.open,
    high: Math.max(...candles.map((candle) => candle.high)),
    low: Math.min(...candles.map((candle) => candle.low)),
    close: last.close,
    volume: candles.reduce((total, candle) => total + candle.volume, 0),
    closeTime,
    quoteAssetVolume: candles.reduce((total, candle) => total + candle.quoteAssetVolume, 0),
    numberOfTrades: candles.reduce((total, candle) => total + candle.numberOfTrades, 0),
    takerBuyBaseAssetVolume: candles.reduce((total, candle) => total + candle.takerBuyBaseAssetVolume, 0),
    takerBuyQuoteAssetVolume: candles.reduce((total, candle) => total + candle.takerBuyQuoteAssetVolume, 0),
    ignore: 0,
  };
}

export function canonicalCandlesSha256(candles: Candle[]): string {
  const hash = createHash('sha256');
  for (const candle of candles) {
    hash.update([
      candle.openTime,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
      candle.closeTime,
      candle.quoteAssetVolume,
      candle.numberOfTrades,
      candle.takerBuyBaseAssetVolume,
      candle.takerBuyQuoteAssetVolume,
      candle.ignore,
    ].join(',') + '\n');
  }
  return hash.digest('hex');
}

export function aggregateTenMinuteBucket(
  candles: Candle[],
  parentBarIndex = 0,
  replayBarIndex = 0,
): ReplayBar {
  if (candles.length !== 10) {
    throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', 'A 10m bucket requires exactly 10 source candles.', {
      actual: candles.length,
    });
  }
  const first = candles[0]!;
  if (first.openTime % TEN_MINUTES_MS !== 0) {
    throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', 'A 10m bucket must start at a UTC 00/10/20/30/40/50 minute.', {
      openTime: first.openTime,
    });
  }
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    assertOhlc(candle, 'intrabar');
    assertMinuteTiming(candle);
    const expected = first.openTime + index * MINUTE_MS;
    if (candle.openTime !== expected) {
      throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', 'A 10m bucket contains a missing or unexpected minute.', {
        expected,
        actual: candle.openTime,
      });
    }
  }
  return {
    ...aggregateGroup(candles, first.openTime, candles.at(-1)!.closeTime),
    parentBarIndex,
    replayBarIndex,
  };
}

function priceTicks(price: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new IntrabarDataError('INTRABAR_OHLC_INVALID', 'tickSize must be a positive finite number.', { tickSize });
  }
  const ticks = Math.round(price / tickSize);
  if (!Number.isSafeInteger(ticks)) {
    throw new IntrabarDataError('INTRABAR_OHLC_INVALID', 'Normalized price exceeds the safe integer tick range.', {
      price,
      tickSize,
    });
  }
  return ticks;
}

export function buildReplayTicks(replayBars: ReplayBar[], tickSize: number): ReplayTick[] {
  const ticks: ReplayTick[] = [];
  for (const bar of replayBars) {
    const highFirst = Math.abs(bar.open - bar.high) <= Math.abs(bar.open - bar.low);
    const stages: Array<{ stage: ReplayTickStage; price: number }> = highFirst
      ? [
          { stage: 'open', price: bar.open },
          { stage: 'firstExtreme', price: bar.high },
          { stage: 'secondExtreme', price: bar.low },
          { stage: 'close', price: bar.close },
        ]
      : [
          { stage: 'open', price: bar.open },
          { stage: 'firstExtreme', price: bar.low },
          { stage: 'secondExtreme', price: bar.high },
          { stage: 'close', price: bar.close },
        ];
    for (const [stageIndex, item] of stages.entries()) {
      ticks.push({
        parentBarIndex: bar.parentBarIndex,
        replayBarIndex: bar.replayBarIndex,
        stage: item.stage,
        sequence: bar.replayBarIndex * 4 + stageIndex,
        sourceOpenTime: bar.openTime,
        price: item.price,
        priceTicks: priceTicks(item.price, tickSize),
      });
    }
  }
  return ticks;
}

function validateSourceOrder(candles: Candle[]): void {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const candle of candles) {
    if (seen.has(candle.openTime)) duplicates.add(candle.openTime);
    seen.add(candle.openTime);
  }
  if (duplicates.size > 0) {
    throw new IntrabarDataError('INTRABAR_DUPLICATE_TIMESTAMP', 'Duplicate 1m timestamps are not allowed.', {
      duplicateTimestamps: [...duplicates].sort((left, right) => left - right),
    });
  }
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index]!.openTime < candles[index - 1]!.openTime) {
      throw new IntrabarDataError('INTRABAR_TIME_ORDER_INVALID', '1m timestamps must be strictly increasing.', {
        previous: candles[index - 1]!.openTime,
        current: candles[index]!.openTime,
      });
    }
  }
}

function assertParentMatches(parent: Candle, sourceHour: Candle[], tickSize: number): void {
  const actual = aggregateGroup(sourceHour, parent.openTime, sourceHour.at(-1)!.closeTime);
  const mismatches: string[] = [];
  for (const field of ['open', 'high', 'low', 'close'] as const) {
    if (priceTicks(parent[field], tickSize) !== priceTicks(actual[field], tickSize)) {
      mismatches.push(field);
    }
  }
  const volumeTolerance = Math.max(
    VOLUME_ABSOLUTE_TOLERANCE,
    Math.abs(parent.volume) * VOLUME_RELATIVE_TOLERANCE,
  );
  if (Math.abs(parent.volume - actual.volume) > volumeTolerance) mismatches.push('volume');
  if (mismatches.length > 0) {
    throw new IntrabarDataError('INTRABAR_PARENT_MISMATCH', 'Aggregated 1m data does not match the native 1h parent bar.', {
      parentOpenTime: parent.openTime,
      mismatches,
      expected: {
        open: parent.open,
        high: parent.high,
        low: parent.low,
        close: parent.close,
        volume: parent.volume,
      },
      actual: {
        open: actual.open,
        high: actual.high,
        low: actual.low,
        close: actual.close,
        volume: actual.volume,
      },
      volumeTolerance,
    });
  }
}

function assertParentMatchesMinuteReplay(
  parent: Candle,
  sourceBars: Candle[],
  tickSize: number,
  parentTimeframe: BacktestTimeframe,
): void {
  const actual = aggregateGroup(sourceBars, parent.openTime, sourceBars.at(-1)!.closeTime);
  const mismatches: string[] = [];
  for (const field of ['open', 'high', 'low', 'close'] as const) {
    if (priceTicks(parent[field], tickSize) !== priceTicks(actual[field], tickSize)) mismatches.push(field);
  }
  const volumeTolerance = Math.max(
    VOLUME_ABSOLUTE_TOLERANCE,
    Math.abs(parent.volume) * VOLUME_RELATIVE_TOLERANCE,
  );
  if (Math.abs(parent.volume - actual.volume) > volumeTolerance) mismatches.push('volume');
  if (mismatches.length > 0) {
    throw new IntrabarDataError(
      'INTRABAR_PARENT_MISMATCH',
      `Aggregated 1m data does not match the native ${parentTimeframe} parent bar.`,
      {
        parentOpenTime: parent.openTime,
        parentTimeframe,
        mismatches,
        expected: {
          open: parent.open,
          high: parent.high,
          low: parent.low,
          close: parent.close,
          volume: parent.volume,
        },
        actual: {
          open: actual.open,
          high: actual.high,
          low: actual.low,
          close: actual.close,
          volume: actual.volume,
        },
        volumeTolerance,
      },
    );
  }
}

export function buildHighDetailizationData(
  parentCandles: Candle[],
  sourceCandles: Candle[],
  options: BuildHighDetailizationOptions,
): HighDetailizationData {
  if (parentCandles.length === 0) {
    throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', 'At least one native 1h parent bar is required.');
  }
  for (let index = 0; index < parentCandles.length; index += 1) {
    const parent = parentCandles[index]!;
    assertOhlc(parent, 'parent');
    if (parent.openTime % HOUR_MS !== 0) {
      throw new IntrabarDataError('INTRABAR_PARENT_MISMATCH', 'A native 1h parent bar is not aligned to UTC hour.', {
        openTime: parent.openTime,
      });
    }
    if (index > 0 && parent.openTime <= parentCandles[index - 1]!.openTime) {
      throw new IntrabarDataError('INTRABAR_PARENT_MISMATCH', 'Native 1h parent timestamps must be strictly increasing.');
    }
  }

  validateSourceOrder(sourceCandles);
  for (const candle of sourceCandles) {
    assertOhlc(candle, 'intrabar');
    assertMinuteTiming(candle);
  }

  const expectedTimestamps = parentCandles.flatMap((parent) =>
    Array.from({ length: 60 }, (_, minute) => parent.openTime + minute * MINUTE_MS));
  const expectedSet = new Set(expectedTimestamps);
  const actualSet = new Set(sourceCandles.map((candle) => candle.openTime));
  const missingTimestamps = expectedTimestamps.filter((timestamp) => !actualSet.has(timestamp));
  const unexpectedTimestamps = sourceCandles
    .map((candle) => candle.openTime)
    .filter((timestamp) => !expectedSet.has(timestamp));
  if (missingTimestamps.length > 0 || unexpectedTimestamps.length > 0 || sourceCandles.length !== expectedTimestamps.length) {
    throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', 'The 1m source does not contain exactly 60 candles per parent hour.', {
      expectedRows: expectedTimestamps.length,
      actualRows: sourceCandles.length,
      missingTimestamps,
      unexpectedTimestamps,
    });
  }

  const replayBars: ReplayBar[] = [];
  for (let parentBarIndex = 0; parentBarIndex < parentCandles.length; parentBarIndex += 1) {
    const parent = parentCandles[parentBarIndex]!;
    const hourOffset = parentBarIndex * 60;
    const sourceHour = sourceCandles.slice(hourOffset, hourOffset + 60);
    assertParentMatches(parent, sourceHour, options.tickSize);
    for (let replayBarIndex = 0; replayBarIndex < 6; replayBarIndex += 1) {
      const start = hourOffset + replayBarIndex * 10;
      replayBars.push(aggregateTenMinuteBucket(
        sourceCandles.slice(start, start + 10),
        parentBarIndex,
        replayBarIndex,
      ));
    }
  }

  const replayTicks = buildReplayTicks(replayBars, options.tickSize);
  const startInclusive = parentCandles[0]!.openTime;
  const endExclusive = parentCandles.at(-1)!.openTime + HOUR_MS;
  return {
    replayBars,
    replayTicks,
    metadata: {
      source: {
        symbol: 'BTCUSDT',
        interval: '1m',
        startInclusive,
        endExclusive,
        fetchedAt: options.fetchedAt ?? null,
        rows: sourceCandles.length,
        pages: options.pages ?? null,
        rawBytes: options.rawBytes ?? null,
        sha256: options.sourceSha256 ?? canonicalCandlesSha256(sourceCandles),
        missingTimestamps: [],
        duplicateTimestamps: [],
        cache: options.cache ?? 'fixture',
      },
      aggregate: {
        version: HIGH_AGGREGATION_VERSION,
        replayTimeframe: '10m',
        bars: replayBars.length,
        ticks: replayTicks.length,
        sha256: canonicalCandlesSha256(replayBars),
        pathVersion: HIGH_PATH_VERSION,
        volumeAbsoluteTolerance: VOLUME_ABSOLUTE_TOLERANCE,
        volumeRelativeTolerance: VOLUME_RELATIVE_TOLERANCE,
      },
    },
  };
}

/**
 * Build a broker-only 1m replay while keeping Pine calculations on the
 * caller-selected parent timeframe. Unlike legacy High v1 this does not
 * aggregate the source to 10m, so every complete source minute contributes
 * its own deterministic OHLC path.
 */
export function buildMinuteReplayDetailizationData(
  parentCandles: Candle[],
  sourceCandles: Candle[],
  options: BuildMinuteReplayOptions,
): HighDetailizationData {
  if (parentCandles.length === 0) {
    throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', 'At least one native parent bar is required.');
  }
  const parentDurationMs = BACKTEST_TIMEFRAME_MS[options.parentTimeframe];
  const minutesPerParent = parentDurationMs / MINUTE_MS;
  if (!Number.isSafeInteger(minutesPerParent) || minutesPerParent <= 1) {
    throw new IntrabarDataError('INTRABAR_DATA_INCOMPLETE', 'Minute replay requires a parent timeframe above 1m.', {
      parentTimeframe: options.parentTimeframe,
    });
  }

  for (let index = 0; index < parentCandles.length; index += 1) {
    const parent = parentCandles[index]!;
    assertOhlc(parent, 'parent');
    if (parent.closeTime !== parent.openTime + parentDurationMs - 1) {
      throw new IntrabarDataError('INTRABAR_PARENT_MISMATCH', 'Parent candle has an invalid close time.', {
        openTime: parent.openTime,
        closeTime: parent.closeTime,
        expectedCloseTime: parent.openTime + parentDurationMs - 1,
      });
    }
    if (index > 0 && parent.openTime !== parentCandles[index - 1]!.openTime + parentDurationMs) {
      throw new IntrabarDataError(
        'INTRABAR_PARENT_MISMATCH',
        'Parent timestamps must be contiguous at the selected timeframe.',
        {
          previous: parentCandles[index - 1]!.openTime,
          expected: parentCandles[index - 1]!.openTime + parentDurationMs,
          actual: parent.openTime,
        },
      );
    }
  }

  validateSourceOrder(sourceCandles);
  for (const candle of sourceCandles) {
    assertOhlc(candle, 'intrabar');
    assertMinuteTiming(candle);
  }

  const expectedTimestamps = parentCandles.flatMap((parent) =>
    Array.from({ length: minutesPerParent }, (_, minute) => parent.openTime + minute * MINUTE_MS));
  const expectedSet = new Set(expectedTimestamps);
  const sourceByTime = new Map(sourceCandles.map((candle) => [candle.openTime, candle]));
  const missingTimestamps = expectedTimestamps.filter((timestamp) => !sourceByTime.has(timestamp));
  const unexpectedTimestamps = sourceCandles
    .map((candle) => candle.openTime)
    .filter((timestamp) => !expectedSet.has(timestamp));
  if (missingTimestamps.length > 0 || unexpectedTimestamps.length > 0 || sourceCandles.length !== expectedTimestamps.length) {
    throw new IntrabarDataError(
      'INTRABAR_DATA_INCOMPLETE',
      `The 1m source does not contain exactly ${minutesPerParent} candles per ${options.parentTimeframe} parent bar.`,
      {
        expectedRows: expectedTimestamps.length,
        actualRows: sourceCandles.length,
        missingTimestamps,
        unexpectedTimestamps,
      },
    );
  }

  const replayBars: ReplayBar[] = [];
  for (let parentBarIndex = 0; parentBarIndex < parentCandles.length; parentBarIndex += 1) {
    const parent = parentCandles[parentBarIndex]!;
    const sourceForParent = Array.from({ length: minutesPerParent }, (_, minute) =>
      sourceByTime.get(parent.openTime + minute * MINUTE_MS)!);
    assertParentMatchesMinuteReplay(parent, sourceForParent, options.tickSize, options.parentTimeframe);
    for (let replayBarIndex = 0; replayBarIndex < sourceForParent.length; replayBarIndex += 1) {
      replayBars.push({
        ...sourceForParent[replayBarIndex]!,
        parentBarIndex,
        replayBarIndex,
      });
    }
  }

  const replayTickCount = replayBars.length * 4;
  const replayTicks = options.materializeReplayTicks === false
    ? []
    : buildReplayTicks(replayBars, options.tickSize);
  return {
    replayBars,
    replayTicks,
    metadata: {
      source: {
        symbol: options.symbol,
        interval: '1m',
        startInclusive: parentCandles[0]!.openTime,
        endExclusive: parentCandles.at(-1)!.openTime + parentDurationMs,
        fetchedAt: options.fetchedAt ?? null,
        rows: sourceCandles.length,
        pages: options.pages ?? null,
        rawBytes: options.rawBytes ?? null,
        sha256: options.sourceSha256 ?? canonicalCandlesSha256(sourceCandles),
        missingTimestamps: [],
        duplicateTimestamps: [],
        cache: options.cache ?? 'fixture',
      },
      aggregate: {
        version: MINUTE_REPLAY_VERSION,
        replayTimeframe: '1m',
        bars: replayBars.length,
        ticks: replayTickCount,
        sha256: canonicalCandlesSha256(replayBars),
        pathVersion: HIGH_PATH_VERSION,
        volumeAbsoluteTolerance: VOLUME_ABSOLUTE_TOLERANCE,
        volumeRelativeTolerance: VOLUME_RELATIVE_TOLERANCE,
      },
    },
  };
}
