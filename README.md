# Pine Strategy Runner

Test a TradingView Pine strategy on history, let it trade on live prices with
virtual money, and — when you are ready — with real money on Lighter. All on your
own computer.

- **Backtest** on Binance USDⓈ-M futures history, with stops and take-profits
  checked minute by minute.
- **Paper trading** on the live order books of
  [Hyperliquid](https://hyperliquid.xyz) (including stock and commodity markets
  such as `xyz:NVDA`) and [Lighter](https://lighter.xyz). Orders fill against the
  real book with each exchange's fees and a realistic delay; Paper needs no
  exchange keys and sends no real orders.
- **LIVE trading on [Lighter](https://lighter.xyz)** (optional): connect your own
  Lighter account and the same strategy places real orders, with a daily loss
  limit, an account leverage limit, a stop resting on the exchange and a Stop
  button that closes everything. Your API key stays on your computer.
- Runs on Windows, macOS and Linux with Docker. Your strategies and results stay
  on your computer.

## Install

1. Install **Docker Desktop**: <https://www.docker.com/products/docker-desktop/>
   (on Linux, Docker Engine with the Compose plugin). Start it once and wait until
   it says it is running.
2. Create a folder, for example `pine-strategy-runner`, and save
   [`compose.yaml`](https://raw.githubusercontent.com/solovit12/pine-strategy-runner/main/compose.yaml)
   into it. Or, in a terminal:

   ```bash
   mkdir pine-strategy-runner && cd pine-strategy-runner
   curl -fsSLO https://raw.githubusercontent.com/solovit12/pine-strategy-runner/main/compose.yaml
   ```

   On Windows PowerShell use `curl.exe` instead of `curl`.
3. In that folder start it:

   ```bash
   docker compose up -d
   ```

   The first start downloads about 300 MB (about 1.1 GB on disk).
4. Open <http://127.0.0.1:18788> in your browser.

The app starts again whenever Docker starts. Keep Docker running while a Paper
run should continue: a stopped computer or Docker interrupts it.

## Use

1. **Paste your strategy.** Copy the Pine code of a strategy from TradingView
   (Pine Editor → select all → copy) into the editor, replacing the template.
2. **Backtest tab.** Choose the Binance market, timeframe and dates, enter your
   commission per fill (for example `0.05` %) and press **Run Backtest**. The chart,
   the results and every trade appear below. Strategy Properties work like the
   *Properties* tab of TradingView's Strategy Tester. **Bar Detail** checks orders on
   every minute inside each candle; choose *4 points per bar* to reproduce
   TradingView's default (free account) results.
3. **Paper tab.** Choose the timeframe, the starting balance per exchange, the
   order size and up to 10 markets on each exchange, then press **Start Paper**.
   The strategy is saved and starts trading with virtual money. A backtest first is
   optional.
4. **Paper Runs.** Open a run to see open positions, balances, the rules it trades
   by and every virtual trade. Runs continue when you close the browser; **Stop
   experiment** ends one. Up to two runs work at the same time.

**Open / Save** keep your strategies in a local library (each name once);
**Delete strategy** removes one.

## LIVE trading on Lighter (real money)

LIVE runs your strategy with real orders on your own Lighter account. It is off
until you connect an account.

1. **Create an API key on Lighter** for the account you want to trade (API key
   indexes 4–254; 0–3 belong to Lighter's own apps). Note three things: the
   **account index**, the **API key index** and the **API private key**. Use a
   separate account with a small balance.
2. **Paper tab → LIVE — real money on Lighter.** Choose the exchange (Lighter),
   enter the three values, tick **Enable LIVE mode** and press **Save**.
   **Check connection** reads your balance and open positions without trading.
3. **Set the limits**: daily loss limit (% of the account), account leverage,
   exchange-side stop distance, max slippage, max position per market or
   **Minimum order size** (every entry is the market's smallest order plus 15 %). Tick the
   real-money confirmation and press **Start LIVE**.
4. **Stop** on the run page closes every position at market. One LIVE run works
   at a time, on Lighter markets only.

**Where your key goes.** The API private key is stored only on the computer that
runs the app — in the Docker volume `psr-data`, in a file only the app can read.
It is never shown again and never sent to us or anyone else: the app signs your
orders on your computer and sends only the signed orders to Lighter. **Remove
key** deletes it; `docker compose down -v` deletes it with all other data. A
Lighter API key can trade and can withdraw only to your own wallet.

**Before you trade real money.** LIVE trading is at your own risk; past backtest
or Paper results do not predict real results. Keep the computer and Docker
running while a LIVE run works: if they stop, open positions stay on Lighter,
protected only by their exchange-side stops. The app has no login — keep it on
`127.0.0.1` (as `compose.yaml` does): anyone who can open the page can trade with
the saved key. With a key saved, run only strategy code you trust.

### What to expect

- The Pine engine is [PineTS](https://github.com/LuxAlgo/PineTS), not TradingView.
  Most strategies run the same, but not every Pine feature is supported — see
  [TradingView compatibility](docs/tradingview-compatibility.md).
- Paper is a simulation: the price, depth and timing are real, your orders are not.
  Real fills can differ (queue position, latency, slippage). Funding payments are
  not included.
- Backtests use Binance data. Binance blocks some countries (for example the
  United States); there the Backtest tab cannot load candles. Paper trading uses
  Hyperliquid and Lighter and is not affected.

## Update, stop, remove

Run these in the folder with `compose.yaml`:

| | |
|---|---|
| Update to the latest version | `docker compose pull && docker compose up -d` |
| Stop (Paper and LIVE runs stop too — stop LIVE runs on their page first) | `docker compose down` |
| Start again | `docker compose up -d` |
| Remove the app **and all its data** | `docker compose down -v` |

Strategies, settings, Paper history and a saved LIVE key live in the Docker
volume `psr-data` and survive updates.

## Running it on a server

The app has no login. `compose.yaml` therefore publishes it on `127.0.0.1` only.
On a rented server, reach it through an SSH tunnel from your computer:

```bash
ssh -N -L 18788:127.0.0.1:18788 you@your-server
```

and open <http://127.0.0.1:18788> locally. Do not publish the port to the
internet without putting authentication in front of it.

## Build it yourself

```bash
git clone https://github.com/solovit12/pine-strategy-runner.git
cd pine-strategy-runner
NAUTILUS_WHEEL=prebuilt docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

`NAUTILUS_WHEEL=prebuilt` reuses the published Nautilus Trader build;
`NAUTILUS_WHEEL=source` compiles it (20–60 minutes, several GB of memory).
Development without Docker: Node.js 24 (`npm ci`, `npm run dev`, `npm test`).

## License

[AGPL-3.0](LICENSE), like the PineTS engine it builds on. Paper trading results
are a simulation and not financial advice. LIVE trading uses real money at your
own risk.
