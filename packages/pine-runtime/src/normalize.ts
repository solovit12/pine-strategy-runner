import type { BacktestMetrics, NormalizedTrade } from '../../shared/src/contracts.js';

interface PineTrade {
  entry_id: string;
  entry_price: number;
  entry_bar_index: number;
  entry_time: number;
  entry_comment?: string;
  exit_id?: string;
  exit_price?: number;
  exit_bar_index?: number;
  exit_time?: number;
  exit_comment?: string;
  size: number;
  profit?: number;
  commission?: number;
}

interface PineStrategyState {
  config?: { initial_capital?: number };
  closedtrades: PineTrade[];
  opentrades?: PineTrade[];
  netprofit: number;
  grossprofit: number;
  grossloss: number;
  max_drawdown: number;
  max_drawdown_percent?: number;
  openprofit?: number;
  equity?: number;
  position_size?: number;
  wintrades: number;
}

const finite = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function normalizeStrategy(state: PineStrategyState): { metrics: BacktestMetrics; trades: NormalizedTrade[] } {
  const trades = state.closedtrades.map((trade, index): NormalizedTrade => {
    const size = Math.abs(trade.size);
    const profit = finite(trade.profit);
    const commission = finite(trade.commission);
    const entryNotional = size * trade.entry_price;
    return {
      number: index + 1,
      side: trade.size >= 0 ? 'long' : 'short',
      entryTime: new Date(trade.entry_time).toISOString(),
      exitTime: new Date(finite(trade.exit_time)).toISOString(),
      entryPrice: trade.entry_price,
      exitPrice: finite(trade.exit_price),
      size,
      pnl: profit,
      pnlPercent: entryNotional === 0 ? 0 : profit / entryNotional * 100,
      commission,
      durationBars: finite(trade.exit_bar_index) - trade.entry_bar_index,
      entrySignal: trade.entry_comment || trade.entry_id,
      exitSignal: trade.exit_comment || trade.exit_id || 'Exit',
    };
  });

  const initialCapital = finite(state.config?.initial_capital, 100_000);
  const netProfit = finite(state.netprofit);
  const openProfit = finite(state.openprofit);
  const totalProfit = netProfit + openProfit;
  const grossProfit = finite(state.grossprofit);
  const grossLoss = finite(state.grossloss);
  const longTrades = trades.filter((trade) => trade.side === 'long').length;
  const totalTrades = trades.length;
  const closedCommission = trades.reduce((sum, trade) => sum + trade.commission, 0);
  const openCommission = (state.opentrades ?? [])
    .reduce((sum, trade) => sum + finite(trade.commission), 0);
  const commissionPaid = closedCommission + openCommission;
  return {
    trades,
    metrics: {
      initialCapital,
      endingEquity: initialCapital + totalProfit,
      netProfit,
      openProfit,
      totalProfit,
      netProfitPercent: initialCapital === 0 ? 0 : netProfit / initialCapital * 100,
      totalProfitPercent: initialCapital === 0 ? 0 : totalProfit / initialCapital * 100,
      totalTrades,
      winRatePercent: totalTrades === 0 ? 0 : finite(state.wintrades) / totalTrades * 100,
      maxDrawdown: finite(state.max_drawdown),
      maxDrawdownPercent: finite(state.max_drawdown_percent, initialCapital === 0 ? 0 : finite(state.max_drawdown) / initialCapital * 100),
      profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
      averageTrade: totalTrades === 0 ? 0 : netProfit / totalTrades,
      longTrades,
      shortTrades: totalTrades - longTrades,
      commissionPaid,
    },
  };
}
