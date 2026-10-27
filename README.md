# Svit Runner

Svit Runner is a web application for testing trading strategies on historical and live
market data. You bring a [TradingView Pine Script](https://www.tradingview.com/pine-script-docs/)
strategy; the app backtests it on exchange history, runs it on live order books with virtual money
(Paper), and — only if you choose to — trades it with real money on your own
[Lighter](https://lighter.xyz) and [Hyperliquid](https://hyperliquid.xyz) accounts (LIVE).

It runs on your own computer (or your own server) in Docker. There are no TradingView alerts or
webhooks, no cloud account and no sign-up: your strategies, results and exchange keys stay on your
machine.

```text
Pine strategy ──► Backtest ──► Paper ──► LIVE
 (your code)     (history)    (live prices,   (real orders,
                               virtual money)  your account)
```

---

## Contents

1. [What it does](#what-it-does)
2. [How it works](#how-it-works)
3. [Install](#install)
4. [Quick start: from a Pine strategy to a Paper run in five minutes](#quick-start)
5. [The strategy editor and the library](#the-strategy-editor-and-the-library)
6. [Backtest](#backtest)
7. [Paper trading](#paper-trading)
8. [Python strategies](#python-strategies)
9. [Runs: watching a run](#runs-watching-a-run)
10. [Accounts: connecting exchanges for LIVE](#accounts-connecting-exchanges-for-live)
11. [LIVE trading (real money)](#live-trading-real-money)
12. [Your keys and your safety](#your-keys-and-your-safety)
13. [Limits at a glance](#limits-at-a-glance)
14. [What to expect: accuracy and differences from TradingView](#what-to-expect)
15. [Update, stop, back up, remove](#update-stop-back-up-remove)
16. [Running it on a server](#running-it-on-a-server)
17. [Troubleshooting and FAQ](#troubleshooting-and-faq)
18. [Build it yourself and develop](#build-it-yourself-and-develop)
19. [How the code is organised](#how-the-code-is-organised)
20. [License and disclaimer](#license-and-disclaimer)

---

## What it does

| | What you get | Money |
|---|---|---|
| **Backtest** | Your Pine strategy on Binance USDⓈ-M perpetual futures history, with stops, take-profits and limits checked on every minute inside each bar. Chart with trade markers, metrics and every trade. | none |
| **Paper** | The same strategy running in real time on the live order books of Lighter and Hyperliquid (including Hyperliquid's stock, index and commodity markets such as `xyz:NVDA`), up to 15 markets per exchange. Orders fill against the real book with each exchange's fees and a realistic delay. | virtual balance |
| **LIVE** | The same strategy placing real orders on your own Lighter and/or Hyperliquid account, with a daily loss limit, an account leverage limit, a stop resting on the exchange and a Stop button that closes everything. | your real money |
| **Python strategies** | Your own Python classes for logic Pine cannot express: they react to every price change in Paper and LIVE (not in Backtest). | — |
| **Accounts** | A page with your exchange accounts and their API keys. Each LIVE run picks one account per exchange; different accounts can trade LIVE side by side. | — |

Runs on Windows, macOS and Linux with Docker Desktop (or Docker Engine on Linux).

## How it works

```text
           ┌────────────── your computer (Docker) ──────────────┐
 browser ─►│ web app ──► Pine engine (PineTS)                    │
           │               │ decides on each closed bar          │
           │               ▼                                     │
           │          order engine (Nautilus Trader)             │──► Binance history (Backtest)
           │           Paper: virtual account, real books        │──► Lighter / Hyperliquid
           │           LIVE: your account, real orders           │    public market data (Paper, LIVE)
           │               │                                     │──► your exchange account (LIVE only,
           │          local database: strategies, runs, keys     │    signed orders)
           └─────────────────────────────────────────────────────┘
```

- **The Pine engine** is [PineTS](https://github.com/LuxAlgo/PineTS) (a pinned, patched copy in
  `vendor/pinets`). It is an independent implementation of Pine, not TradingView itself — see
  [what to expect](#what-to-expect).
- **Backtest** loads public Binance USDⓈ-M futures candles (no Binance account or key) and replays
  your orders on minute candles.
- **Paper and LIVE** run your strategy on each closed candle of the exchange it trades, and hand its
  orders to [Nautilus Trader](https://nautilustrader.io), which executes them in real time: against a
  virtual account in Paper, against your account in LIVE. Paper uses public market data only and
  needs no keys.
- Everything is stored in one Docker volume (`psr-data`): the strategy library, the history of runs,
  and — if you connect an account — your exchange API keys.

## Install

You need **Docker**:

- Windows and macOS: [Docker Desktop](https://www.docker.com/products/docker-desktop/). Start it once
  and wait until it says it is running.
- Linux: Docker Engine with the Compose plugin.

About 1.1 GB of disk space (the first start downloads about 300 MB) and any recent 64-bit computer.

1. Create a folder, for example `svit-runner`, and save
   [`compose.yaml`](https://raw.githubusercontent.com/solovit12/svit-runner/main/compose.yaml)
   into it. Or, in a terminal:

   ```bash
   mkdir svit-runner && cd svit-runner
   curl -fsSLO https://raw.githubusercontent.com/solovit12/svit-runner/main/compose.yaml
   ```

   On Windows PowerShell write `curl.exe` instead of `curl`.
2. In that folder start the app:

   ```bash
   docker compose up -d
   ```

3. Open <http://127.0.0.1:18788> in your browser.

The app starts again by itself whenever Docker starts. A Paper or LIVE run only works while the
computer and Docker are running: closing the browser is fine, shutting the computer down is not
(see [what a restart does](#what-happens-when-the-computer-or-docker-restarts)).

`compose.yaml` publishes the app on `127.0.0.1` only, so other computers on your network cannot open
it. This matters: the app has no login.

## Quick start

1. **Copy a strategy from TradingView.** Open your strategy in TradingView's Pine Editor, select all,
   copy.
2. **Paste it into the editor** of Svit Runner (the **Strategy** page), replacing the
   template.
3. **Backtest tab.** Choose a Binance market (for example `BTCUSDT`), a timeframe and dates, enter
   your commission per fill (for example `0.05` %), press **Run Backtest**. The chart, the metrics and
   every trade appear below.
4. **Paper tab.** Choose the timeframe, a starting balance per exchange, the order size and the
   markets — you can type several at once: `BTC, ETH SOL`. Press **Start Paper**.
5. **Runs** (top menu) shows the run: open positions, balances, profit and loss, events and
   every virtual trade. The run keeps going after you close the browser.

A backtest before Paper is optional.

## The strategy editor and the library

- **Editor.** A code editor for Pine v5/v6 `strategy()` scripts. Your current code is kept in the
  browser, so a page reload does not lose it.
- **Open / Save.** The library keeps your strategies in the local database: the Pine code, the
  backtest settings and the last Paper settings together. Each name is used once; saving again
  replaces the saved strategy of that name. **Save as a separate strategy** creates another entry.
  **Source link** (optional) keeps where the strategy comes from, for example its TradingView page;
  the library shows it as a link.
- **Delete strategy** removes one from the library (runs that already used it keep their own copy).
- Starting Paper or LIVE saves the strategy and its settings automatically, so a run always knows the
  exact code it runs.

## Backtest

The Backtest tab answers: *what would this strategy have done on these past candles, with these
rules and costs?* It does not predict future profit.

| Field | Meaning |
|---|---|
| Market | A Binance USDⓈ-M perpetual (for example `BTCUSDT`; compare on TradingView with `BINANCE:BTCUSDT.P`). |
| Timeframe | `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`. The strategy calculates on closed bars of this timeframe. |
| From / To | UTC dates. *From* starts at 00:00 UTC, *To* is included whole. No hidden warm-up: an SMA of 200 has no full value on the first 199 bars. |
| Initial capital, order size, pyramiding | Override the values in `strategy(...)`, like TradingView's *Properties* tab. Order size: fixed quantity, cash amount or percent of equity. |
| Commission | Percent per fill, charged on entry and again on exit. You enter it explicitly. |
| Execution cost per fill | Percent of the price by which every market and stop fill is worse (entries at market or on a stop, stop-losses, trailing stops, market exits); limits and take-profits fill at their price. Default 0.2 %, what real fills cost in our Paper tests compared with backtests of the same days. Set 0 to match TradingView. |
| Long / short leverage | Becomes Pine's margin percent; *Auto* keeps the script's value. Liquidation is approximate. |
| Bar detail | **Every minute** (default): stops, take-profits and limits are checked on every 1-minute candle inside the bar. **4 points per bar**: only open, high, low and close, as TradingView's default on a free account — use it to reproduce TradingView's numbers. |

**Results:** a candle chart with entry and exit markers, metrics (closed, open and total PnL, max
drawdown, profit factor, win rate, fees paid, number of trades, average trade) and a paginated list
of every trade.

**How long a test can be:** one backtest runs at a time, within a budget of minute candles (by default
120 days of 1-minute candles; a server can raise it to 189 days with
`BACKTEST_MAX_EXECUTION_MINUTES`). Longer periods on higher timeframes cost the same number of minutes,
because orders are always checked minute by minute.

**Gaps:** a gap in Binance data stops the backtest with a message instead of being filled in.

More: [TradingView compatibility](docs/tradingview-compatibility.md) (what is supported, what is
not), [strategy properties](docs/strategy-properties.md) (each setting explained, in Russian).

## Paper trading

Paper runs **your saved Pine strategy itself** in real time — it does not replay the backtest. After
every closed candle of the exchange it trades, the strategy is evaluated again and its orders are
executed against the live order book with virtual money.

### Setting up a run (Paper tab)

| Field | Meaning |
|---|---|
| Run mode | **Paper — virtual money** or **LIVE — real money** (see [LIVE](#live-trading-real-money)). |
| Strategy type | **Pine code** (the editor or a saved strategy) or **Python strategy** (see [Python strategies](#python-strategies)). |
| Timeframe | `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, on the exchange's own candles. |
| Markets | Any USDC perpetual of Lighter and Hyperliquid, up to **15 per exchange** (30 per run). The list is ordered by 24 h volume. **Type or paste several at once**, separated by commas, spaces or semicolons (`BTC, ETH sol`): Enter or **Add all** adds every market found on that exchange and tells you what was not found, what was already chosen and what did not fit. **Add to both exchanges** adds a market to the other exchange too when it is listed there. |
| Balance per exchange | The virtual account each exchange starts with (USDC). Markets of one exchange share its account. |
| Order size | Percent of that exchange's virtual balance per entry. |
| Fees | Maker and taker percent per exchange, prefilled with each exchange's public base fees (Hyperliquid 0.015 % / 0.045 %, Lighter 0 % / 0 %), editable. |

**Hyperliquid `xyz:` markets** (stocks, indices, commodities by trade.xyz) each pay their own fee,
shown as a multiple of the Hyperliquid fee, and trade thinly while their home exchange is closed —
the form warns about this.

### How orders execute in Paper

- Market orders reach the live book about **0.2 s** after the strategy sends them and fill as
  immediate-or-cancel against the visible book.
- Limit orders and take-profits fill when the opposite best price reaches them.
- Stops, stop-losses and trailing stops trigger on the live best price, then execute **0.3 s** later.
- Partial fills are real: the rest of an exit keeps working; an entry keeps what filled.
- A run starts **flat**: trades the strategy "had" in history before the start are followed without
  real size, so the strategy is in the right state without inventing positions.
- Funding payments are not included in profit and loss.
- If one market's data stops, that market waits for a fresh order book while the others keep trading.

Up to **six runs** (Paper and LIVE together) work at the same time.

## Python strategies

Besides Pine, **Paper and LIVE** run strategies written in Python. Choose Python when Pine is not
enough: the strategy can react to **every price change** (not only to closed candles), see the best bid
and ask, the market's public trades and their volume, and keep any state you like in ordinary Python
code. Backtest runs Pine only, so test a Python strategy in Paper first.

### Where your strategies live

With Docker, put them in the folder **`my_strategies` next to `compose.yaml`**. Docker creates the
folder at the first `docker compose up -d`; the app only reads it.

- Every `.py` file in it (or a sub-folder with `__init__.py`) is loaded, and every strategy class in it
  appears on the Paper tab as `my_strategies/<file>:<Class>`.
- Edit the files with any editor. The list on the Paper tab refreshes within 15 seconds: reopen the
  tab to see a new strategy or a change.
- A run keeps the code it started with; a change applies to new runs. Each run records a fingerprint
  (SHA-256) of the folder's code in its settings.
- `my_strategies` lives outside the Docker volume: keep your own copy (or a private Git repository).

An installation from before Python strategies has an older `compose.yaml`: download it again (see
[Install](#install)) or add these lines to the `psr` service, then run `docker compose up -d`:

```yaml
    environment:
      PSR_STRATEGY_PACKS: /strategies/my_strategies
    volumes:
      - psr-data:/data
      - ./my_strategies:/strategies/my_strategies:ro
```

More folders work the same way: mount each one under `/strategies/` and list them in
`PSR_STRATEGY_PACKS` separated by `:`. A folder name becomes the strategy's group name, so it may
only contain letters, digits and `_` and must not start with a digit. Without Docker, set
`PSR_STRATEGY_PACKS=/path/to/my_strategies` before `npm start`.

### Your first strategy

Save this as `my_strategies/ema_cross.py`:

```python
from psr_sdk import Param, Strategy
from psr_sdk.ta import crossover, crossunder, ema


class EmaCross(Strategy):
    name = "EMA cross"
    description = "Long when the fast EMA crosses above the slow one, short when it crosses below."
    timeframe = "15m"        # default candle size; the Paper form can change it
    warmup_bars = 300        # closed candles replayed before the start (no trading)
    params = {               # each one becomes a field of the Paper form
        "fast": Param(int, 12, min=2, max=200, label="Fast EMA", help="Bars in the fast average."),
        "slow": Param(int, 26, min=3, max=500, label="Slow EMA", help="Bars in the slow average."),
        "take_profit": Param(float, 1.5, min=0.1, max=20, label="Take-profit %"),
        "stop_loss": Param(float, 1.0, min=0.1, max=20, label="Stop-loss %"),
    }

    def on_bar(self, ctx, bar):
        closes = [b.close for b in ctx.bars]
        fast, slow = ctx.params["fast"], ctx.params["slow"]
        if len(closes) < slow + 1:
            return
        fast_now, slow_now = ema(closes, fast), ema(closes, slow)
        fast_before, slow_before = ema(closes[:-1], fast), ema(closes[:-1], slow)
        if crossover(fast_now, fast_before, slow_now, slow_before):
            ctx.entry("L", "long")
        elif crossunder(fast_now, fast_before, slow_now, slow_before):
            ctx.entry("S", "short")
        for entry_id, exit_id in (("L", "XL"), ("S", "XS")):
            ctx.exit(exit_id, entry_id, profit_percent=ctx.params["take_profit"],
                     loss_percent=ctx.params["stop_loss"])
```

Then open the **Paper** tab, set **Strategy type** to **Python strategy**, choose
**EMA cross · pack my_strategies**, fill in its fields, choose markets and press **Start Paper**. If a
file has an error, the Paper tab shows it (file and error) instead of the strategy.

### How a strategy fits the engine

- **A class** that inherits `Strategy` from `psr_sdk`. Optional class settings: `name`, `description`,
  `timeframe`, `warmup_bars`, `pyramiding` (open trades per direction, default 1), `uses_trades`
  (see `on_trade`), `max_positions_per_venue` (at most this many markets of one exchange hold a
  position at once).
- **One object per market.** Every market of a run gets its own copy of the class, so `self` holds
  that market's state.
- **Callbacks** (all optional):

  | Callback | When |
  |---|---|
  | `on_start(ctx)` | once, after the warm-up, before live data |
  | `on_bar(ctx, bar)` | every closed candle (`bar.open`, `high`, `low`, `close`, `volume`, `open_time`, `close_time`); during the warm-up `ctx.is_history` is true and orders are ignored |
  | `on_quote(ctx, quote)` | every change of the best bid/ask (`quote.bid`, `quote.ask`, `quote.time_ms`) |
  | `on_trade(ctx, trade)` | every public trade of the market (`trade.price`, `trade.size`, `trade.time_ms`), only with `uses_trades = True` |
  | `on_fill(ctx, fill)` | each execution of the strategy's own orders |
  | `on_order_rejected(ctx, order_id, reason)` | an entry that did not execute (for example `no_liquidity`, `position_limit`) |

- **Orders** work like Pine's `strategy.*` functions and execute exactly as described in
  [How orders execute in Paper](#how-orders-execute-in-paper):

  | Call | Pine | Meaning |
  |---|---|---|
  | `ctx.entry(id, "long"/"short", limit=, stop=, size=1.0)` | `strategy.entry` | open or reverse; market without `limit`/`stop`; `size` scales the form's order size |
  | `ctx.exit(id, from_entry, profit_percent=, loss_percent=, profit_ticks=, loss_ticks=, trail_...)` | `strategy.exit` | take-profit, stop-loss or trailing stop for the trades of an entry, priced from the real fill |
  | `ctx.close(entry_id=None)`, `ctx.close_all()` | `strategy.close` | close at market |
  | `ctx.cancel(id)`, `ctx.cancel_all()` | `strategy.cancel` | remove working orders |

- **What it can read:** `ctx.bars` (closed candles, oldest first), `ctx.position`,
  `ctx.position_avg_price`, `ctx.trades`, `ctx.orders`, `ctx.params`, `ctx.market`, `ctx.venue`,
  `ctx.mintick`, `ctx.instrument` (exact price and size steps), `ctx.now_ms`; `ctx.log(text)` writes to
  the run's events.
- **Available code:** the Python standard library and `psr_sdk.ta` (`sma`, `ema`, `rsi`, `atr`,
  `highest`, `lowest`, `crossover`, `crossunder`). Other packages (numpy, pandas…) are not installed.
- **Keep callbacks quick.** They run inside the engine one after another: no waiting, no network
  calls, no heavy work on every price change. An exception stops the run and names the strategy and
  the callback.

**Moving a Pine strategy to Python:** `input.int(…)` becomes a `Param`, the body of the script becomes
`on_bar`, `close` is `bar.close`, `ta.ema(close, n)` is `ema(closes, n)`, `syminfo.mintick` is
`ctx.mintick`, and `strategy.entry/exit/close/cancel` become the `ctx` calls above.

The complete reference is [`docs/STRATEGY_SDK.md`](docs/STRATEGY_SDK.md).

### Safety

- A Python strategy is a program that runs **inside the app**, with the same access as the app — it
  could read the account keys you saved. Put into `my_strategies` only code you wrote or have read
  yourself; never run a stranger's strategy on an installation with keys.
- In LIVE the same strategy trades your real money: run it in Paper first.

## Runs: watching a run

The **Runs** page (top menu) lists every run, Paper and LIVE, running and finished, with each exchange's **Total PnL** right after the status. Open one to see:

- **Status** and the run's rules (timeframe, markets, balances, order size, fees, LIVE limits).
- **Open positions** per exchange: size, average entry, mark price, unrealized PnL, leverage; the
  exchange balance, realized PnL and total PnL from the start.
- **Events**: start, data problems and recovery, LIVE safety actions, stop.
- **Trades**: every fill (entries and exits separately), 20 per page, with fees and realized PnL.
- **Stop experiment** (Paper) or **Stop and close all** (LIVE) ends the run.

### What happens when the computer or Docker restarts

When the app is stopped by a shutdown (Docker stop, computer restart), the runs that were working are
marked as stopped by the system and **start again by themselves** when the app comes back, if that
happens within 6 hours. A LIVE run then checks the account again before it trades. Runs stopped by
you never restart on their own.

## Accounts: connecting exchanges for LIVE

LIVE trades **accounts** you add on the **Accounts** page (top menu). Paper does not need any.

Each account card shows the exchange, the exchange account (Lighter account index and API key index,
or the Hyperliquid address), whether LIVE is on for it, whether a key is saved, and whether a LIVE run
is trading it right now (with a link to that run). Buttons:

- **Check connection** — connects with the saved key and reads the balance, open positions and open
  orders. Nothing is traded. Takes up to a minute.
- **Change** — rename, switch LIVE on or off, replace the key or the exchange account ids.
- **Remove** — forgets the account and deletes its key file.

Rules:

- One exchange account can be added **once** (the same Lighter account index or Hyperliquid address
  twice is refused): two entries would let two runs trade one account.
- An account trades in **one LIVE run at a time**. Different accounts — for example your Lighter
  account and your Hyperliquid account, or two Lighter sub-accounts — can run LIVE side by side.
- An account that is trading in a run cannot be removed or have its key changed until that run stops
  (renaming is fine).

### Adding a Lighter account

1. On Lighter, create an **API key** for the account you want to trade (main account or a
   sub-account). API key indexes **4–254** are yours; 0–3 belong to Lighter's own apps.
2. Note three things: the **account index**, the **API key index** and the **API private key**.
3. **Accounts → Add account → Lighter**: a name of your choice, the three values, **LIVE on this
   account** ticked, **Save**. Then **Check connection**.

A Lighter API key can trade and can withdraw only back to your own wallet; it cannot send funds to
another address. Use a separate account (or sub-account) with a small balance.

### Adding a Hyperliquid account

1. On Hyperliquid, open **More → API** and create an **API wallet** (an "agent" that can trade for your
   account but cannot withdraw or transfer). Copy its **private key** — Hyperliquid shows it once — and
   authorize the API wallet.
2. **Accounts → Add account → Hyperliquid**: a name, your **main account address** (`0x…`, the account
   that holds the money — not the API wallet's address), the **API wallet private key**, **LIVE on this
   account** ticked, **Save**. Then **Check connection**.

Hyperliquid "unified" accounts (USDC in the spot balance backing every market) are supported; the
check shows the USDC available to all markets. Orders are sent without a builder fee.

## LIVE trading (real money)

LIVE runs your strategy with **real orders on your own account**. It is off until you add an account.

### Starting a LIVE run

1. **Paper tab → LIVE — real money.**
2. Choose the markets. For each exchange of your markets, pick the **account** it trades (only accounts
   with LIVE on and not busy in another run can be chosen; **Manage accounts** opens the Accounts page).
3. Set the limits (below).
4. Tick *I understand: this run places real orders with real money* and press **Start LIVE**.

### The limits

| Limit | What it does |
|---|---|
| **Daily loss limit (%)** | When the account's equity (balance plus open profit and loss) falls this far below the equity captured at the day's first start (a new day starts at 06:00 UTC), the run closes every position on that exchange and stops trading there. The day's starting value is kept on disk, so a new run the same day continues from it. 1–99 %; empty = off. |
| **Account leverage** | All open positions of the account together stay within this multiple of its equity. 1 = no borrowing. At most 50×; the exchange's own margin rules still apply. |
| **Max position (USDC)** | The largest position on one market at the entry price. A larger entry is reduced to fit; when what is left is below the exchange's minimum order, the entry is not sent. Empty = off. |
| **Minimum order size** | Every entry opens the market's smallest accepted order plus 15 % (about 11.5 USDC on most markets), whatever the order size; the 15 % keep stops and closes above the minimum. |
| **Exchange stop** | A reduce-only stop resting **on the exchange** for each open position, this far beyond its reference (the strategy's stop, or the entry price). It protects the position if your computer or the app stops. If it executes while the run works, that exchange stops trading. Up to 50 %. |
| **Exchange stop from** | *Strategy stop (entry price if none)* or *Entry price*. |
| **Max slippage (%)** | How much worse than the current price (or a stop's trigger) a market order may fill. Default 3 %, from 0.05 % to 50 %. |

### While a LIVE run trades

- Orders go to the exchange at once (no modeled delay); the exchange matches them against its own book.
- Take-profits, stops and trailing stops are held by the engine and sent the moment the price reaches
  them; each open position also has its exchange-side stop.
- Every **10 seconds** the run compares its positions with the exchange account; two differences in a
  row stop that exchange.
- A market without data for **60 seconds** with an open position closes that position.
- Refused orders are read: a missed immediate-or-cancel entry is not an error; five refusals in a row,
  a key problem or an order without a final answer stop that exchange.
- **A problem on one exchange stops only that exchange**: its positions are closed at market and the
  other exchange keeps trading. When the last exchange stops, the run ends.
- **Stop and close all** on the run page closes every position of the run at market and ends it; the
  run page then says whether every position is closed.

### Before you trade real money

- LIVE trading is **at your own risk**. Backtest and Paper results do not predict real results.
- Start with a separate account and a small balance, a daily loss limit and a max position.
- Keep the computer and Docker running while a LIVE run works. If they stop, open positions stay on the
  exchange, protected only by their exchange-side stops.
- The account must have no open positions or orders when a run starts on it (the run refuses
  otherwise), and nothing else should trade that account while the run works.

## Your keys and your safety

- An API key is sent once from your browser to the app on your computer and written to a file only the
  app can read, inside the Docker volume `psr-data`. It is **never shown again** and **never sent to us
  or anyone else**: the app signs your orders on your computer and sends only signed orders to the
  exchange.
- Keys never go into a run's settings, logs, the browser's storage or Git.
- **Remove** on the Accounts page deletes the account's key file; `docker compose down -v` deletes it
  with all other data.
- **The app has no login.** Anyone who can open the page can start LIVE runs with your saved keys. Keep
  it on `127.0.0.1` (as `compose.yaml` does) or behind real authentication — see
  [running it on a server](#running-it-on-a-server).
- Strategy code (Pine and Python) runs inside the same app that can read the keys. With a key saved,
  run only strategy code you trust; a Python strategy is a full program (see
  [Python strategies](#python-strategies)).

## Limits at a glance

| What | Limit |
|---|---|
| Runs working at once (Paper and LIVE) | 6 |
| Markets per exchange in one run | 15 (30 per run) |
| LIVE runs per account at once | 1 |
| Paper / LIVE timeframes | 1m, 5m, 15m, 30m, 1h, 4h, 1d |
| Python strategies | Paper and LIVE (not Backtest) |
| Backtest timeframes | 1m, 5m, 15m, 30m, 1h, 4h, 1d |
| Backtests at once | 1 |
| Backtest length | 120 days of minute candles by default (up to 189 days on a server setting) |
| Account leverage limit | up to 50× |
| Exchange-side stop distance | up to 50 % |
| Max slippage | 0.05 %–50 %, default 3 % |
| Restart recovery | runs stopped by a shutdown restart within 6 hours |

## What to expect

- **Pine engine.** PineTS covers most of Pine v5/v6 (`switch`, tuples, methods, user types, nearly all
  `ta.*`), but not every feature. Calculation is on bar close; `calc_on_every_tick` and
  `calc_on_order_fills` are not supported; `request.security` works for the chart's own symbol on
  other timeframes. The full list: [TradingView compatibility](docs/tradingview-compatibility.md).
  Reference strategies match TradingView exports trade for trade with *4 points per bar*; that shows
  the engine is close on those cases, not identical for every script.
- **Backtest data is Binance.** Its prices and history differ from Lighter's and Hyperliquid's. Binance
  blocks some countries (for example the United States); there the Backtest tab cannot load candles.
  Paper and LIVE use Lighter and Hyperliquid and are not affected.
- **Paper is a simulation.** Prices, depth and timing are real; your orders are not. Real fills can
  differ (queue position, latency, other traders reacting). Funding is not included.
- **LIVE is real.** Fills, fees and slippage are the exchange's; the run page shows them as they
  happen.

## Update, stop, back up, remove

Run these in the folder with `compose.yaml`:

| | |
|---|---|
| Update to the latest version | `docker compose pull && docker compose up -d` |
| Stop (running Paper and LIVE runs stop too — stop LIVE runs on their page first) | `docker compose down` |
| Start again | `docker compose up -d` |
| See the app's log | `docker compose logs --tail 200 psr` |
| Remove the app **and all its data** (strategies, runs, keys) | `docker compose down -v` |

Strategies, settings, run history and account keys live in the Docker volume `psr-data` and survive
updates. Python strategies stay in your `my_strategies` folder; the app never changes it. An update restarts the app: runs that were working restart by themselves within 6 hours, but
it is cleaner to stop LIVE runs first.

Installed before the app was renamed to Svit Runner (its image was `ghcr.io/solovit12/pine-strategy-runner`)?
In your `compose.yaml` change the `image:` line to `ghcr.io/solovit12/svit-runner:latest`, then update as
above. The project name in the file stays `pine-strategy-runner`, so your data stays where it is.

**Back up** the volume (it contains your keys — keep the backup private):

```bash
docker run --rm -v pine-strategy-runner_psr-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/psr-data-backup.tgz -C /data .
```

## Running it on a server

The app has no login, so `compose.yaml` publishes it on `127.0.0.1` only. On a rented server:

- **SSH tunnel** from your computer, then open <http://127.0.0.1:18788> locally:

  ```bash
  ssh -N -L 18788:127.0.0.1:18788 you@your-server
  ```

- Or a **login-protected tunnel** (for example Cloudflare Tunnel behind Cloudflare Access with your own
  login), pointing at `127.0.0.1:18788` on the server.

Never publish the port to the internet without authentication in front of it. Use SSH keys only
(`PasswordAuthentication no`, `PermitRootLogin no`) and a firewall that allows only SSH in.

## Troubleshooting and FAQ

**The page does not open.** Check that Docker is running and `docker compose ps` shows the container
as healthy; the first start can take a minute. Then `docker compose logs --tail 200 psr`.

**The Backtest tab cannot load candles.** Binance may block your country or network; Paper and LIVE
still work.

**A Paper run stops with "Pine strategy failed".** The strategy uses a feature PineTS does not support
on live data; the message names it. Check [TradingView compatibility](docs/tradingview-compatibility.md).

**A market shows "waiting for data".** Its exchange stopped sending that market's book; it resumes by
itself. Other markets keep trading.

**LIVE refuses to start: "The account already has open positions or orders".** Close them on the
exchange, then start again — a run starts only on a clean account.

**LIVE refuses: "The account … is trading in another LIVE run".** Pick another account or stop that run.

**Check connection fails.** Lighter: check the account index, the API key index (4–254) and the key.
Hyperliquid: the address must be the **main** account, and the API wallet must be authorized on
Hyperliquid (More → API).

**Results differ from TradingView.** Use *4 points per bar*, the same Binance market
(`BINANCE:BTCUSDT.P`), the same dates and commission, *Execution cost per fill* 0; then see the compatibility page for features
that differ.

**Is my key safe?** It never leaves your computer except as signatures on orders; see
[your keys](#your-keys-and-your-safety). Use API keys that cannot withdraw elsewhere and a small balance.

## Build it yourself and develop

Build the Docker image from source:

```bash
git clone https://github.com/solovit12/svit-runner.git
cd svit-runner
NAUTILUS_WHEEL=prebuilt docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

`NAUTILUS_WHEEL=prebuilt` reuses the published Nautilus Trader build
(`ghcr.io/solovit12/pine-strategy-runner-nautilus`); `NAUTILUS_WHEEL=source` compiles it from the
pinned source and patch in `apps/nautilus-paper/patches/hyperliquid-fast5` (20–60 minutes, several GB
of memory).

Development without Docker (Node.js 22.17 or newer; 24 recommended):

```bash
npm ci
npm run check        # type checks, tests, build
npm run dev          # UI on http://127.0.0.1:5173, API on :8787
npm start            # the built app on http://127.0.0.1:8787
```

Paper and LIVE also need Python 3.13 with the pinned Nautilus Trader build (see the patch folder
above; the Docker image contains it). Useful settings:

| Variable | Meaning |
|---|---|
| `HOST`, `PORT` | Where the app listens (Docker: `0.0.0.0:8787` inside the container). |
| `PAPER_ENABLED=1` | Enables Paper and LIVE. |
| `STRATEGY_CATALOG_DIR`, `PAPER_EXPERIMENTS_DIR`, `PAPER_RUNS_DIR` | Where the library, the run history and the run journals live. |
| `PSR_NAUTILUS_PYTHON` | The Python with Nautilus Trader. |
| `PSR_STRATEGY_PACKS` | Folders with Python strategies, separated by `:` (Docker: `/strategies/my_strategies`). |
| `PSR_LIVE_SECRETS_DIR` | Where account keys are stored (default: next to the run history). |
| `PSR_LIVE_DISABLED=1` | Switches LIVE off for this installation. |
| `PSR_RESUME_AFTER_RESTART=0` | Do not restart runs after a shutdown. |
| `PSR_RUN_MEMORY_LIMIT_MB` | Memory guard: a run whose engine grows over this many MB (default 2048) stops the ordinary way; LIVE closes its positions first. |
| `PSR_MIN_FREE_MEMORY_MB` | Memory guard: when free memory drops under this many MB (default 1024), the largest run stops the same way. |
| `BACKTEST_MAX_EXECUTION_MINUTES` | Backtest budget in minute candles (default 172 800 = 120 days). |

Continuous integration (`.github/workflows`) builds the Nautilus wheel image and the app image
published as `ghcr.io/solovit12/svit-runner`.

## How the code is organised

| Path | What it is |
|---|---|
| `apps/web` | React UI: editor, Backtest and Paper tabs, Runs, Accounts. |
| `apps/api` | Fastify server: pages, library, backtests, Paper/LIVE control, accounts. |
| `apps/api/src/paper-execution` | Run control, the Nautilus process owner, the durable run journal. |
| `apps/nautilus-paper` | Python execution engine on Nautilus Trader (Paper and LIVE), its tests and the pinned build recipe. |
| `packages/pine-runtime` | Pine normalization, TradingView defaults, minute-replay order execution, the live Pine engine. |
| `packages/market-data` | Binance Futures history and minute replay. |
| `packages/shared` | Contracts shared by the server and the UI, exact decimal arithmetic. |
| `vendor/pinets` | Pinned PineTS with local changes (do not replace it from npm). |
| `tests`, `tests/fixtures/qualification` | The test suite; reference strategies and TradingView exports. |

## License and disclaimer

[AGPL-3.0](LICENSE), like the PineTS engine it builds on. Backtest and Paper results are simulations,
not financial advice. LIVE trading uses real money at your own risk.
