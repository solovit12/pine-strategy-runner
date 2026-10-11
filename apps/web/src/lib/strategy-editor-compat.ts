import type { StrategyBacktestSettings } from '../../../../packages/shared/src/strategy-catalog-contracts';

const EDITOR_TIMEFRAMES = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);

export function backtestSettingsSupportedByEditor(settings: StrategyBacktestSettings): boolean {
  return settings.exchange === 'Binance'
    && settings.marketType === 'Perpetual'
    && /^[A-Z0-9]+USDT$/.test(settings.symbol)
    && EDITOR_TIMEFRAMES.has(settings.timeframe)
    && settings.barIndexOffset === 0
    && (settings.baseCurrency === undefined || settings.baseCurrency === 'USDT')
    && settings.feeModel === 'manual'
    && settings.commissionType === 'percent'
    && (settings.barDetailization === undefined || settings.barDetailization === (settings.timeframe === '1m' ? 'default' : 'high'))
    && settings.calcOnOrderFills === false
    && settings.calcOnEveryTick === false
    && settings.calcOnEveryHistoryTick === false
    && settings.limitOrderVerificationTicks === 0
    && settings.processOrdersOnClose === false;
}
