import { describe, expect, it } from 'vitest';
import { PineTS } from 'pinets';
import {
  buildHighDetailizationData,
  HOUR_MS,
  MINUTE_MS,
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

function flatHour(openTime: number, price: number): { parent: Candle; source: Candle[] } {
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

function plotValues(context: any, title: string): number[] {
  return context.plots[title].data.map((point: { value: number }) => point.value);
}

async function runHigh(parents: Candle[], sourceCandles: Candle[], source: string) {
  const detailization = buildHighDetailizationData(parents, sourceCandles, { tickSize: 0.01 });
  const pine = new PineTS(parents as never, 'BINANCE:BTCUSDT', '60');
  const evidence = attachHighBrokerReplay(pine, detailization);
  const context = await pine.run(source);
  evidence.assertFinalPendingOrdersSupported();
  return { context, detailization, evidence };
}

describe('High H3 Pine/runtime isolation', () => {
  it('R01 executes the Pine body once for one parent hour, not once per replay point', async () => {
    const hour = flatHour(FIXTURE_A_START, 100);
    const { context, detailization, evidence } = await runHigh([hour.parent], hour.source, `
//@version=6
strategy("H3 R01", overlay=false)
var int executions = 0
executions += 1
plot(executions, "executions")
`);

    expect(detailization.replayTicks).toHaveLength(24);
    // No broker state exists before the first strategy() calculation, so the
    // first parent has nothing eligible to replay through the ledger.
    expect(evidence.tickAudits).toHaveLength(0);
    expect(plotValues(context, 'executions')).toEqual([1]);
  });

  it('R02 advances bar_index once per parent hour while replaying 24 points per hour', async () => {
    const first = flatHour(FIXTURE_A_START, 90);
    const second = flatHour(FIXTURE_A_START + HOUR_MS, 110);
    const { context, evidence } = await runHigh(
      [first.parent, second.parent],
      [...first.source, ...second.source],
      `
//@version=6
strategy("H3 R02", overlay=false)
plot(bar_index, "parent bar_index")
`,
    );

    expect(evidence.tickAudits).toHaveLength(24);
    expect(plotValues(context, 'parent bar_index')).toEqual([0, 1]);
  });

  it('R03 restores the parent 1h high/low before Pine reads the candle', async () => {
    const previous = flatHour(FIXTURE_A_START - HOUR_MS, 100);
    const { context, evidence } = await runHigh(
      [previous.parent, fixtureAParent],
      [...previous.source, ...cloneFixtureACandles()],
      `
//@version=6
strategy("H3 R03", overlay=false)
plot(high, "parent high")
plot(low, "parent low")
`,
    );

    expect(evidence.tickAudits).toHaveLength(24);
    expect(plotValues(context, 'parent high')).toEqual([100, 115]);
    expect(plotValues(context, 'parent low')).toEqual([100, 95]);
  });

  it('R04 exposes a 00:20 replay fill to Pine only at the 01:00 parent close', async () => {
    const previous = flatHour(FIXTURE_A_START - HOUR_MS, 100);
    const { context, evidence } = await runHigh(
      [previous.parent, fixtureAParent],
      [...previous.source, ...cloneFixtureACandles()],
      `
//@version=6
strategy("H3 R04", overlay=false, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("STOP", strategy.long, stop=110)
plot(strategy.position_size, "position seen by Pine")
`,
    );

    const fill = evidence.orderEvents.find((event) => event.eventType === 'fill' && event.orderId === 'STOP');
    expect(fill).toMatchObject({ parentBarIndex: 1, replaySequence: 10, fillPrice: 110 });
    expect(plotValues(context, 'position seen by Pine')).toEqual([0, 1]);
    expect(evidence.tickAudits.filter((audit) => audit.parentBarIndex === 1 && audit.sequence < 10))
      .toSatisfy((audits: typeof evidence.tickAudits) => audits.every((audit) => audit.positionSizeAfter === 0));
    expect(evidence.tickAudits.find((audit) => audit.parentBarIndex === 1 && audit.sequence === 10)?.positionSizeAfter)
      .toBe(1);
  });

  it('R05 calculates SMA(2) from two parent closes, not from replay points', async () => {
    const first = flatHour(FIXTURE_A_START, 90);
    const second = flatHour(FIXTURE_A_START + HOUR_MS, 110);
    const { context, evidence } = await runHigh(
      [first.parent, second.parent],
      [...first.source, ...second.source],
      `
//@version=6
strategy("H3 R05", overlay=false)
float parentSma = ta.sma(close, 2)
plot(parentSma, "parent SMA(2)")
`,
    );

    expect(evidence.tickAudits).toHaveLength(24);
    expect(plotValues(context, 'parent SMA(2)').at(-1)).toBe(100);
  });

  it('R06 increments var state once per parent hour', async () => {
    const hours = [90, 100, 110].map((price, index) => flatHour(FIXTURE_A_START + index * HOUR_MS, price));
    const { context, evidence } = await runHigh(
      hours.map((hour) => hour.parent),
      hours.flatMap((hour) => hour.source),
      `
//@version=6
strategy("H3 R06", overlay=false)
var int counter = 0
counter += 1
plot(counter, "parent counter")
`,
    );

    expect(evidence.tickAudits).toHaveLength(48);
    expect(plotValues(context, 'parent counter')).toEqual([1, 2, 3]);
  });

  it('R07 can execute replay without retaining the full production audit history', async () => {
    const first = flatHour(FIXTURE_A_START, 100);
    const second = flatHour(FIXTURE_A_START + HOUR_MS, 110);
    const detailization = buildHighDetailizationData(
      [first.parent, second.parent],
      [...first.source, ...second.source],
      { tickSize: 0.01 },
    );
    const pine = new PineTS([first.parent, second.parent] as never, 'BINANCE:BTCUSDT', '60');
    const evidence = attachHighBrokerReplay(pine, detailization, { retainAudit: false });
    const context = await pine.run(`
//@version=6
strategy("H3 R07", overlay=false, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("Long", strategy.long)
plot(strategy.position_size, "position")
`);
    evidence.assertFinalPendingOrdersSupported();

    expect(plotValues(context, 'position')).toEqual([0, 1]);
    expect(evidence.tickAudits).toEqual([]);
    expect(evidence.orderEvents).toEqual([]);
  });

  it('R08 lazy production ticks preserve the materialized replay result', async () => {
    const previous = flatHour(FIXTURE_A_START - HOUR_MS, 100);
    const parents = [previous.parent, fixtureAParent];
    const detailization = buildHighDetailizationData(
      parents,
      [...previous.source, ...cloneFixtureACandles()],
      { tickSize: 0.01 },
    );
    const source = `
//@version=6
strategy("H3 R08", overlay=false, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("STOP", strategy.long, stop=110)
plot(strategy.position_size, "position")
`;

    const materializedPine = new PineTS(parents as never, 'BINANCE:BTCUSDT', '60');
    const materialized = attachHighBrokerReplay(materializedPine, detailization);
    const materializedContext = await materializedPine.run(source);
    materialized.assertFinalPendingOrdersSupported();

    const lazyPine = new PineTS(parents as never, 'BINANCE:BTCUSDT', '60');
    const lazy = attachHighBrokerReplay(lazyPine, {
      replayBars: detailization.replayBars,
      replayTicks: [],
    }, {
      deriveTicksFromBars: true,
      deriveTickSize: 0.01,
    });
    const lazyContext = await lazyPine.run(source);
    lazy.assertFinalPendingOrdersSupported();

    expect(plotValues(lazyContext, 'position')).toEqual(plotValues(materializedContext, 'position'));
    expect(lazy.orderEvents).toEqual(materialized.orderEvents);
    expect(lazy.tickAudits).toEqual(materialized.tickAudits);
  });
});
