import type { BacktestMetrics } from '../../../../packages/shared/src/contracts';

const n = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

const metricDefinitions: Array<{ key: keyof BacktestMetrics; en: string; suffix?: string }> = [
  { key: 'totalProfit', en: 'Total PnL', suffix: ' USDT' },
  { key: 'totalProfitPercent', en: 'Total PnL', suffix: '%' },
  { key: 'netProfit', en: 'Closed PnL', suffix: ' USDT' },
  { key: 'openProfit', en: 'Open PnL', suffix: ' USDT' },
  { key: 'maxDrawdown', en: 'Max DD', suffix: ' USDT' },
  { key: 'winRatePercent', en: 'Win Rate', suffix: '%' },
  { key: 'profitFactor', en: 'Profit Factor' },
  { key: 'totalTrades', en: 'Trades' },
  { key: 'averageTrade', en: 'Average Trade', suffix: ' USDT' },
  { key: 'commissionPaid', en: 'Fees', suffix: ' USDT' },
];

export function Metrics({ metrics }: { metrics: BacktestMetrics | null }) {
  return (
    <section className="metrics-grid" aria-label="Backtest metrics">
      {metricDefinitions.map(({ key, en, suffix }) => {
        const value = metrics?.[key];
        const negative = typeof value === 'number' && value < 0;
        return (
          <article className="metric" key={String(key)}>
            <span>{en}</span>
            <strong className={negative ? 'negative' : key === 'totalProfit' ? 'positive' : ''}>
              {value == null ? '—' : `${n.format(value)}${suffix || ''}`}
            </strong>
          </article>
        );
      })}
    </section>
  );
}
