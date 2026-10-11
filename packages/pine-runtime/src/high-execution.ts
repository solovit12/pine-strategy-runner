import type {
  PineTS,
  StrategyBrokerPendingOrder,
  StrategyBrokerReplayController,
  StrategyBrokerTickAudit,
  StrategyReplayOrderAudit,
} from 'pinets';
import {
  assertHighMarginSafe,
  assertHighPendingOrdersSupported,
} from './high-safety.js';
import type {
  HighDetailizationData,
  ReplayBar,
  ReplayTick,
} from '../../market-data/src/high-detailization.js';

export interface HighExecutionEvidence {
  readonly tickAudits: StrategyBrokerTickAudit[];
  readonly orderEvents: StrategyReplayOrderAudit[];
  /**
   * Validate orders created by the Pine body on the final parent bar.
   * The regular replay hook runs before Pine, so without this final check an
   * unsupported order created on the last bar would have no next hook to
   * reject it.
   */
  assertFinalPendingOrdersSupported(): void;
}

export interface HighExecutionOptions {
  /**
   * Retaining every replay audit is useful for qualification tests, but it is
   * unnecessary for the production worker and grows linearly with every
   * execution-minute tick. Keep the public default for existing callers while
   * allowing the isolated worker to avoid holding the full audit history.
   */
  retainAudit?: boolean;
  /** Derive the four deterministic OHLC ticks lazily from replay bars. */
  deriveTicksFromBars?: boolean;
  /** Required when deriveTicksFromBars is enabled. */
  deriveTickSize?: number;
}

function key(parentBarIndex: number, replayBarIndex: number): string {
  return `${parentBarIndex}:${replayBarIndex}`;
}

function replayStage(tick: ReplayTick, bar: ReplayBar): 'open' | 'high' | 'low' | 'close' {
  if (tick.stage === 'open' || tick.stage === 'close') return tick.stage;
  const highFirst = Math.abs(bar.open - bar.high) <= Math.abs(bar.open - bar.low);
  if (tick.stage === 'firstExtreme') return highFirst ? 'high' : 'low';
  return highFirst ? 'low' : 'high';
}

function replayTime(tick: ReplayTick, bar: ReplayBar, stage: 'open' | 'high' | 'low' | 'close'): number {
  if (stage === 'open') return tick.sourceOpenTime;
  if (stage === 'close') return bar.closeTime;
  return tick.sourceOpenTime + (tick.sequence % 4);
}

function assertParentReplay(ticks: ReplayTick[], parentBarIndex: number): void {
  if (ticks.length === 0 || ticks.length % 4 !== 0) {
    throw new Error(`HIGH_REPLAY_INVALID: parent bar ${parentBarIndex} requires a non-empty multiple of four replay points; received ${ticks.length}.`);
  }
  const actual = ticks.map((tick) => tick.sequence);
  if (actual.some((sequence, index) => sequence !== index)) {
    throw new Error(
      `HIGH_REPLAY_INVALID: parent bar ${parentBarIndex} replaySequence must be 0..${ticks.length - 1}.`,
    );
  }
}

function derivedTicks(bar: ReplayBar, tickSize: number): ReplayTick[] {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error('HIGH_REPLAY_INVALID: a positive finite tick size is required for lazy replay ticks.');
  }
  const highFirst = Math.abs(bar.open - bar.high) <= Math.abs(bar.open - bar.low);
  const stages: Array<{ stage: ReplayTick['stage']; price: number }> = highFirst
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
  return stages.map((item, stageIndex) => {
    const normalized = Math.round(item.price / tickSize);
    if (!Number.isSafeInteger(normalized)) {
      throw new Error(`HIGH_REPLAY_INVALID: replay price ${item.price} exceeds the safe tick range.`);
    }
    return {
      parentBarIndex: bar.parentBarIndex,
      replayBarIndex: bar.replayBarIndex,
      stage: item.stage,
      sequence: bar.replayBarIndex * 4 + stageIndex,
      sourceOpenTime: bar.openTime,
      price: item.price,
      priceTicks: normalized,
    };
  });
}

/**
 * Attach validated H1 replay points to the opt-in PineTS source-fork seam.
 * This function only configures execution. It does not run Pine and it does
 * not change the Default path used when no hook is attached.
 */
