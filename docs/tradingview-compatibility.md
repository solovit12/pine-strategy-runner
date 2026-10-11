# TradingView compatibility

This table describes tested behavior, not all Pine Script.

| Feature | Status | Notes |
|---|---|---|
| Pine v6 strategy syntax used by Q01-Q07 | Partial | The tested subset parses; broad language coverage is not claimed. |
| Deep Backtesting date range | Supported | The runtime receives only candles inside the selected UTC window, so script state starts at the first selected bar. |
| Initial capital override | Supported | The run setting overrides `strategy(initial_capital=...)` and Pine defaults. |
| Base currency | Partial | The approved Binance USD-M Futures `BTCUSDT` route applies and reports `USDT`; currency conversion to Hyperliquid/Lighter settlement assets is not supported. |
| Default order size | Supported | Fixed quantity, cash amount and percentage-of-equity modes are exposed and applied. |
| Pyramiding | Supported | The run setting overrides `strategy(pyramiding=...)`; data-origin parity can still require an explicit `barIndexOffset`. |
| Commission override | Supported | The ordinary UI requires an explicitly entered percent value, including explicit zero if desired; no venue fee is prefilled. API-only fixed cash modes remain available for controlled comparisons. The applied method and value are returned with the result. |
| Slippage | Supported | A non-negative number of ticks can be applied to market and stop fills. |
| Long/short leverage | Partial | Manual leverage is converted to Pine margin percentage; `Auto` preserves the Pine/default behavior. PineTS margin liquidation remains approximate upstream. |
| Pine v5 margin defaults | Supported | Omitted `margin_long`/`margin_short` are normalized to 0%, matching TradingView's unlimited-leverage legacy default. Explicit values are preserved. |
| Market orders on next bar open | Supported | Q01-Q04 and Q06 match the TradingView exports trade-for-trade. |
| Commission percent | Supported | Aggregate and per-trade commission matches in the reference suite. |
| Long and short reversal | Supported | Q06 matches 75 trades exactly. |
| Stop-loss / take-profit | Partial | Q05 aggregates and times match; 8 of 20 exit prices differ by exactly 0.01 USDT. |
| Pyramiding reference parity | Partial | Q07 matches after explicit `barIndexOffset=12`; origin metadata must be supplied. |
| `bar_index` across incomplete provider history | Partial | The value depends on available prehistory; it is never silently guessed. |
| Real exchange gaps | Fail closed | The approved Binance Futures route must reject incomplete or inconsistent minute coverage; it cannot silently use Spot, 0xArchive or fabricated candles. TradingView's data can still differ. |
| Closed/open/total PnL | Supported | The UI shows PineTS closed net profit, current open profit and their sum separately. |
| Pine plots in result chart | Unsupported | The result contract reserves room for series; MVP shows candles and trade markers. |
| `request.security` / `request.security_lower_tf` | Fail closed | Executable calls are rejected before Pine execution so the engine cannot silently substitute the wrong series. |
| On bar close | Supported | The runtime calculates once per historical bar; market orders use the next available bar/tick model. |
| On order fill / `calc_on_order_fills` | Unsupported | Not shown in the UI; PineTS 0.9.33 does not implement the required recalculation loop. |
| On realtime bar tick / `calc_on_every_tick` | Unsupported | Not shown in the backtester UI; the user-facing route runs historical backtests only. The local Paper path does not execute Pine realtime. |
| On history bar tick / `calc_on_every_history_tick` | Unsupported | Not shown in the UI; PineTS 0.9.33 has no equivalent historical-tick loop. |
| Bar detailization | Partial | Above `1m`, Pine calculates on the selected parent timeframe while broker execution is checked on validated Binance Futures `1m` candles. The fixed OHLC path inside one minute is not the real trade sequence. At parent `1m`, sub-minute detail is unavailable; no universal TradingView parity is claimed. |
| Limit order verification | Unsupported | Requested-price baseline only; extra penetration ticks are locked. |
| Order execution delay | Partial | One-tick/next-available-tick is a fixed rule and is not shown as a selectable field. |
| Paper trading | Not activated | A local in-process Gateway -> Strategy Adapter -> Deadline Supervisor -> Risk -> SQLite-backed Paper Broker path exists and passes functional checks. It has no realtime Pine execution or Paper API/UI, is not deployed as a paper service, and still needs capacity and safety qualification. |
| Live exchange execution | Unsupported | Deliberately absent; requires a separate safety gate. |

## Frozen qualification result

- Exact: Q01, Q02, Q03, Q04, Q06.
- Partial: Q05, with eight one-tick exit-price differences and otherwise matching results.
- Exact with declared data-origin compatibility setting: Q07 with `barIndexOffset=12`.

These frozen Binance **Spot** results demonstrate a useful Pine-runtime regression path. They do not qualify the new Binance **Futures** route, prove profitability, or establish universal TradingView parity. A small manual check on 2026-09-20 found four 15-minute and three 1-minute displayed OHLC candles matching `BINANCE:BTCUSDT.P`; trade-level parity still requires a separate same-market validation. The earlier [Hyperliquid/0xArchive manual protocol](TRADINGVIEW_HYPERLIQUID_MANUAL_VALIDATION_V1.md) remains historical evidence only.

## User-supplied channel-strategy regression

The Pine v5 `Highest High and Lowest Low Channel Strategy` supplied by the product owner is stored as Q08. TradingView shows 0% long/short margin as `Infinity` leverage for this legacy script. With the Deep Backtesting window starting on 2025-01-01, 100,000 USDT capital and 0% commission, applying those defaults produces the same 330 closed trades, 113 winners, 34.24% win rate and 33,221.42 USDT max drawdown. Closed PnL is 1,764.87 USDT. TradingView's Total P&L also includes the open position and therefore changes with the live candle; the 2026-09-06 capture showed 1,536.43 USDT total, implying -228.44 USDT open PnL. The immutable automated regression uses frozen data ending on 2026-09-01.
