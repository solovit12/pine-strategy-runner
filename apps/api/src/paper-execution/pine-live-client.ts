import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Candle } from '../../../../packages/shared/src/contracts.js';
import type { PineLiveExecutionSettings, PineLiveFill, PineLiveRunResult } from '../../../../packages/pine-runtime/src/live-engine.js';
import type { PineSymbolMarket } from '../../../../packages/pine-runtime/src/symbol-info.js';
import type { PineLiveWorkerRequest, PineLiveWorkerResponse } from './pine-live-worker.js';

const RUN_TIMEOUT_MS = 120_000;

/** Long-lived child process owning one Paper run's Pine re-runs. */
export class PineLiveClient {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, { resolve: (value: { result: PineLiveRunResult; durationMs: number }) => void;
    reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #nextId = 1;
  #ready: Promise<void>;
  #failure: Error | null = null;
  stderr = '';

  constructor(source: string, execution: PineLiveExecutionSettings, startMs: number, memoryMb = 768) {
    const development = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(development ? './pine-live-worker.ts' : './pine-live-worker.js', import.meta.url);
    this.#child = fork(fileURLToPath(workerUrl), [], {
      execArgv: [`--max-old-space-size=${memoryMb}`, ...(development ? ['--import', 'tsx'] : [])],
      env: { NODE_ENV: 'production', TZ: 'UTC', PATH: process.env.PATH },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.#child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4_000); });
    let markReady: () => void = () => undefined;
    let markFailed: (error: Error) => void = () => undefined;
    this.#ready = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject; });
    this.#ready.catch(() => undefined);
    this.#child.on('message', (message: PineLiveWorkerResponse) => {
      if (message.type === 'ready') return markReady();
      if (message.type === 'error' && message.id === null) {
        const error = new Error(`Pine live worker: ${message.message}`);
        markFailed(error);
        return this.#fail(error);
      }
      if (message.id === null) return;
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.type === 'error') waiter.reject(new Error(message.message));
      else waiter.resolve({ result: message.result, durationMs: message.durationMs });
    });
    this.#child.once('exit', (code, signal) => {
      const error = new Error(`Pine live worker exited (${code ?? signal}). ${this.stderr}`.trim());
      markFailed(error);
      this.#fail(error);
    });
    this.#send({ type: 'init', source, execution, startMs });
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const [id, waiter] of this.#pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.#pending.delete(id);
    }
  }

  #send(message: PineLiveWorkerRequest): void {
    if (this.#failure) throw this.#failure;
    this.#child.send(message);
  }

  async ready(): Promise<void> { await this.#ready; }

  async addTrack(key: string, market: PineSymbolMarket & { pineTimeframe: string }, candles: readonly Candle[]): Promise<void> {
    await this.#ready;
    this.#send({ type: 'track', key, market, candles });
  }

  async run(key: string, append: readonly Candle[], fills: readonly PineLiveFill[]): Promise<{ result: PineLiveRunResult; durationMs: number }> {
    await this.#ready;
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pine re-run exceeded ${RUN_TIMEOUT_MS} ms.`));
      }, RUN_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#send({ type: 'run', id, key, append, fills }); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error as Error); }
    });
  }

  close(): void {
    this.#fail(new Error('Pine live worker closed.'));
    if (this.#child.connected) this.#child.disconnect();
    this.#child.kill();
  }
}
