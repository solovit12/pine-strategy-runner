// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LuxAlgo

import PineTS from './PineTS.class';
import { Context } from './Context.class';
import { Provider } from './marketData/Provider.class';
import { Indicator } from './Indicator';
import { PineRuntimeError } from './errors/PineRuntimeError';

// Provider classes for direct instantiation
export { BaseProvider } from './marketData/BaseProvider';
export { BinanceProvider } from './marketData/Binance/BinanceProvider.class';
export { FMPProvider } from './marketData/FMP/FMPProvider.class';
export { AlpacaProvider } from './marketData/Alpaca/AlpacaProvider.class';

// Provider types
export type { IProvider, IFootprintProvider, ISymbolInfo, BaseProviderConfig, ApiKeyProviderConfig } from './marketData/IProvider';
export { hasFootprintData } from './marketData/IProvider';
export type { Kline, FootprintBar, FootprintLevel, PeriodType } from './marketData/types';
export { computeNextPeriodStart, localTimeToUTC, computeSessionClose, TIMEFRAME_SECONDS, TIMEFRAME_PERIOD_INFO } from './marketData/types';
export { aggregateCandles, selectSubTimeframe, getAggregationRatio } from './marketData/aggregation';

export { splitTickerModifier, stripTickerModifier, withTickerModifier, decodeTickerId, encodeTickerId } from './tickerModifier';

export { PineTS, Context, Provider, Indicator, PineRuntimeError };
// Syntax check without running: Pine Strategy Runner explains code errors before a run.
export { pineToJS } from './transpiler/pineToJS/pineToJS.index';
export type { StrategyBrokerTick, StrategyBrokerTickAudit, StrategyBrokerPendingOrder, StrategyBrokerReplayController, StrategyBrokerReplayHook } from './PineTS.class';
export type { StrategyReplayOrderAudit, StrategyExternalFill, StrategyExternalFillResult } from './namespaces/strategy/utils';
export { snapshotStrategyState, restoreStrategyState, applyExternalStrategyFill } from './namespaces/strategy/utils';
export type { IPineInput, IPineProp, PineInputType, PineInputDisplay, PinePropType, PreparedScript } from './Indicator';
export { INDICATOR_PROPS, STRATEGY_PROPS, propsForDeclaration } from './Indicator';
