"""Connects a Python Strategy to the shared real-time order engine.

The runner keeps the strategy's ledger (open trades in real quantities) and
its working orders, and hands them to PineOrderManager in exactly the form the
Pine driver uses. Execution therefore follows the same code path for Pine and
Python strategies; only the source of decisions differs. Everything runs
synchronously inside the Nautilus strategy callback: no IPC, no extra delay.
"""

from collections import deque
from decimal import Decimal

from pine_orders import PineOrderManager

from .api import Bar, Fill, OpenTrade, Quote, Trade, resolve_params

MAX_BARS = 5_000
ENTRY_TYPES = ("market", "limit", "stop", "stop-limit")


class StrategyError(Exception):
    """A strategy callback failed; the run stops with this message."""


class Context:
    """The `ctx` object given to strategy callbacks."""

    def __init__(self, runner):
        self._runner = runner
        self.state = {}

    # ----- read-only facts -------------------------------------------------

    @property
    def params(self):
        return self._runner.params

    @property
    def venue(self):
        return self._runner.venue

    @property
    def market(self):
        return self._runner.market

    @property
    def mintick(self):
        return float(self._runner.manager.tick)

    @property
    def instrument(self):
        """Exact price/size steps of the market (None until the first live price)."""
        return self._runner.instrument

    @property
    def now_ms(self):
        return self._runner.now_ms

    @property
    def is_history(self):
        return self._runner.history

    @property
    def bars(self):
        """Closed bars, oldest first (history and live)."""
        return self._runner.bars

    @property
    def trades(self):
        return [OpenTrade(key, row["entryId"], row["side"], float(row["qty"]), float(row["entryPrice"]),
                          row["entryTime"]) for key, row in self._runner.ledger.items()]

    @property
    def position(self):
        """Signed real position of this market (positive long)."""
        return float(sum((row["qty"] if row["side"] == "long" else -row["qty"]
                          for row in self._runner.ledger.values()), Decimal(0)))

    @property
    def position_avg_price(self):
        rows = list(self._runner.ledger.values())
        qty = sum((row["qty"] for row in rows), Decimal(0))
        return float(sum((row["qty"] * row["entryPrice"] for row in rows), Decimal(0)) / qty) if qty else math_nan()

    @property
    def orders(self):
        return {order["id"]: dict(order) for order in self._runner.orders.values()}

    def log(self, message):
        self._runner.log(str(message)[:500])

    # ----- orders (Pine semantics) ----------------------------------------

    def entry(self, order_id, side, *, limit=None, stop=None, size=1.0, oca=None, oca_type="cancel", ioc=False):
        """Open (or reverse into) a position, like strategy.entry.

        Market when neither limit nor stop is given. `size` scales the Paper
        order size (1.0 = the configured percent of the account).

        `ioc=True` (limit only) sends an immediate-or-cancel limit: it arrives
        after the order latency, takes what the book holds at the limit, and the
        rest is canceled; with nothing filled `on_order_rejected` is called.
        """
        if side not in ("long", "short"):
            raise ValueError("side must be 'long' or 'short'")
        if not (0 < float(size) <= 100):
            raise ValueError("size must be a positive multiplier")
        if ioc and (limit is None or stop is not None):
            raise ValueError("ioc entries need a limit and no stop")
        kind = "stop-limit" if limit is not None and stop is not None else "limit" if limit is not None \
            else "stop" if stop is not None else "market"
        self._runner.place({"id": self._id(order_id), "category": "entry", "type": kind, "side": side,
                            "limit": _num(limit), "stop": _num(stop), "sizeScale": float(size),
                            "tif": "ioc" if ioc else None,
                            **({"oca": {"name": str(oca), "type": oca_type}} if oca else {})})

    def exit(self, order_id, from_entry=None, *, limit=None, stop=None, profit_ticks=None, loss_ticks=None,
             profit_percent=None, loss_percent=None, profit_type="limit",
             trail_price=None, trail_points_ticks=None, trail_offset_ticks=None, qty_percent=None):
        """Attach take-profit / stop-loss / trailing exits, like strategy.exit.

        Applies to every open trade of `from_entry` (all trades when None) and to
        trades that entry opens later; levels in ticks or percent count from
        each trade's real entry price, attached at the moment it fills.
        `profit_type="market"` makes the take-profit a trigger (like the stop):
        reaching it sends a market order after the trigger delay.
        """
        if all(value is None for value in (limit, stop, profit_ticks, loss_ticks, profit_percent, loss_percent,
                                           trail_price, trail_points_ticks)):
            raise ValueError("exit needs at least one of limit, stop, profit_*, loss_*, trail_*")
        if (trail_price is not None or trail_points_ticks is not None) and trail_offset_ticks is None:
            raise ValueError("a trailing stop needs trail_offset_ticks")
        if profit_type not in ("limit", "market"):
            raise ValueError("profit_type must be 'limit' or 'market'")
        for label, value in (("profit_percent", profit_percent), ("loss_percent", loss_percent)):
            if value is not None and not 0 < float(value) < 100:
                raise ValueError(f"{label} must be between 0 and 100")
        self._runner.place({"id": self._id(order_id), "category": "exit", "type": "market",
                            "fromEntry": None if from_entry is None else str(from_entry),
                            "limit": _num(limit), "stop": _num(stop), "profitTicks": _num(profit_ticks),
                            "lossTicks": _num(loss_ticks), "profitPercent": _num(profit_percent),
                            "lossPercent": _num(loss_percent),
                            "profitType": None if profit_type == "limit" else profit_type,
                            "trailPrice": _num(trail_price),
                            "trailPointsTicks": _num(trail_points_ticks), "trailOffsetTicks": _num(trail_offset_ticks),
                            "qtyPercent": _num(qty_percent), "conditional": True})

    def close(self, entry_id=None, *, qty_percent=100):
        """Close trades of `entry_id` (all trades when None) at market."""
        if not 0 < float(qty_percent) <= 100:
            raise ValueError("qty_percent must be 0..100")
        name = f"close:{entry_id if entry_id is not None else '*'}"
        self._runner.place({"id": name, "category": "exit", "type": "market",
                            "fromEntry": None if entry_id is None else str(entry_id),
                            "qtyPercent": float(qty_percent), "conditional": False})

    def close_all(self):
        self.close(None)

    def cancel(self, order_id):
        self._runner.cancel(str(order_id))

    def cancel_all(self):
        self._runner.cancel(None)

    @staticmethod
    def _id(order_id):
        value = str(order_id)
        if not value or len(value) > 100 or value.startswith("close:"):
            raise ValueError("order id must be 1..100 characters and not start with 'close:'")
        return value


