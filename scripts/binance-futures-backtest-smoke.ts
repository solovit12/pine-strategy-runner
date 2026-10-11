import { buildApp } from '../apps/api/src/server.js';
import type { BacktestResponse, PresetResponse } from '../packages/shared/src/contracts.js';

const app = await buildApp();
try {
  const presetReply = await app.inject({ method: 'GET', url: '/api/preset' });
  if (presetReply.statusCode !== 200) throw new Error(`Preset failed: HTTP ${presetReply.statusCode}`);
  const preset = presetReply.json<PresetResponse>();
  const reply = await app.inject({
    method: 'POST',
    url: '/api/backtests',
    payload: {
      source: preset.source,
      exchange: 'Binance', marketType: 'Perpetual', symbol: 'BTCUSDT', timeframe: '1h',
      dateRange: { start: '2026-09-01', end: '2026-09-07' },
      initialCapital: 100_000, baseCurrency: 'USDT',
      defaultOrderSizeValue: 0.01, defaultOrderSizeType: 'fixed', pyramiding: 1,
      feeModel: 'manual', commissionType: 'percent', commissionValue: 0.045,
      slippageTicks: 0,
    },
  });
  if (reply.statusCode !== 200) throw new Error(`Backtest failed: HTTP ${reply.statusCode} ${reply.body}`);
  const result = reply.json<BacktestResponse>();
  if (result.data.provider !== 'Binance Futures' || result.data.venue !== 'binance'
    || result.configuration.baseCurrency !== 'USDT'
    || result.configuration.feeModel !== 'manual'
    || result.configuration.commissionValue !== 0.045
    || result.data.intrabar?.bars1m !== 10_080
    || result.metrics.totalTrades < 1 || result.metrics.commissionPaid <= 0) {
    throw new Error('Backtest response did not preserve the requested Binance/fee/minute route.');
  }
  process.stdout.write(JSON.stringify({
    provider: result.data.provider,
    ticker: result.data.tradingViewTicker,
    quote: result.configuration.baseCurrency,
    parentBars: result.data.bars,
    minuteBars: result.data.intrabar.bars1m,
    commissionPercent: result.configuration.commissionValue,
    trades: result.metrics.totalTrades,
    durationMs: result.durationMs,
  }) + '\n');
} finally {
  await app.close();
}
