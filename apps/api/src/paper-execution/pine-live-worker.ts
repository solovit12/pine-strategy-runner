/**
 * Isolated process that re-runs one Paper run's Pine strategy after each
 * closed bar (see packages/pine-runtime/src/live-engine.ts). The API process
 * never executes user Pine code itself.
 */
import type { Candle } from '../../../../packages/shared/src/contracts.js';
import {
  runPineLive,
  type PineLiveExecutionSettings,
  type PineLiveFill,
} from '../../../../packages/pine-runtime/src/live-engine.js';
import type { PineSymbolMarket } from '../../../../packages/pine-runtime/src/symbol-info.js';
import { assertNoUnsupportedExternalSeries } from '../../../../packages/pine-runtime/src/pine-source-safety.js';

export type PineLiveWorkerRequest =
  | { readonly type: 'init'; readonly source: string; readonly execution: PineLiveExecutionSettings; readonly startMs: number }
  | { readonly type: 'track'; readonly key: string; readonly market: PineSymbolMarket & { readonly pineTimeframe: string };
    readonly candles: readonly Candle[] }
  | { readonly type: 'run'; readonly id: number; readonly key: string; readonly append: readonly Candle[];
    readonly fills: readonly PineLiveFill[] };

export type PineLiveWorkerResponse =
  | { readonly type: 'ready' }
  | { readonly type: 'result'; readonly id: number; readonly key: string;
    readonly result: Awaited<ReturnType<typeof runPineLive>>; readonly durationMs: number }
  | { readonly type: 'error'; readonly id: number | null; readonly message: string };

interface TrackState {
  market: PineSymbolMarket & { pineTimeframe: string };
  candles: Candle[];
  fills: PineLiveFill[];
}

let init: Extract<PineLiveWorkerRequest, { type: 'init' }> | null = null;
const tracks = new Map<string, TrackState>();
let chain: Promise<void> = Promise.resolve();

function send(message: PineLiveWorkerResponse): void {
  process.send?.(message);
}

async function handle(message: PineLiveWorkerRequest): Promise<void> {
  if (message.type === 'init') {
    assertNoUnsupportedExternalSeries(message.source);
    init = message;
    send({ type: 'ready' });
    return;
  }
  if (!init) throw new Error('Pine live worker is not initialized.');
  if (message.type === 'track') {
    tracks.set(message.key, { market: message.market, candles: [...message.candles], fills: [] });
    return;
  }
  const state = tracks.get(message.key);
  if (!state) throw new Error(`Unknown Pine live track ${message.key}.`);
  for (const candle of message.append) {
    const last = state.candles.at(-1);
    if (last && candle.openTime <= last.openTime) continue; // already known
    state.candles.push(candle);
  }
  state.fills.push(...message.fills);
  const started = Date.now();
  const result = await runPineLive({
    source: init.source, market: state.market, execution: init.execution,
    candles: state.candles, startMs: init.startMs, fills: state.fills,
  });
  send({ type: 'result', id: message.id, key: message.key, result, durationMs: Date.now() - started });
}

process.on('message', (message: PineLiveWorkerRequest) => {
  chain = chain.then(() => handle(message)).catch((error: unknown) => {
    send({ type: 'error', id: message.type === 'run' ? message.id : null,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) });
  });
});
process.on('disconnect', () => process.exit(0));
