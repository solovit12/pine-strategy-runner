# Pine Strategy Runner

Backtest a TradingView Pine strategy on Binance minute data, then run the same
code in Paper trading on live Hyperliquid and Lighter prices — with virtual
money, without exchange keys.

> Work in progress. Installation (Docker) and usage instructions arrive with
> the first release.

## What it does

- **Backtest** a Pine strategy on Binance USDⓈ-M futures history with
  minute-level order fills.
- **Paper trading** runs the strategy on live public order books of Hyperliquid
  (including HIP-3 markets such as `xyz:NVDA`) and Lighter. Orders execute in
  virtual accounts with each exchange's fees and a modeled order arrival delay.
- **Pine compatibility.** The Pine engine is a fork of
  [PineTS](https://github.com/LuxAlgo/PineTS) (`vendor/pinets`); not every TradingView
  feature is supported (see `docs/tradingview-compatibility.md`).

## License

AGPL-3.0, like the PineTS engine it builds on.
