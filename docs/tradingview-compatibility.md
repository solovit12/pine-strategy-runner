# TradingView compatibility

Pine Strategy Runner runs Pine strategies with [PineTS](https://github.com/LuxAlgo/PineTS),
an independent Pine engine (fork in `vendor/pinets`). It is not TradingView, so a
strategy can behave differently. This page lists what is tested.

## Backtest

| Feature | Status | Notes |
|---|---|---|
| Pine v5/v6 `strategy()` scripts | Partial | PineTS 0.11 covers most of the language (`switch`, tuples, methods, user types, `once`, nearly all `ta.*` functions). The tested subset matches TradingView (see below). |
| Date range | Supported | The strategy receives only candles inside the selected UTC window, so its state starts at the first selected bar. |
| Initial capital, order size, pyramiding | Supported | The form overrides the values in `strategy(...)`. Order size: fixed quantity, cash amount or percent of equity. |
| Commission | Supported | You enter the percent per fill; it is charged on entry and again on exit. |
| Slippage | Supported | A number of ticks applied to market and stop fills. |
| Long/short leverage | Partial | Manual leverage becomes Pine margin percent; `Auto` keeps the script's value. Margin liquidation is approximate. |
| Pine v5 margin defaults | Supported | Omitted `margin_long`/`margin_short` mean unlimited leverage, as on TradingView. |
| Market orders | Supported | Filled at the open of the next bar. |
| Bar detail | Supported | **Every minute** (default): stops, take-profits and limits are checked on every 1-minute candle inside the bar. **4 points per bar**: only open, high, low and close, as TradingView's Default bar detailization on a free account (no Bar Magnifier) — use it to compare with TradingView. 1m always uses 4 points. |
| Stop-loss / take-profit | Partial | With Every minute, checked on each 1-minute candle. Inside one minute (or one bar with 4 points) the order of high and low is unknown, so a fixed rule decides (closest to the open first); a few exit prices can differ by one tick. |
| Long/short reversal | Supported | |
| Closed / open / total PnL | Supported | Shown separately. |
| Calculation timing | On bar close | `calc_on_every_tick`, `calc_on_order_fills` and history ticks are not supported. |
| `process_orders_on_close` | Supported | With `strategy(process_orders_on_close=true)` market orders fill at the close of the bar that placed them, as on TradingView. |
| `strategy.close(immediately=true)` | Supported | Fills at the close of the bar that placed it. |
| Stop-limit orders | Partial | Checked minute by minute: once the stop is reached the order becomes a limit order. It fills at the stop price when that is within the limit, otherwise when price comes back to the limit. |
| Trailing stops | Partial | `strategy.exit` with `trail_price` or `trail_points` and `trail_offset`: armed when price reaches the level, then the stop follows the best price by `trail_offset` ticks. An exit re-sent with different trail values starts a new trailing stop that arms again, as on TradingView. Without `trail_offset` the run stops with a message. |
| Partial exits | Partial | `qty` / `qty_percent` in `strategy.exit` and `strategy.close`. `qty_percent` of `strategy.exit` counts from the entry size, and each `strategy.exit` id closes a trade only once, as on TradingView. |
| OCA groups | Partial | `strategy.oca.cancel` and `strategy.oca.reduce` between `strategy.entry` / `strategy.order` orders. `strategy.exit` orders that share an OCA group with another order stop the run with a message. |
| `request.security`, `request.security_lower_tf` | Partial | The chart's own symbol on another timeframe: candles come from the same exchange (2h, 45m and other day-dividing timeframes are built from smaller ones), checked for gaps. `lookahead_off` reads the last closed higher-timeframe bar, as on TradingView; a bar still open at the end of the period holds only candles closed by then. Another symbol, monthly and multi-day timeframes stop the run with a message. |
| Plots and indicators on the chart | Not shown | The chart shows candles and trade markers. |
| Data | Binance USDⓈ-M perpetuals | Gaps in the exchange data stop the backtest instead of being filled in. TradingView's own data can differ slightly. |

## Paper trading

| Feature | Status | Notes |
|---|---|---|
| Strategy calculation | On bar close | The strategy runs on each closed candle of the exchange it trades (Hyperliquid or Lighter). |
| Order execution | Modeled | Orders reach the live order book 0.2 s (entries) or 0.3 s (stops and exits) after the decision and fill against the visible book as immediate-or-cancel orders. Partial fills are real. |
| Fees | Supported | Each exchange's maker/taker rates, editable per run; HIP-3 markets pay their own rate. |
| Funding payments | Not included | |
| Real orders | Never | Paper uses virtual accounts and public market data only; no exchange keys are needed. |
| `request.security` | Partial | Higher timeframes that are multiples of the chart's, of the same symbol: history is loaded once from the exchange at start, newer bars are built from the chart's closed candles (no extra delay per signal). Lower timeframes and other symbols stop the run with a message. |

## Reference tests

A feature-check strategy (1h breakout with a 4h `request.security` trend, stop-limit entry,
OCA group, 50 % take-profit and a trailing stop re-sent each bar with an ATR offset) on
BINANCE:BTCUSDT.P, August–September 2026, matches a TradingView export trade for trade
(183 of 183) with **4 points per bar**; net profit differs by 0.6 USDT because TradingView
does not round the position to Binance's 0.001 BTC step.

The repository keeps a frozen comparison with TradingView exports
(`tests/fixtures/qualification`): seven reference strategies on Binance BTCUSDT
1h candles. Five match TradingView trade-for-trade, the stop-loss/take-profit case
matches except eight exit prices that differ by one tick, and the pyramiding case
matches with a declared bar-index offset. This shows the engine is close to
TradingView on these cases; it does not prove identical results for every script.
