import type {
  StrategyBrokerPendingOrder,
  StrategyBrokerTickAudit,
} from 'pinets';

export type HighSafetyErrorKind =
  | 'HIGH_UNSUPPORTED_SYMBOL'
  | 'HIGH_UNSUPPORTED_TIMEFRAME'
  | 'HIGH_UNSUPPORTED_BAR_INDEX_OFFSET'
  | 'HIGH_UNSUPPORTED_SCRIPT_EXECUTION'
  | 'HIGH_UNSUPPORTED_ORDER_FEATURE'
  | 'HIGH_MARGIN_CALL_UNSUPPORTED';

export class HighSafetyError extends Error {
  readonly kind: HighSafetyErrorKind;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(kind: HighSafetyErrorKind, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'HighSafetyError';
    this.kind = kind;
    this.details = details;
  }
}

export interface HighRunConfiguration {
  exchange: string;
  marketType: string;
  symbol: string;
  timeframe: string;
  barIndexOffset?: number;
  calcOnOrderFills: boolean;
  calcOnEveryTick: boolean;
  calcOnEveryHistoryTick: boolean;
  processOrdersOnClose?: boolean;
}

/**
 * Validate the deliberately narrow High v1 compatibility envelope before
 * any market data is fetched or Pine code is executed.
 */
export function assertHighRunConfiguration(configuration: HighRunConfiguration): void {
  const legacyBinance = configuration.exchange === 'Binance'
    && configuration.marketType === 'Spot'
    && configuration.symbol === 'BTCUSDT';
  const archiveHyperliquid = configuration.exchange === 'Hyperliquid'
    && configuration.marketType === 'Perpetual'
    && configuration.symbol.length > 0;
  const binanceFutures = configuration.exchange === 'Binance'
    && configuration.marketType === 'Perpetual'
    && /^[A-Z0-9]+USDT$/.test(configuration.symbol);
  const archiveTimeframes = new Set(['5m', '15m', '30m', '1h', '4h', '1d', '1w']);

  if ((legacyBinance && configuration.timeframe !== '1h')
    || ((archiveHyperliquid || binanceFutures) && !archiveTimeframes.has(configuration.timeframe))) {
    throw new HighSafetyError(
      'HIGH_UNSUPPORTED_TIMEFRAME',
      archiveHyperliquid || binanceFutures
        ? 'Минутная детализация поддерживает основной таймфрейм 5m и выше; для 1m более мелких свечей нет.'
        : 'Legacy High v1 поддерживает только основной таймфрейм 1h.',
      { timeframe: configuration.timeframe },
    );
  }
  if (!legacyBinance && !archiveHyperliquid && !binanceFutures) {
    throw new HighSafetyError(
      'HIGH_UNSUPPORTED_SYMBOL',
      'Минутная детализация поддерживает Binance USD-M Perpetual и изолированные контрольные маршруты.',
      {
        exchange: configuration.exchange,
        marketType: configuration.marketType,
        symbol: configuration.symbol,
      },
    );
  }
  if ((configuration.barIndexOffset ?? 0) !== 0) {
    throw new HighSafetyError(
      'HIGH_UNSUPPORTED_BAR_INDEX_OFFSET',
      'High (экспериментальный) поддерживает только bar_index offset 0.',
      { barIndexOffset: configuration.barIndexOffset },
    );
  }
  if (
    configuration.calcOnOrderFills
    || configuration.calcOnEveryTick
    || configuration.calcOnEveryHistoryTick
  ) {
    throw new HighSafetyError(
      'HIGH_UNSUPPORTED_SCRIPT_EXECUTION',
      'High v1 поддерживает только On bar close и задержку исполнения One tick.',
      {
        calcOnOrderFills: configuration.calcOnOrderFills,
        calcOnEveryTick: configuration.calcOnEveryTick,
        calcOnEveryHistoryTick: configuration.calcOnEveryHistoryTick,
      },
    );
  }
}

/**
 * Reject order shapes for which minute replay does not define exact fills. Stop-limit orders,
 * trailing stops, partial exits and OCA groups of entry orders are replayed minute by minute.
 */
export function assertHighPendingOrdersSupported(orders: readonly StrategyBrokerPendingOrder[]): void {
  for (const order of orders) {
    if (order.trailingWithoutOffset) {
      throw new HighSafetyError(
        'HIGH_UNSUPPORTED_ORDER_FEATURE',
        `Trailing stop ${order.id} has no trail_offset, so it would never trigger; add trail_offset. / `
          + `У трейлинг-стопа ${order.id} нет trail_offset, он никогда не сработает; добавьте trail_offset.`,
        { orderId: order.id, feature: 'trailing-without-offset' },
      );
    }
    if (order.hasImmediateExecution) {
      throw new HighSafetyError(
        'HIGH_UNSUPPORTED_ORDER_FEATURE',
        `Минутный replay не поддерживает immediately=true в ордере ${order.id}.`,
        { orderId: order.id, feature: 'immediate-execution' },
      );
    }
    if (order.category === 'exit' && order.ocaName
      && orders.some((other) => other !== order && other.ocaName === order.ocaName)) {
      throw new HighSafetyError(
        'HIGH_UNSUPPORTED_ORDER_FEATURE',
        `strategy.exit ${order.id} shares the OCA group "${order.ocaName}" with another order; this is not supported yet. / `
          + `strategy.exit ${order.id} делит OCA-группу "${order.ocaName}" с другой заявкой; это пока не поддерживается.`,
        { orderId: order.id, feature: 'exit-oca-group', ocaName: order.ocaName },
      );
    }
  }
}

/** Stop instead of silently publishing a result that needed liquidation. */
export function assertHighMarginSafe(audit: StrategyBrokerTickAudit): void {
  if (!audit.marginCallRequiredBeforeFills && !audit.marginCallRequiredAfter) return;
  const beforeFills = audit.marginCallRequiredBeforeFills;
  throw new HighSafetyError(
    'HIGH_MARGIN_CALL_UNSUPPORTED',
    beforeFills
      ? 'Минутный replay остановлен: на этом движении нельзя доказать, что заявка исполнилась раньше обязательной ликвидации.'
      : 'Минутный replay остановлен: на внутрисвечной цене потребовался margin call.',
    {
      parentBarIndex: audit.parentBarIndex,
      replaySequence: audit.sequence,
      price: audit.price,
      phase: beforeFills ? 'before-order-fills' : 'after-order-fills',
      equity: beforeFills ? audit.equityBeforeFills : audit.equityAfter,
      requiredMargin: beforeFills ? audit.requiredMarginBeforeFills : audit.requiredMarginAfter,
    },
  );
}
