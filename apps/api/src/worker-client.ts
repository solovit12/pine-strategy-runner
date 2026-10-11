import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Candle, WorkerRequest, WorkerResponse } from '../../../packages/shared/src/contracts.js';
import type { SeriesRequest } from '../../../packages/pine-runtime/src/series-requests.js';
import type { SeriesRequestMessage, SeriesResponseMessage } from './pine-worker.js';

export interface PineWorkerRunOptions {
  timeoutMs?: number;
  memoryMb?: number;
  /** Loads another timeframe of the chart's symbol for request.security. */
  loadSeries?: (request: SeriesRequest) => Promise<Candle[]>;
}

export function runPineWorker(
  payload: WorkerRequest,
  signal?: AbortSignal,
  options: PineWorkerRunOptions = {},
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const development = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(development ? './pine-worker.ts' : './pine-worker.js', import.meta.url);
    const configuredMemoryMb = options.memoryMb ?? Number(process.env.PINE_WORKER_MAX_OLD_SPACE_MB || 384);
    const configuredTimeoutMs = options.timeoutMs ?? Number(process.env.BACKTEST_TIMEOUT_MS || 30_000);
    const memoryMb = Number.isFinite(configuredMemoryMb) && configuredMemoryMb > 0 ? configuredMemoryMb : 384;
    const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs >= 0 ? configuredTimeoutMs : 30_000;
    const child = fork(fileURLToPath(workerUrl), [], {
      execArgv: [
        `--max-old-space-size=${memoryMb}`,
        ...(development ? ['--import', 'tsx'] : []),
      ],
      env: { NODE_ENV: 'production', TZ: 'UTC' },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    let settled = false;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_000);
    });

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => {
      child.kill();
      const error = new Error('Backtest was stopped.');
      error.name = 'AbortError';
      reject(error);
    });
    // Loading request.security candles does not count against the Pine time limit.
    let remainingMs = timeoutMs;
    let startedAt = Date.now();
    const expire = () => finish(() => {
      child.kill();
      reject(new Error(`Backtest exceeded the ${timeoutMs} ms worker limit.`));
    });
    let timer = setTimeout(expire, remainingMs);
    const pauseTimer = () => { clearTimeout(timer); remainingMs -= Date.now() - startedAt; };
    const resumeTimer = () => { startedAt = Date.now(); timer = setTimeout(expire, Math.max(remainingMs, 0)); };

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, childSignal) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`Pine worker exited (${code ?? childSignal}). ${stderr}`.trim())));
      }
    });
    child.on('message', (message: WorkerResponse | SeriesRequestMessage) => {
      if ('type' in message && message.type === 'series-request') {
        const reply = (response: SeriesResponseMessage) => { if (!settled) { resumeTimer(); child.send(response); } };
        pauseTimer();
        (options.loadSeries
          ? options.loadSeries(message.request)
          : Promise.reject(new Error('This run cannot load other timeframes.')))
          .then((candles) => reply({ type: 'series-response', id: message.id, candles }))
          .catch((error: unknown) => reply({ type: 'series-response', id: message.id,
            error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      finish(() => {
        child.disconnect();
        resolve(message as WorkerResponse);
      });
    });
    child.send(payload, (error) => {
      if (error) finish(() => reject(error));
    });
  });
}