export function attachHighBrokerReplay(
  pine: Pick<PineTS, 'setStrategyBrokerReplayHook'>,
  detailization: Pick<HighDetailizationData, 'replayBars' | 'replayTicks'>,
  options: HighExecutionOptions = {},
): HighExecutionEvidence {
  const deriveTicksFromBars = options.deriveTicksFromBars ?? false;
  if (deriveTicksFromBars && detailization.replayTicks.length > 0) {
    throw new Error('HIGH_REPLAY_INVALID: lazy replay cannot also include materialized ticks.');
  }
  const bars = deriveTicksFromBars
    ? new Map<string, ReplayBar>()
    : new Map(detailization.replayBars.map((bar) => [key(bar.parentBarIndex, bar.replayBarIndex), bar]));
  const barsByParent = new Map<number, ReplayBar[]>();
  if (deriveTicksFromBars) {
    for (const bar of detailization.replayBars) {
      const list = barsByParent.get(bar.parentBarIndex) ?? [];
      list.push(bar);
      barsByParent.set(bar.parentBarIndex, list);
    }
    for (const [parentBarIndex, parentBars] of barsByParent) {
      parentBars.sort((left, right) => left.replayBarIndex - right.replayBarIndex);
      if (parentBars.length === 0
        || parentBars.some((bar, index) => bar.replayBarIndex !== index)) {
        throw new Error(
          `HIGH_REPLAY_INVALID: parent bar ${parentBarIndex} replayBarIndex must be contiguous from zero.`,
        );
      }
    }
  }
  const ticksByParent = new Map<number, ReplayTick[]>();
  for (const tick of detailization.replayTicks) {
    const list = ticksByParent.get(tick.parentBarIndex) ?? [];
    list.push(tick);
    ticksByParent.set(tick.parentBarIndex, list);
  }
  for (const [parentBarIndex, ticks] of ticksByParent) {
    ticks.sort((left, right) => left.sequence - right.sequence);
    assertParentReplay(ticks, parentBarIndex);
  }

  const tickAudits: StrategyBrokerTickAudit[] = [];
  const orderEvents: StrategyReplayOrderAudit[] = [];
  const retainAudit = options.retainAudit ?? true;
  const processReplayTick = (
    controller: StrategyBrokerReplayController,
    tick: ReplayTick,
    bar: ReplayBar,
  ) => {
    const stage = replayStage(tick, bar);
    const audit = controller.processTick({
      price: tick.price,
      priceTicks: tick.priceTicks,
      time: replayTime(tick, bar, stage),
      label: `${tick.replayBarIndex}:${tick.stage}`,
      stage,
      replaySequence: tick.sequence,
      replayOpenTime: tick.sourceOpenTime,
    });
    if (retainAudit) {
      tickAudits.push(audit);
      orderEvents.push(...audit.events);
    }
    assertHighMarginSafe(audit);
  };
  let readLatestPendingOrders: (() => readonly StrategyBrokerPendingOrder[]) | undefined;
  pine.setStrategyBrokerReplayHook((controller: StrategyBrokerReplayController) => {
    // `pendingOrders` is a live read-only getter over the strategy ledger.
    // Retaining only a reader lets the caller validate final-bar orders after
    // Pine has run without keeping the replay controller active for ticks.
    readLatestPendingOrders = () => controller.pendingOrders;
    assertHighPendingOrdersSupported(controller.pendingOrders);
    if (deriveTicksFromBars) {
      const parentBars = barsByParent.get(controller.parentBarIndex);
      if (!parentBars) {
        throw new Error(`HIGH_REPLAY_INVALID: no replay data for parent bar ${controller.parentBarIndex}.`);
      }
      for (const bar of parentBars) {
        for (const tick of derivedTicks(bar, options.deriveTickSize ?? Number.NaN)) {
          processReplayTick(controller, tick, bar);
        }
      }
      return;
    }
    const ticks = ticksByParent.get(controller.parentBarIndex);
    if (!ticks) {
      throw new Error(`HIGH_REPLAY_INVALID: no replay data for parent bar ${controller.parentBarIndex}.`);
    }
    for (const tick of ticks) {
      const bar = bars.get(key(tick.parentBarIndex, tick.replayBarIndex));
      if (!bar) {
        throw new Error(`HIGH_REPLAY_INVALID: replay bar ${tick.parentBarIndex}:${tick.replayBarIndex} is missing.`);
      }
      processReplayTick(controller, tick, bar);
    }
  });
  return {
    tickAudits,
    orderEvents,
    assertFinalPendingOrdersSupported() {
      assertHighPendingOrdersSupported(readLatestPendingOrders?.() ?? []);
    },
  };
}
