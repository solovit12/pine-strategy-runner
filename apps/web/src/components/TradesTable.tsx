import { useEffect, useState } from 'react';
import type { NormalizedTrade } from '../../../../packages/shared/src/contracts';

const TRADES_PER_PAGE = 20;

const price = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Sizes keep exchange precision but drop floating-point noise such as 11.543316999999998.
const quantity = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 });
const utc = (value: string) => new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));

export function TradesTable({ trades }: { trades: NormalizedTrade[] }) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(trades.length / TRADES_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const visibleTrades = trades.slice((currentPage - 1) * TRADES_PER_PAGE, currentPage * TRADES_PER_PAGE);

  useEffect(() => {
    setPage(1);
  }, [trades]);

  return (
    <section className="trades-panel">
      <div className="panel-heading compact">
        <div><span className="eyebrow">EXECUTION LOG</span><h2>Trades</h2></div>
        <span className="trade-count">{trades.length} closed</span>
      </div>
      <div className="table-wrap">
        <table id="trades-table">
          <thead><tr><th>#</th><th>Side</th><th>Entry · UTC</th><th>Exit · UTC</th><th>Entry</th><th>Exit</th><th>Size</th><th>PnL</th><th>PnL %</th></tr></thead>
          <tbody>
            {trades.length === 0 && <tr><td colSpan={9} className="empty-row">No trades yet</td></tr>}
            {visibleTrades.map((trade) => (
              <tr key={trade.number}>
                <td>{String(trade.number).padStart(2, '0')}</td>
                <td><span className={`side ${trade.side}`}>{trade.side === 'long' ? 'Long' : 'Short'}</span></td>
                <td>{utc(trade.entryTime)}</td><td>{utc(trade.exitTime)}</td>
                <td>{price.format(trade.entryPrice)}</td><td>{price.format(trade.exitPrice)}</td>
                <td>{quantity.format(trade.size)}</td>
                <td className={trade.pnl >= 0 ? 'positive' : 'negative'}>{price.format(trade.pnl)}</td>
                <td className={trade.pnl >= 0 ? 'positive' : 'negative'}>{price.format(trade.pnlPercent)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {trades.length > TRADES_PER_PAGE && (
        <nav className="trades-pagination" aria-label="Trades pagination">
          <button className="trades-page-button" type="button" aria-controls="trades-table" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
          <span className="trades-page-status" aria-live="polite">Page {currentPage} of {totalPages}</span>
          <button className="trades-page-button" type="button" aria-controls="trades-table" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>Next</button>
        </nav>
      )}
    </section>
  );
}
