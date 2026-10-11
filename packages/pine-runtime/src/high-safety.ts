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
    || configuration.processOrdersOnClose
  ) {
    throw new HighSafetyError(
      'HIGH_UNSUPPORTED_SCRIPT_EXECUTION',
      'High v1 поддерживает только On bar close и задержку исполнения One tick.',
      {
        calcOnOrderFills: configuration.calcOnOrderFills,
        calcOnEveryTick: configuration.calcOnEveryTick,
        calcOnEveryHistoryTick: configuration.calcOnEveryHistoryTick,
        processOrdersOnClose: configuration.processOrdersOnClose ?? false,
      },
    );
  }
}

/** Reject order shapes for which High v1 does not yet define exact fills. */
export function assertHighPendingOrdersSupported(orders: readonly StrategyBrokerPendingOrder[]): void {
  for (const order of orders) {
    if (order.type === 'stop-limit') {
      throw new HighSafetyError(
        'HIGH_UNSUPPORTED_ORDER_FEATURE',
        `High v1 не поддерживает stop-limit ордер ${order.id}.`,
        { orderId: order.id, feature: 'stop-limit' },
      );
    }
    if (order.hasTrailingParameters) {
      throw new HighSafetyError(
        'HIGH_UNSUPPORTED_ORDER_FEATURE',
        `High v1 не поддерживает trailing stop в ордере ${order.id}.`,
        { orderId: order.id, feature: 'trailing-stop' },
      );
    }
    if (order.hasOcaParameters) {
      throw new HighSafetyError(
        'HIGH_UNSUPPORTED_ORDER_FEATURE',
        `Минутный replay не поддерживает OCA-группу в ордере ${order.id}.`,
        { orderId: order.id, feature: 'oca-group' },
      );
    }
    if (order.hasImmediateExecution) {
      throw new HighSafetyError(
        'HIGH_UNSUPPORTED_ORDER_FEATURE',
        `Минутный replay не поддерживает immediately=true в ордере ${order.id}.`,
        { orderId: order.id, feature: 'immediate-execution' },
      );
    }
    if (order.category === 'exit' && (order.qty > 0 || order.qtyPercent !== undefined)) {
      throw new HighSafetyError(
        'HIGH_UNSUPPORTED_ORDER_FEATURE',
        `High v1 не поддерживает частичное закрытие в ордере ${order.id}.`,
        { orderId: order.id, feature: 'partial-exit', qty: order.qty, qtyPercent: order.qtyPercent },
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
