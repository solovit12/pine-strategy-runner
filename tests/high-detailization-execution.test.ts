import { describe, expect, it } from 'vitest';
import { PineTS } from 'pinets';
import {
  buildHighDetailizationData,
  buildReplayTicks,
  HOUR_MS,
  MINUTE_MS,
  TEN_MINUTES_MS,
  type ReplayBar,
} from '../packages/market-data/src/high-detailization.js';
import { attachHighBrokerReplay } from '../packages/pine-runtime/src/high-execution.js';
import type { Candle } from '../packages/shared/src/contracts.js';
import {
  FIXTURE_A_START,
  cloneFixtureACandles,
  fixtureAParent,
} from './fixtures/high-detailization.js';

function candle(openTime: number, open: number, high: number, low: number, close: number, volume = 60): Candle {
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime: openTime + HOUR_MS - 1,
    quoteAssetVolume: close * volume,
    numberOfTrades: volume,
    takerBuyBaseAssetVolume: volume / 2,
    takerBuyQuoteAssetVolume: close * volume / 2,
    ignore: 0,
  };
}

function flatHour(openTime: number, price = 100): { parent: Candle; source: Candle[] } {
  const source = Array.from({ length: 60 }, (_, minute): Candle => ({
    ...candle(openTime + minute * MINUTE_MS, price, price, price, price, 1),
    closeTime: openTime + (minute + 1) * MINUTE_MS - 1,
    quoteAssetVolume: price,
    numberOfTrades: 1,
    takerBuyBaseAssetVolume: 0.5,
    takerBuyQuoteAssetVolume: price / 2,
  }));
  return { parent: candle(openTime, price, price, price, price), source };
}

function expandReplayHour(openTime: number, ohlc: ReadonlyArray<readonly [number, number, number, number]>): { parent: Candle; source: Candle[] } {
  const source = ohlc.flatMap(([open, high, low, close], bucketIndex) => {
    const points = [open, open, high, high, low, low, close, close, close, close, close];
    return Array.from({ length: 10 }, (_, minuteIndex): Candle => {
      const minuteOpenTime = openTime + bucketIndex * TEN_MINUTES_MS + minuteIndex * MINUTE_MS;
      const minuteOpen = points[minuteIndex]!;
      const minuteClose = points[minuteIndex + 1]!;
      return {
        ...candle(minuteOpenTime, minuteOpen, Math.max(minuteOpen, minuteClose), Math.min(minuteOpen, minuteClose), minuteClose, 1),
        closeTime: minuteOpenTime + MINUTE_MS - 1,
        quoteAssetVolume: minuteClose,
        numberOfTrades: 1,
        takerBuyBaseAssetVolume: 0.5,
        takerBuyQuoteAssetVolume: minuteClose / 2,
      };
    });
  });
  const open = source[0]!.open;
  const close = source.at(-1)!.close;
  return {
    parent: candle(openTime, open, Math.max(...source.map((item) => item.high)), Math.min(...source.map((item) => item.low)), close),
    source,
  };
}

function replayBar(open: number, high: number, low: number, close: number, replayBarIndex = 0): ReplayBar {
  return {
    ...candle(FIXTURE_A_START + replayBarIndex * TEN_MINUTES_MS, open, high, low, close, 10),
    closeTime: FIXTURE_A_START + (replayBarIndex + 1) * TEN_MINUTES_MS - 1,
    parentBarIndex: 0,
    replayBarIndex,
  };
}

async function runBracket(
  replayHour: { parent: Candle; source: Candle[] },
  direction: 'long' | 'short',
  tp: number,
  sl: number,
) {
  const first = flatHour(replayHour.parent.openTime - 2 * HOUR_MS);
  const second = flatHour(replayHour.parent.openTime - HOUR_MS);
  const parents = [first.parent, second.parent, replayHour.parent];
  const detailization = buildHighDetailizationData(
    parents,
    [...first.source, ...second.source, ...replayHour.source],
    { tickSize: 0.01 },
  );
  const pine = new PineTS(parents as never, 'BINANCE:BTCUSDT', '60');
  const evidence = attachHighBrokerReplay(pine, detailization);
  const source = `
//@version=6
strategy("H2 integration", overlay=false, initial_capital=100000, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("POSITION", strategy.${direction})
if bar_index == 1
    strategy.exit("TP", "POSITION", limit=${tp})
    strategy.exit("SL", "POSITION", stop=${sl})
`;
  const context = await pine.run(source);
  return { context, evidence };
}

