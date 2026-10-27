import type { BacktestRequest, BacktestResponse } from '../../../../packages/shared/src/contracts';
import { TELEGRAM_CAPTION_LIMIT, type BacktestReport } from '../../../../packages/shared/src/report-contracts';
import type { StrategyDetail } from '../../../../packages/shared/src/strategy-catalog-contracts';

/** Which strategy a backtest ran: the library version when its code is the backtested code. */
export function reportStrategy(request: BacktestRequest, loaded: StrategyDetail | null): {
  name: string; version: number | null; edited: boolean; sourceUrl: string;
} {
  const declared = /\bstrategy\s*\(\s*(?:title\s*=\s*)?['"]([^'"]+)['"]/.exec(request.source)?.[1]?.trim();
  if (!loaded) return { name: declared || 'Pine strategy', version: null, edited: false, sourceUrl: '' };
  return {
    name: loaded.version.name, version: loaded.version.version, edited: loaded.version.source !== request.source,
    sourceUrl: loaded.version.metadata.sourceReference ?? '',
  };
}

/** True for a link the report accepts: http(s) to a named site. */
export function validSourceUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && /\.[a-z]{2,}$/i.test(url.hostname) && value.trim().length <= 500;
  } catch {
    return false;
  }
}

export function buildBacktestReport(result: BacktestResponse, request: BacktestRequest, strategy: {
  name: string; version: number | null; edited: boolean; sourceUrl: string;
}, backtestedAt: string): BacktestReport {
  const { metrics, configuration } = result;
  return {
    runId: result.runId, backtestedAt, strategyName: strategy.name.slice(0, 200), strategyVersion: strategy.version,
    strategyEdited: strategy.edited, sourceUrl: strategy.sourceUrl.trim(), dataSource: result.data.provider,
    symbol: result.data.symbol, timeframe: result.data.timeframe, dateRange: configuration.dateRange, bars: result.data.bars,
    currency: configuration.baseCurrency,
    metrics: {
      initialCapital: metrics.initialCapital, endingEquity: metrics.endingEquity, netProfit: metrics.netProfit, openProfit: metrics.openProfit,
      totalProfit: metrics.totalProfit, totalProfitPercent: metrics.totalProfitPercent, totalTrades: metrics.totalTrades,
      winRatePercent: metrics.winRatePercent, maxDrawdown: metrics.maxDrawdown, maxDrawdownPercent: metrics.maxDrawdownPercent,
      profitFactor: metrics.profitFactor, averageTrade: metrics.averageTrade, longTrades: metrics.longTrades,
      shortTrades: metrics.shortTrades, commissionPaid: metrics.commissionPaid,
    },
    settings: {
      orderSizeValue: configuration.defaultOrderSizeValue, orderSizeType: configuration.defaultOrderSizeType,
      pyramiding: configuration.pyramiding, commissionType: configuration.commissionType, commissionValue: configuration.commissionValue,
      slippagePercent: configuration.slippagePercent, marginLongPercent: configuration.marginLongPercent,
      marginShortPercent: configuration.marginShortPercent, barDetailization: configuration.barDetailization,
      processOrdersOnClose: request.processOrdersOnClose ?? configuration.processOrdersOnClose,
    },
    warnings: result.warnings.slice(0, 50).map((warning) => warning.slice(0, 1_000)),
  };
}

/** The account after each closed trade, from the start of the period. */
export function equityCurve(result: BacktestResponse): { time: number; equity: number }[] {
  const start = Date.parse(`${result.configuration.dateRange.start}T00:00:00Z`);
  const points = [{ time: start, equity: result.metrics.initialCapital }];
  let equity = result.metrics.initialCapital;
  for (const trade of [...result.trades].sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime))) {
    equity += trade.pnl;
    points.push({ time: Date.parse(trade.exitTime), equity });
  }
  const end = Date.parse(`${result.configuration.dateRange.end}T23:59:59Z`);
  points.push({ time: Math.max(end, points.at(-1)!.time), equity: result.metrics.endingEquity });
  return points;
}

const number = (value: number, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
export const signed = (value: number, digits = 2) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value), digits)}`;
export const ruDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export function periodDays(report: BacktestReport): number {
  return Math.round((Date.parse(`${report.dateRange.end}T00:00:00Z`) - Date.parse(`${report.dateRange.start}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The test's conditions in one line: what makes the result honest. */
export function conditionsText(report: BacktestReport): string {
  const { settings: s, currency } = report;
  const size = s.orderSizeType === 'percent_of_equity' ? `${number(s.orderSizeValue)} % капитала`
    : s.orderSizeType === 'cash' ? `${number(s.orderSizeValue)} ${currency}` : `${number(s.orderSizeValue, 8)} (кол-во)`;
  const fee = s.commissionType === 'percent' ? `${number(s.commissionValue, 4)} %`
    : `${number(s.commissionValue, 4)} ${currency} ${s.commissionType === 'cash_per_contract' ? 'за контракт' : 'за заявку'}`;
  return [
    `капитал ${number(report.metrics.initialCapital)} ${currency}`, `сделка ${size}`, `комиссия ${fee} за исполнение`,
    `вход и стоп хуже на ${number(s.slippagePercent)} %`, s.barDetailization === 'high' ? 'проверка по минутам' : 'проверка по 4 точкам свечи',
  ].join(' · ');
}

/** The post under the picture (Russian, the owner's channel); the owner can edit it before sending. */
export function reportCaption(report: BacktestReport): string {
  const m = report.metrics;
  const lines = [
    `Бэктест: ${report.strategyName}`,
    `${report.symbol} · ${report.timeframe} · ${ruDate(report.dateRange.start)} — ${ruDate(report.dateRange.end)} (${periodDays(report)} дн.)`,
    '',
    `Итог: ${signed(m.totalProfitPercent)} % (${signed(m.totalProfit)} ${report.currency})`,
    `Сделок: ${m.totalTrades} · прибыльных ${number(m.winRatePercent, 1)} %`,
    `Макс. просадка: ${number(m.maxDrawdownPercent)} % · Profit factor: ${m.profitFactor === null ? '—' : number(m.profitFactor)}`,
    '',
    `Условия: ${conditionsText(report)}.`,
    `Данные: ${report.dataSource}.`,
    '',
    `Источник: ${report.sourceUrl}`,
  ];
  return lines.join('\n').slice(0, TELEGRAM_CAPTION_LIMIT);
}
