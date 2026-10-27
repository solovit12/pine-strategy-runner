import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BacktestReports } from '../apps/web/src/components/BacktestReports';
import { buildBacktestReport, equityCurve, reportCaption, reportStrategy, validSourceUrl } from '../apps/web/src/lib/backtest-report';
import type { BacktestRequest, BacktestResponse } from '../packages/shared/src/contracts';
import { BacktestReportSchema, TELEGRAM_CAPTION_LIMIT } from '../packages/shared/src/report-contracts';
import type { StrategyDetail } from '../packages/shared/src/strategy-catalog-contracts';

const source = '//@version=6\nstrategy("VWAP Trend [KedarArc]", overlay=true)\n';
const request = {
  source, exchange: 'Binance', marketType: 'Perpetual', symbol: 'BTCUSDT', timeframe: '15m', barIndexOffset: 0,
  dateRange: { start: '2026-07-01', end: '2026-07-10' }, initialCapital: 10_000, baseCurrency: 'USDT', defaultOrderSizeValue: 10,
  defaultOrderSizeType: 'percent_of_equity', pyramiding: 1, feeModel: 'manual', commissionType: 'percent', commissionValue: 0.05,
  marginLongPercent: 5, marginShortPercent: 5, slippagePercent: 0.2, barDetailization: 'high', calcOnOrderFills: false,
  calcOnEveryTick: false, calcOnEveryHistoryTick: false, limitOrderVerificationTicks: 0, processOrdersOnClose: false,
} as BacktestRequest;
const trade = (number: number, exitTime: string, pnl: number) => ({ number, side: 'long' as const, entryTime: exitTime, exitTime,
  entryPrice: 1, exitPrice: 1, size: 1, pnl, pnlPercent: 0, commission: 0, durationBars: 1, entrySignal: 'L', exitSignal: 'X' });
const result = {
  runId: 'run-7', warnings: ['Funding is not included.'],
  data: { provider: 'Binance Futures', symbol: 'BTCUSDT', timeframe: '15m', bars: 960 },
  configuration: { dateRange: request.dateRange, initialCapital: 10_000, baseCurrency: 'USDT', defaultOrderSizeValue: 10,
    defaultOrderSizeType: 'percent_of_equity', pyramiding: 1, commissionType: 'percent', commissionValue: 0.05, slippagePercent: 0.2,
    marginLongPercent: 5, marginShortPercent: 5, barDetailization: 'high', processOrdersOnClose: false },
  metrics: { initialCapital: 10_000, endingEquity: 9_850, netProfit: -150, openProfit: 0, totalProfit: -150, netProfitPercent: -1.5,
    totalProfitPercent: -1.5, totalTrades: 2, winRatePercent: 50, maxDrawdown: 250, maxDrawdownPercent: 2.5, profitFactor: 0.4,
    averageTrade: -75, longTrades: 2, shortTrades: 0, commissionPaid: 4 },
  trades: [trade(2, '2026-07-05T10:00:00Z', -250), trade(1, '2026-07-03T10:00:00Z', 100)],
} as unknown as BacktestResponse;
const saved = (metadata: Record<string, string>, code = source) => ({
  strategy: { id: 's1', name: 'VWAP Trend', currentVersion: 4 },
  version: { version: 4, name: 'VWAP Trend', source: code, metadata },
}) as unknown as StrategyDetail;

describe('backtest report', () => {
  it('names the strategy and its library version, and takes the source link from the library', () => {
    expect(reportStrategy(request, null)).toEqual({ name: 'VWAP Trend [KedarArc]', version: null, edited: false, sourceUrl: '' });
    const link = 'https://www.tradingview.com/script/xXSfnBVz/';
    expect(reportStrategy(request, saved({ sourceReference: link }))).toEqual({ name: 'VWAP Trend', version: 4, edited: false, sourceUrl: link });
    expect(reportStrategy(request, saved({}, `${source}// changed\n`)).edited).toBe(true);
    expect(validSourceUrl(link)).toBe(true);
    expect(validSourceUrl('tradingview.com/script/x')).toBe(false);
    expect(validSourceUrl('javascript:alert(1)')).toBe(false);
  });

  it('builds a report the server accepts, a caption Telegram accepts and the equity steps', () => {
    const report = buildBacktestReport(result, request, { name: 'VWAP Trend', version: 4, edited: false,
      sourceUrl: 'https://www.tradingview.com/script/xXSfnBVz/' }, '2026-10-27T12:00:00.000Z');
    expect(BacktestReportSchema.safeParse(report).success).toBe(true);
    const caption = reportCaption(report);
    expect(caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(caption).toContain('Бэктест: VWAP Trend');
    expect(caption).toContain('BTCUSDT · 15m · 01.07.2026 — 10.07.2026 (10 дн.)');
    expect(caption).toContain('Итог: −1,5 % (−150 USDT)');
    expect(caption).toContain('вход и стоп хуже на 0,2 %');
    expect(caption).toContain('Источник: https://www.tradingview.com/script/xXSfnBVz/');
    expect(equityCurve(result).map((point) => point.equity)).toEqual([10_000, 10_100, 9_850, 9_850]);
    expect(reportCaption({ ...report, strategyName: 'x'.repeat(200), warnings: [] }).length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
  });

  it('shows the two buttons under a finished backtest', () => {
    const markup = renderToStaticMarkup(createElement(BacktestReports, { result, request, loadedStrategy: null, onStrategySaved: () => undefined }));
    expect(markup).toContain('Add to Google Sheet');
    expect(markup).toContain('Telegram post');
  });
});
