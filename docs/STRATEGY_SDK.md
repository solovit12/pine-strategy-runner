# Python strategy SDK

Besides Pine scripts, Paper runs strategies written in Python. They use the same
virtual accounts, markets and real-time order execution as Pine strategies, but
run **inside** the execution engine: every price update and every fill reaches
the strategy immediately, with no extra process or network hop.

## A strategy

```python
from psr_sdk import Param, Strategy
from psr_sdk.ta import crossover, crossunder, ema


class EmaCross(Strategy):
    name = "EMA cross"
    description = "Long on a fast/slow EMA cross up, short on a cross down."
    timeframe = "15m"          # default bar size (the Paper form can change it)
    warmup_bars = 300          # closed bars replayed before the start (no trading)
    pyramiding = 1             # max open trades per direction
    params = {
        "fast": Param(int, 12, min=2, max=200, label="Fast EMA"),
        "slow": Param(int, 26, min=3, max=500, label="Slow EMA"),
    }

    def on_bar(self, ctx, bar):
        closes = [b.close for b in ctx.bars]
        fast, slow = ema(closes, ctx.params["fast"]), ema(closes, ctx.params["slow"])
        fast_1, slow_1 = ema(closes[:-1], ctx.params["fast"]), ema(closes[:-1], ctx.params["slow"])
        if crossover(fast, fast_1, slow, slow_1):
            ctx.entry("L", "long")
        elif crossunder(fast, fast_1, slow, slow_1):
            ctx.entry("S", "short")
        ctx.exit("XL", "L", profit_ticks=300, loss_ticks=150)
        ctx.exit("XS", "S", profit_ticks=300, loss_ticks=150)
```

Callbacks (all optional): `on_start(ctx)`, `on_bar(ctx, bar)`, `on_quote(ctx, quote)`
(every fresh best bid/ask), `on_trade(ctx, trade)`, `on_fill(ctx, fill)`,
`on_order_rejected(ctx, order_id, reason)`. `on_trade` receives the market's public trades
(`trade.price`, `trade.size` in the base currency, `trade.time_ms`) only when the strategy sets
`uses_trades = True` — for example to measure volume; orders placed there go out with the next quote.
During warm-up `ctx.is_history` is true and orders are ignored: runs start flat.

## Orders (Pine semantics)

| Call | Meaning |
| --- | --- |
| `ctx.entry(id, "long"/"short", limit=, stop=, size=1.0, oca=, ioc=False)` | Open or reverse. Market without limit/stop; `size` scales the Paper order size. `ioc=True` (with `limit`): immediate-or-cancel, see below. |
| `ctx.exit(id, from_entry, limit=, stop=, profit_ticks=, loss_ticks=, profit_percent=, loss_percent=, profit_type="limit", trail_points_ticks=, trail_price=, trail_offset_ticks=, qty_percent=)` | Take-profit / stop-loss / trailing for each trade of the entry, priced from its real average entry and attached the moment it fills. `profit_type="market"`: the take-profit is a trigger like the stop (market order 300 ms after the price reaches it). |
| `ctx.close(entry_id=None, qty_percent=100)`, `ctx.close_all()` | Close at market. |
| `ctx.cancel(id)`, `ctx.cancel_all()` | Remove working orders. |

Read-only: `ctx.position`, `ctx.position_avg_price`, `ctx.trades`, `ctx.orders`, `ctx.bars`,
`ctx.params`, `ctx.mintick`, `ctx.instrument` (exact `price_increment`, `size_increment`,
`min_quantity`, `min_notional` as Decimal; available from the first live price), `ctx.market`,
`ctx.venue`, `ctx.now_ms`; `ctx.state` is a dict for your own data; `ctx.log(text)` writes to
the run journal. Prices may be given as `Decimal` or strings to keep them exact.

Class attributes: `timeframe`, `warmup_bars`, `pyramiding`, `uses_trades`, and `max_positions_per_venue`
(at most this many markets of one exchange hold a position at once; an entry beyond it is
rejected with `position_limit`).

### Immediate-or-cancel entries

A strategy that reacts to the live price itself (rather than resting an order) uses
`ctx.entry(id, side, limit=price, ioc=True)` — typically from `on_quote`. The order arrives
after ~200 ms and takes what the book holds at its limit; the rest is canceled (a partial
fill is a real, smaller position). If the book shown at arrival is older than the price that
prompted the order and holds nothing at the limit yet, the engine waits for a newer book (up
to 2 s, never using a book from more than 600 ms after the price). Nothing filled calls
`on_order_rejected(ctx, id, reason)`; reasons: `price_left_limit`, `no_liquidity`,
`entry_wait_expired`, `position_limit`, `shared_capital_exhausted`,
`notional_below_minimum` (the order size) or `fillable_below_minimum` (what the book offered).

Execution is the same as for Pine: market orders arrive after ~200 ms, limits
fill when the opposite best price reaches them, stops trigger on the live best
price and execute 300 ms later against a book at least as new as that price,
partial fills are real. Entry size is the Paper "order size" percent of the
venue account. Realized PnL in the journal is net of the exit fee and of the
closed part's entry fees.

## Strategy packs

A pack is a folder of `.py` modules (or packages); every `Strategy` subclass in
it appears on the Paper tab as `<pack>/<module>:<Class>`, the pack name being
the folder name (letters, digits and `_`, not starting with a digit). No pack
ships with the service.

With Docker, `compose.yaml` mounts the folder `my_strategies` next to it
(read-only) as the pack `my_strategies`; the list on the Paper tab refreshes
within 15 seconds. Elsewhere, packs live anywhere outside this repository — for
example a private Git repository — and are enabled with an environment variable:

```bash
PSR_STRATEGY_PACKS=/path/to/my_strategies npm start      # several: separated by ':'
```

Only the Python standard library and `psr_sdk` (with `psr_sdk.ta`: `sma`, `ema`,
`rsi`, `atr`, `highest`, `lowest`, `crossover`, `crossunder`) are available. Every
market of a run has its own strategy object; callbacks run inside the engine one
at a time, so keep them quick (no waiting, no network calls).

Each run pins the SHA-256 of the pack's Python files in its manifest. A strategy
that raises an exception stops the run with the strategy and callback named.

Test a strategy without the exchange: see `apps/nautilus-paper/test_sdk_runner.py`
(pure Python) and `test_sdk_runtime.py` (real Nautilus Sandbox, synthetic prices).
