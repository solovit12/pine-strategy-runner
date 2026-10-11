// SPDX-License-Identifier: AGPL-3.0-only
// This file is manually created. Can be auto-generated in the future.
// TODO: Create npm run generate:strategy-index script

export type { StrategyConfig, StrategyState, Trade, Order } from './types';

import { any } from './methods/any';
import { order } from './methods/order';
import { param } from './methods/param';
import { opentrades } from './methods/opentrades';
import { closedtrades } from './methods/closedtrades';
import { netprofit } from './methods/netprofit';
import { position_size } from './methods/position_size';
import { position_avg_price } from './methods/position_avg_price';
import { equity } from './methods/equity';
import { long } from './methods/long';
import { short } from './methods/short';
import { cash } from './methods/cash';
import { percent_of_equity } from './methods/percent_of_equity';
import { fixed } from './methods/fixed';

// Phase 1 — read-only scalar getters
import { openprofit } from './methods/openprofit';
import { openprofit_percent } from './methods/openprofit_percent';
import { netprofit_percent } from './methods/netprofit_percent';
import { grossprofit } from './methods/grossprofit';
import { grossprofit_percent } from './methods/grossprofit_percent';
import { grossloss } from './methods/grossloss';
import { grossloss_percent } from './methods/grossloss_percent';
import { wintrades } from './methods/wintrades';
import { losstrades } from './methods/losstrades';
import { eventrades } from './methods/eventrades';
import { avg_trade } from './methods/avg_trade';
import { avg_trade_percent } from './methods/avg_trade_percent';
import { avg_winning_trade } from './methods/avg_winning_trade';
import { avg_winning_trade_percent } from './methods/avg_winning_trade_percent';
import { avg_losing_trade } from './methods/avg_losing_trade';
import { avg_losing_trade_percent } from './methods/avg_losing_trade_percent';
import { max_drawdown } from './methods/max_drawdown';
import { max_drawdown_percent } from './methods/max_drawdown_percent';
import { max_runup } from './methods/max_runup';
import { max_runup_percent } from './methods/max_runup_percent';
import { max_contracts_held_all } from './methods/max_contracts_held_all';
import { max_contracts_held_long } from './methods/max_contracts_held_long';
import { max_contracts_held_short } from './methods/max_contracts_held_short';
import { position_entry_name } from './methods/position_entry_name';
import { initial_capital } from './methods/initial_capital';
import { account_currency } from './methods/account_currency';
import { margin_liquidation_price } from './methods/margin_liquidation_price';

// Phase 2 — order primitives
import { entry } from './methods/entry';
import { exit } from './methods/exit';
import { close } from './methods/close';
import { close_all } from './methods/close_all';
import { cancel } from './methods/cancel';
import { cancel_all } from './methods/cancel_all';

// Phase 5 — risk management
import { risk } from './methods/risk';

// Phase 6 — conversion
import { convert_to_account } from './methods/convert_to_account';
import { convert_to_symbol } from './methods/convert_to_symbol';
import { default_entry_qty } from './methods/default_entry_qty';

const methods = {
    any,
    order,
    param,
    opentrades,
    closedtrades,
    netprofit,
    position_size,
    position_avg_price,
    equity,
    long,
    short,
    cash,
    percent_of_equity,
    fixed,

    // Phase 1
    openprofit,
    openprofit_percent,
    netprofit_percent,
    grossprofit,
    grossprofit_percent,
    grossloss,
    grossloss_percent,
    wintrades,
    losstrades,
    eventrades,
    avg_trade,
    avg_trade_percent,
    avg_winning_trade,
    avg_winning_trade_percent,
    avg_losing_trade,
    avg_losing_trade_percent,
    max_drawdown,
    max_drawdown_percent,
    max_runup,
    max_runup_percent,
    max_contracts_held_all,
    max_contracts_held_long,
    max_contracts_held_short,
    position_entry_name,
    initial_capital,
    account_currency,
    margin_liquidation_price,

    // Phase 2
    entry,
    exit,
    close,
    close_all,
    cancel,
    cancel_all,

    // Phase 6
    convert_to_account,
    convert_to_symbol,
    default_entry_qty,
};

// Phase 4 — Constant/enum sub-namespaces.
//
// Pine exposes these as nested namespaces on `strategy`. The PineTS
// transpiler auto-CALLS bare namespace access (e.g. `strategy.commission`
// becomes `strategy.commission()`), so each sub-namespace is bound as a
// CALLABLE FACTORY that returns its constants. The script's
// `strategy.commission.percent` resolves at runtime to
// `strategy.commission().percent` — matching what the transpiler emits.
// Same hybrid pattern as `closedtrades`/`opentrades`.
const STRATEGY_DIRECTION = { long: 'long', short: 'short', all: 'all' } as const;
const STRATEGY_OCA       = { none: 'none', cancel: 'cancel', reduce: 'reduce' } as const;
const STRATEGY_COMMISSION = {
    percent: 'percent',
    cash_per_order: 'cash_per_order',
    cash_per_contract: 'cash_per_contract',
} as const;

export class Strategy {
    [key: string]: any;

    constructor(private context: any) {
        // Install methods (factory pattern; bulk bind via the index signature).
        Object.entries(methods).forEach(([name, factory]) => {
            this[name] = factory(context);
        });

        // Constant namespaces bound as callable factories.
        this.direction = () => STRATEGY_DIRECTION;
        this.oca = () => STRATEGY_OCA;
        this.commission = () => STRATEGY_COMMISSION;

        // Risk sub-namespace — callable factory returning the 6 setters.
        const riskNs = risk(context);
        this.risk = () => riskNs;
    }
}

export default Strategy;