def _num(value):
    if value is None:
        return None
    if isinstance(value, (Decimal, str)):
        exact = Decimal(str(value))  # keep exact decimal prices exact
        if not exact.is_finite():
            raise ValueError("order prices and ticks must be finite")
        return str(exact)
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError("order prices and ticks must be finite")
    return number


def math_nan():
    return float("nan")


class StrategyRunner:
    def __init__(self, strategy_cls, *, params, venue, market, mintick, log=None, manager=None):
        self.strategy_cls = strategy_cls
        self.strategy = strategy_cls()
        self.params = resolve_params(strategy_cls, params)
        self.venue, self.market = venue, market
        self.log = log or (lambda message: None)
        self.manager = manager or PineOrderManager(f"{venue}:{market}", mintick, self.log)
        self.manager.python = True
        self.ctx = Context(self)
        self.bars = deque(maxlen=MAX_BARS)
        self.orders = {}  # "entry:L" / "exit:X" -> order dict (manager format)
        self.ledger = {}  # trade key -> {entryId, side, qty, entryPrice, entryTime}
        self.history = True
        self.started = False
        self.dirty = False
        self.now_ms = 0
        self.bar_close_ms = 0
        self.fills = 0
        self.rejected = 0
        self.instrument = None  # set by the runtime from the venue instrument

    # ----- strategy-facing order book --------------------------------------

    def place(self, order):
        if self.history:
            return  # flat start: decisions on history bars never trade
        key = f"{order['category']}:{order['id']}"
        order = {key_: value for key_, value in order.items() if value is not None}
        if order["category"] == "entry" and order["type"] not in ENTRY_TYPES:
            raise ValueError("unsupported entry type")
        self.orders[key] = order
        self.dirty = True

    def cancel(self, order_id):
        for key in list(self.orders):
            if order_id is None or self.orders[key]["id"] == order_id:
                del self.orders[key]
                self.dirty = True

    # ----- lifecycle --------------------------------------------------------

    def _call(self, name, *args):
        try:
            getattr(self.strategy, name)(self.ctx, *args)
        except Exception as exc:  # strategy bugs stop the run with a clear message
            raise StrategyError(f"{self.strategy_cls.__name__}.{name}: {type(exc).__name__}: {exc}") from exc

    def warm_up(self, bars):
        self.history = True
        for row in bars:
            self._push_bar(row)
            self._call("on_bar", self.bars[-1])

    def start(self, now_ms):
        self.now_ms = now_ms
        self.history = False
        self.started = True
        self._call("on_start")
        self.sync(now_ms, force=True)

    def _push_bar(self, row):
        bar = row if isinstance(row, Bar) else Bar(int(row["openTime"]), int(row["closeTime"]), float(row["open"]),
                                                    float(row["high"]), float(row["low"]), float(row["close"]),
                                                    float(row.get("volume", 0)))
        if self.bars and bar.open_time <= self.bars[-1].open_time:
            return False
        self.bars.append(bar)
        self.bar_close_ms = max(self.bar_close_ms, bar.close_time)
        return True

    def on_bar(self, row, now_ms):
        self.now_ms = now_ms
        if self._push_bar(row):
            self._call("on_bar", self.bars[-1])
        self.sync(now_ms)

    def on_quote(self, bid, ask, now_ms):
        self.now_ms = now_ms
        self.manager.on_quote(bid, ask, now_ms)
        self.drain(now_ms)
        self._call("on_quote", Quote(float(bid), float(ask), now_ms))
        self.sync(now_ms)

    def on_trade(self, price, size, now_ms):
        """A public trade of the market; orders placed here go out with the next quote."""
        if not self.started:
            return
        self.now_ms = now_ms
        self._call("on_trade", Trade(float(price), float(size), now_ms))
        self.sync(now_ms)

    def evaluate(self, now_ms):
        self.now_ms = now_ms
        self.manager.evaluate(now_ms)
        self.drain(now_ms)

    def exec_result(self, request_id, **result):
        self.manager.exec_result(request_id, **result)
        self.drain(result["now_ms"])

    # ----- fills back from the engine ----------------------------------------

    def drain(self, now_ms):
        reports = self.manager.take_reports()
        for report in reports:
            self._apply_report(report)
        if reports:
            self.sync(now_ms, force=True)

    def _apply_report(self, report):
        self.now_ms = max(self.now_ms, report["time"])
        order_key = f"{report['category']}:{report['orderId']}"
        order = self.orders.get(order_key)
        if report["category"] == "entry":
            self.orders.pop(order_key, None)
            oca = (order or {}).get("oca") or {}
            if oca.get("type") == "cancel":
                for key in [key for key, other in self.orders.items() if (other.get("oca") or {}).get("name") == oca.get("name")]:
                    del self.orders[key]
            trade_key = f"{report['orderId']}@{report['time']}"
            trade = self.manager.trades.get(trade_key)
            # Reversal: the engine already reduced the trades it closed.
            self._refresh_ledger()
            if trade is None or trade.real_qty <= 0:
                self.rejected += 1
                self.manager.trades.pop(trade_key, None)
                self._call("on_order_rejected", report["orderId"], report.get("reason") or "not_filled")
                return
            # Full-precision average fill price (the report is rounded for display).
            self.ledger[trade_key] = {"entryId": report["orderId"], "side": trade.side, "qty": trade.real_qty,
                                      "entryPrice": trade.entry_price, "entryTime": report["time"]}
            trade.pine_qty = trade.real_qty
            fill = Fill(report["orderId"], "entry", trade.side, float(report["price"]), float(trade.real_qty),
                        report["time"], trade_key, report["leg"])
        else:
            closed_side = None
            if report.get("tradeKey") in self.ledger:
                closed_side = self.ledger[report["tradeKey"]]["side"]
            elif order and order.get("fromEntry"):
                closed_side = next((row["side"] for row in self.ledger.values() if row["entryId"] == order["fromEntry"]), None)
            elif self.ledger:
                closed_side = next(iter(self.ledger.values()))["side"]
            self._refresh_ledger()
            fill = Fill(report["orderId"], "exit", closed_side or "long", float(report["price"]),
                        float(report.get("qty", 0)), report["time"], report.get("tradeKey"), report["leg"])
            if order is not None and not order.get("conditional"):
                if not any(self._matches(order, row) for row in self.ledger.values()):
                    self.orders.pop(order_key, None)
        self.fills += 1
        self._call("on_fill", fill)

    def _refresh_ledger(self):
        for key in list(self.ledger):
            trade = self.manager.trades.get(key)
            if trade is None or trade.real_qty <= 0:
                del self.ledger[key]
            else:
                self.ledger[key]["qty"] = trade.real_qty
                trade.pine_qty = trade.real_qty

    # ----- hand the order set to the engine -------------------------------------

    @staticmethod
    def _matches(order, row):
        return not order.get("fromEntry") or row["entryId"] == order["fromEntry"]

    def _plan(self, order):
        rows = list(self.ledger.items())
        if order["category"] == "entry":
            opposite = [(key, row) for key, row in rows if row["side"] != order["side"]]
            same = [row for _, row in rows if row["side"] == order["side"]]
            if not opposite and len(same) >= max(1, int(self.strategy_cls.pyramiding)):
                return {"accepted": False, "closes": [], "opensSide": None, "opensQty": 0}
            return {"accepted": True, "closes": [{"tradeKey": key, "qty": str(row["qty"])} for key, row in opposite],
                    "opensSide": order["side"], "opensQty": 1}
        matching = [(key, row) for key, row in rows if self._matches(order, row)]
        total = sum((row["qty"] for _, row in matching), Decimal(0))
        left = total * Decimal(str(order.get("qtyPercent", 100))) / 100
        closes = []
        for key, row in matching:  # FIFO
            if left <= 0:
                break
            take = min(left, row["qty"])
            closes.append({"tradeKey": key, "qty": str(take)})
            left -= take
        return {"accepted": bool(closes), "closes": closes, "opensSide": None, "opensQty": 0}

    def sync(self, now_ms, force=False):
        if not self.started or not (self.dirty or force):
            return
        self.dirty = False
        # Exits without trades and without an awaited entry end, as in Pine.
        pending_entries = {order["id"] for order in self.orders.values() if order["category"] == "entry"}
        for key, order in list(self.orders.items()):
            if order["category"] != "exit" or not order.get("conditional"):
                continue
            if not any(self._matches(order, row) for row in self.ledger.values()) and not (
                    pending_entries if not order.get("fromEntry") else order["fromEntry"] in pending_entries):
                del self.orders[key]
        orders = []
        for order in list(self.orders.values()):
            row = {name: value for name, value in order.items() if name != "conditional"}
            matching = [key for key, trade in self.ledger.items() if self._matches(order, trade)]
            if order["category"] == "exit":
                row["tradeKeys"] = matching
                row["side"] = self.ledger[matching[0]]["side"] if matching else None
                if not order.get("conditional"):
                    row["plan"] = self._plan(order)
                    if not row["plan"]["accepted"]:
                        del self.orders[f"exit:{order['id']}"]  # nothing to close
                        continue
            else:
                row["tradeKeys"] = []
                row["plan"] = self._plan(order)
                if not row["plan"]["accepted"]:
                    # Like Pine: an entry beyond the pyramiding limit is ignored.
                    del self.orders[f"entry:{order['id']}"]
                    self.log(f"entry {order['id']} ignored: pyramiding limit {self.strategy_cls.pyramiding} reached")
                    continue
            row["qtyCap"] = None
            orders.append(row)
        trades = [{"key": key, "entryId": row["entryId"], "side": row["side"], "qty": str(row["qty"]),
                   "entryPrice": str(row["entryPrice"]), "bracketEntryPrice": str(row["entryPrice"]),
                   "entryTime": row["entryTime"]} for key, row in self.ledger.items()]
        self.manager.apply_set({"barCloseMs": self.bar_close_ms, "fillsThrough": self.manager.report_seq,
                                "orders": orders, "trades": trades}, now_ms)
        # apply_set may execute at once (e.g. resting limit already touched).
        if self.manager.reports:
            self.drain(now_ms)