describe('High H2 path gate', () => {
  it.each([
    ['P01', replayBar(100, 103, 90, 95), [100, 103, 90, 95]],
    ['P02', replayBar(100, 115, 95, 110), [100, 95, 115, 110]],
    ['P03', replayBar(100, 110, 90, 100), [100, 110, 90, 100]],
    ['P04', replayBar(100, 100, 90, 95), [100, 100, 90, 95]],
    ['P05', replayBar(100, 100, 100, 100), [100, 100, 100, 100]],
  ])('%s builds the required four-point path', (_id, bar, expected) => {
    const ticks = buildReplayTicks([bar as ReplayBar], 0.01);
    expect(ticks.map((tick) => tick.price)).toEqual(expected);
    expect(ticks.map((tick) => tick.sequence)).toEqual([0, 1, 2, 3]);
  });

  it('P06 resets a six-bar parent sequence to exactly 0..23', () => {
    const bars = Array.from({ length: 6 }, (_, index) => replayBar(100, 101, 99, 100, index));
    expect(buildReplayTicks(bars, 0.01).map((tick) => tick.sequence)).toEqual(
      Array.from({ length: 24 }, (_, index) => index),
    );
  });

  it('P05 does not create a false crossing on flat replay segments', async () => {
    const first = flatHour(FIXTURE_A_START - HOUR_MS);
    const second = flatHour(FIXTURE_A_START);
    const parents = [first.parent, second.parent];
    const detailization = buildHighDetailizationData(parents, [...first.source, ...second.source], { tickSize: 0.01 });
    const pine = new PineTS(parents as never, 'BINANCE:BTCUSDT', '60');
    const evidence = attachHighBrokerReplay(pine, detailization);
    const context = await pine.run(`
//@version=6
strategy("flat", overlay=false, initial_capital=100000)
if bar_index == 0
    strategy.entry("STOP", strategy.long, stop=101)
`);
    expect(evidence.orderEvents.filter((event) => event.orderId === 'STOP')).toEqual([]);
    expect((context as any).strategy.pending_orders.map((order: any) => order.id)).toContain('STOP');
  });
});

describe('High H2 H1-to-ledger integration', () => {
  it('B01/B04/B05 Fixture A fills the long TP in replay bar #2 before the later SL and cancels the sibling', async () => {
    const result = await runBracket(
      { parent: fixtureAParent, source: cloneFixtureACandles() },
      'long',
      110,
      95,
    );
    const events = result.evidence.orderEvents.filter((event) => event.parentBarIndex === 2);
    expect(events.map((event) => [event.eventType, event.orderId, event.replaySequence])).toEqual([
      ['fill', 'TP', 10],
      ['cancel', 'SL', 10],
    ]);
    expect((result.context as any).strategy.closedtrades[0].exit_price).toBe(110);
    expect((result.context as any).strategy.closedtrades).toHaveLength(1);
  });

  it('B02 Fixture B fills the long SL in replay bar #2 before the later TP', async () => {
    const fixtureB = expandReplayHour(FIXTURE_A_START, [
      [100, 101, 96, 97], [97, 98, 92, 93], [93, 94, 85, 86],
      [86, 96, 86, 95], [95, 105, 94, 103], [103, 104, 89, 90],
    ]);
    const result = await runBracket(fixtureB, 'long', 105, 90);
    const fill = result.evidence.orderEvents.find((event) => event.parentBarIndex === 2 && event.eventType === 'fill');
    expect(fill).toMatchObject({ orderId: 'SL', replaySequence: 10, fillPrice: 90 });
    expect((result.context as any).strategy.closedtrades[0].exit_price).toBe(90);
  });

  it('B03 mirrors Fixture B for a short and reaches TP before the later stop', async () => {
    const fixtureB = expandReplayHour(FIXTURE_A_START, [
      [100, 101, 96, 97], [97, 98, 92, 93], [93, 94, 85, 86],
      [86, 96, 86, 95], [95, 105, 94, 103], [103, 104, 89, 90],
    ]);
    const result = await runBracket(fixtureB, 'short', 90, 105);
    const fill = result.evidence.orderEvents.find((event) => event.parentBarIndex === 2 && event.eventType === 'fill');
    expect(fill).toMatchObject({ orderId: 'TP', replaySequence: 10, fillPrice: 90 });
  });

  it('M06/A10 produces a byte-stable order audit on repeated runs', async () => {
    const first = await runBracket({ parent: fixtureAParent, source: cloneFixtureACandles() }, 'long', 110, 95);
    const second = await runBracket({ parent: fixtureAParent, source: cloneFixtureACandles() }, 'long', 110, 95);
    expect(JSON.stringify(first.evidence.orderEvents)).toBe(JSON.stringify(second.evidence.orderEvents));
  });
});
