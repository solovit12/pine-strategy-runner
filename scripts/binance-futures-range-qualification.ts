import type { BacktestResponse, PresetResponse } from '../packages/shared/src/contracts.js';

interface ErrorResponse {
  error?: string;
  kind?: string;
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`--${name} requires a value.`);
  return value;
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HTTP ${response.status} did not return JSON: ${text.slice(0, 500)}`);
  }
}

const baseUrl = argument('base-url', 'http://127.0.0.1:18787').replace(/\/$/, '');
const start = argument('start', '2026-03-15');
const end = argument('end', '2026-09-19');
const expectedMinutes = positiveIntegerArgument('expected-minutes', 189 * 24 * 60);
const secondRequestDelayMs = positiveIntegerArgument('second-request-delay-ms', 250);

const presetResponse = await fetch(`${baseUrl}/api/preset`);
if (!presetResponse.ok) {
  throw new Error(`Preset failed: HTTP ${presetResponse.status} ${await presetResponse.text()}`);
}
const preset = await jsonResponse<PresetResponse>(presetResponse);
const payload = {
  source: preset.source,
  exchange: 'Binance',
  marketType: 'Perpetual',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  dateRange: { start, end },
  initialCapital: 100_000,
  baseCurrency: 'USDT',
  defaultOrderSizeValue: 0.01,
  defaultOrderSizeType: 'fixed',
  pyramiding: 1,
  feeModel: 'manual',
  commissionType: 'percent',
  commissionValue: 0.045,
  slippageTicks: 0,
};
const request = () => fetch(`${baseUrl}/api/backtests`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

const startedAt = performance.now();
const firstPromise = request();
await new Promise((resolve) => setTimeout(resolve, secondRequestDelayMs));
const second = await request();
const secondBody = await jsonResponse<ErrorResponse>(second);
if (second.status !== 409 || secondBody.kind !== 'BACKTEST_ALREADY_RUNNING') {
  throw new Error(
    `Concurrent request gate failed: HTTP ${second.status}, kind=${secondBody.kind ?? 'missing'}, error=${secondBody.error ?? 'missing'}`,
  );
}

const first = await firstPromise;
if (!first.ok) {
  throw new Error(`189-day backtest failed: HTTP ${first.status} ${await first.text()}`);
}
const result = await jsonResponse<BacktestResponse>(first);
if (result.data.provider !== 'Binance Futures' || result.data.venue !== 'binance') {
  throw new Error(`Unexpected provider: ${result.data.provider}/${result.data.venue}`);
}
if (result.data.intrabar?.bars1m !== expectedMinutes) {
  throw new Error(
    `Minute coverage mismatch: expected ${expectedMinutes}, received ${result.data.intrabar?.bars1m ?? 'missing'}`,
  );
}
if (result.configuration.dateRange.start !== start || result.configuration.dateRange.end !== end) {
  throw new Error(
    `Date range mismatch: expected ${start}..${end}, received ${result.configuration.dateRange.start}..${result.configuration.dateRange.end}`,
  );
}

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  baseUrl,
  start,
  end,
  expectedMinutes,
  minuteBars: result.data.intrabar.bars1m,
  parentBars: result.data.bars,
  providerPages: result.data.fetchedPages,
  durationMs: Math.round(performance.now() - startedAt),
  serverDurationMs: result.durationMs,
  concurrentRequest: {
    status: second.status,
    kind: secondBody.kind,
  },
})}\n`);
