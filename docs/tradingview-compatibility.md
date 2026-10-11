# TradingView compatibility

Pine Strategy Runner runs Pine strategies with [PineTS](https://github.com/LuxAlgo/PineTS),
an independent Pine engine (fork in `vendor/pinets`). It is not TradingView, so a
strategy can behave differently. This page lists what is tested.

## Backtest

| Feature | Status | Notes |
|---|---|---|
| Pine v5/v6 `strategy()` scripts | Partial | The tested subset matches TradingView (see below); broad language coverage is not claimed. |
| Date range | Supported | The strategy receives only candles inside the selected UTC window, so its state starts at the first selected bar. |
| Initial capital, order size, pyramiding | Supported | The form overrides the values in `strategy(...)`. Order size: fixed quantity, cash amount or percent of equity. |
| Commission | Supported | You enter the percent per fill; it is charged on entry and again on exit. |
| Slippage | Supported | A number of ticks applied to market and stop fills. |
| Long/short leverage | Partial | Manual leverage becomes Pine margin percent; `Auto` keeps the script's value. Margin liquidation is approximate. |
| Pine v5 margin defaults | Supported | Omitted `margin_long`/`margin_short` mean unlimited leverage, as on TradingView. |
| Market orders | Supported | Filled at the open of the next bar. |
| Stop-loss / take-profit | Partial | Checked on every 1-minute candle. Inside one minute the order of high and low is unknown, so a fixed rule decides (closest to the open first); a few exit prices can differ by one tick. |
| Long/short reversal | Supported | |
| Closed / open / total PnL | Supported | Shown separately. |
| Calculation timing | On bar close | `calc_on_every_tick`, `calc_on_order_fills` and history ticks are not supported. |
| `request.security` | Not supported | Rejected before running, so no wrong series is substituted. |
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

## Reference tests

The repository keeps a frozen comparison with TradingView exports
(`tests/fixtures/qualification`): seven reference strategies on Binance BTCUSDT
1h candles. Five match TradingView trade-for-trade, the stop-loss/take-profit case
matches except eight exit prices that differ by one tick, and the pyramiding case
matches with a declared bar-index offset. This shows the engine is close to
TradingView on these cases; it does not prove identical results for every script.
