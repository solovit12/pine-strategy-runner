"""Real-time execution of Pine strategy orders for one Paper track.

Pine (Node) re-runs on every closed bar and sends its pending orders and open
trades. This module keeps them working against the live best bid/ask, decides
WHEN an order executes and WHAT real quantity it moves, and reports executed
fills back in Pine terms. It never submits orders itself: the Nautilus
strategy turns ExecRequests into Sandbox IOC orders and reports the result.

Real-time rules (no backtest bar semantics):
- every order set becomes live ARRIVAL_MS after it is received (Paper's modeled latency;
  Live passes zero delays: the real network and exchange are the latency);
- market orders execute at arrival; resting limits (entries and take-profits)
  execute immediately when the opposite best price touches the limit;
- stop / stop-limit / stop-loss / trailing legs trigger when the relevant
  best price crosses the level, then execute after TRIGGER_DELAY_MS;
- entries are sized by the Paper order-size percent of the venue account,
  exits move the real quantity that mirrors the Pine quantity they close;
- Pine trades opened before the Paper start (or not executable with real
  size) are "shadow" trades: their exits are reported at the live price
  without a Sandbox order so Pine keeps progressing.
"""

from dataclasses import dataclass, field
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR

ARRIVAL_MS = 200
TRIGGER_DELAY_MS = 300
ENTRY_RETRY_WINDOW_MS = 2_000
ZERO = Decimal("0")

ORDER_TYPES = ("market", "limit", "stop", "stop-limit")


def dec(value, label):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"{label} must be numeric")
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError(f"{label} must be finite")
    return result


@dataclass
class Trade:
    key: str
    entry_id: str
    side: str  # long | short
    pine_qty: Decimal
    real_qty: Decimal
    entry_price: Decimal
    bracket_price: Decimal
    entry_time: int
    opened_fill_seq: int = 0  # report seq of the fill that opened it (0: Pine-only)

    @property
    def shadow(self):
        return self.real_qty <= 0


@dataclass
class Leg:
    """One executable obligation: an entry order, a market exit, or one trade's bracket."""
    key: str
    order: dict
    trade_key: str | None = None
    live_at_ms: int = 0
    state: str = "waiting"  # waiting | triggered | executing | done
    due_ms: int | None = None
    trigger_kind: str | None = None  # market | limit | stop | profit | loss | trail
    trail_armed: bool = False
    stop_triggered: bool = False  # stop-limit entry whose stop was crossed: now a limit
    trail_best: Decimal | None = None
    attempt_started_ms: int | None = None
    filled_real: Decimal = ZERO
    filled_quote: Decimal = ZERO
    request_id: str | None = None
    plan_closes: list = field(default_factory=list)  # [(trade_key, pine_qty)]
    # Source time (ns) of the market input that placed an IOC entry or
    # triggered this leg: its order must meet a book at least that new.
    source_ns: int = 0


@dataclass
class ExecRequest:
    id: str
    leg_key: str
    kind: str  # entry | exit
    side: str  # buy | sell
    limit: Decimal | None
    close_qty: Decimal  # real quantity of existing exposure to close first
    open_side: str | None  # long | short when new exposure is opened by percent
    reduce_only: bool
    reference_price: Decimal | None = None
    # Multiplier of the configured entry size (Python strategies may scale entries).
    size_scale: Decimal = Decimal(1)
    # Immediate-or-cancel entry (Python SDK): one attempt at arrival, never rests.
    ioc: bool = False
    # Book source time the execution must not predate (0: any fresh book).
    source_ns: int = 0
    created_ms: int = 0
    waited: bool = False


class PineOrderManager:
    def __init__(self, track, mintick, log=None, *, arrival_ms=ARRIVAL_MS, trigger_delay_ms=TRIGGER_DELAY_MS,
                 entry_retry_window_ms=ENTRY_RETRY_WINDOW_MS):
        self.track = track
        # A Python strategy owns its orders itself: no Pine-side trade without a real fill.
        self.python = False
        # Paper models network and venue latency with these delays; Live sets them to zero.
        self.arrival_ms = arrival_ms
        self.trigger_delay_ms = trigger_delay_ms
        self.entry_retry_window_ms = entry_retry_window_ms
        self.tick = dec(mintick, "mintick")
        if self.tick is None or self.tick <= 0:
            raise ValueError("mintick must be positive")
        self.log = log or (lambda message: None)
        self.trades: dict[str, Trade] = {}
        self.orders: dict[str, dict] = {}
        self.legs: dict[str, Leg] = {}
        self.requests: list[ExecRequest] = []
        self.reports: list[dict] = []
        self.request_seq = 0
        self.report_seq = 0
        self.set_seq = 0
        self.bar_close_ms = None
        self.boundary_ms = 0
        self.bid = self.ask = None
        self.quote_ms = None
        self.residual_long = ZERO  # real exposure no Pine trade owns any more
        self.residual_short = ZERO
        self.signals = 0
        # Set by the runtime before each market input (source time, ns).
        self.input_source_ns = 0

    # ----- order set from Pine ------------------------------------------------

    @property
    def entries_gated(self):
        """New entries wait for Pine's decision on the latest closed bar."""
        return self.bar_close_ms is None or self.boundary_ms > self.bar_close_ms

    def boundary(self, bar_close_ms):
        """A bar closed: hold NEW entries until Pine's order set for it arrives.

        Working exits keep executing under the previous set: protection is
        never paused for a Pine re-run.
        """
        self.boundary_ms = max(self.boundary_ms, bar_close_ms)

    def apply_set(self, payload, now_ms):
        bar_close = payload.get("barCloseMs")
        if not isinstance(bar_close, int) or (self.bar_close_ms is not None and bar_close < self.bar_close_ms):
            raise ValueError("order set barCloseMs must be a non-decreasing integer")
        fills_through = payload.get("fillsThrough")
        if not isinstance(fills_through, int) or not 0 <= fills_through <= self.report_seq:
            raise ValueError("order set fillsThrough must reference reported fills")
        self.bar_close_ms = bar_close
        self.set_seq += 1
        self._sync_trades(payload.get("trades"), fills_through)
        incoming = {}
        for raw in payload.get("orders") or []:
            order = self._parse_order(raw)
            incoming[(order["category"], order["id"])] = order
        live_at = now_ms + self.arrival_ms
        # Legs whose order vanished or changed are dropped (unless executing).
        for key, leg in list(self.legs.items()):
            current = incoming.get((leg.order["category"], leg.order["id"]))
            if leg.state == "executing":
                if current is not None:
                    leg.order = {**current, "_kept": True}
                continue
            if current is None or self._material(current) != self._material(leg.order):
                del self.legs[key]
            else:
                leg.order = current
                if leg.order["category"] == "entry" or leg.trade_key is None:
                    leg.plan_closes = self._plan_closes(current)
        self.orders = {f"{order['category']}:{order['id']}": order for order in incoming.values()}
        for order in incoming.values():
            if order["category"] == "entry" or not order["conditional"]:
                key = f"{order['category']}:{order['id']}"
                if key not in self.legs and (order.get("plan") or {}).get("accepted", True):
                    self.legs[key] = Leg(key, order, live_at_ms=live_at, plan_closes=self._plan_closes(order),
                                         source_ns=self.input_source_ns)
            else:
                for trade_key in order["tradeKeys"]:
                    self._ensure_bracket(order, trade_key, live_at)
        self.evaluate(now_ms)

    def _material(self, order):
        # An exit's side follows its trades (unknown until the entry fills);
        # it must not reset working brackets, trailing state or triggers.
        return (order["category"],) + tuple((name, order.get(name)) for name in (
            *(() if order["category"] == "exit" else ("side",)),
            "type", "limit", "stop", "profitTicks", "lossTicks", "trailPrice",
            "trailPointsTicks", "trailOffsetTicks", "fromEntry", "sizeScale", "qtyPercent",
            "profitPercent", "lossPercent", "profitType", "tif"))

    def _parse_order(self, raw):
        if not isinstance(raw, dict):
            raise ValueError("order must be an object")
        order_id, category, kind = raw.get("id"), raw.get("category"), raw.get("type")
        if not isinstance(order_id, str) or not order_id or len(order_id) > 200:
            raise ValueError("order id must be a short string")
        if category not in ("entry", "exit") or kind not in ORDER_TYPES:
            raise ValueError(f"order {order_id}: unsupported category/type")
        side = raw.get("side")
        if side not in ("long", "short", None):
            raise ValueError(f"order {order_id}: invalid side")
        if category == "entry" and side is None:
            raise ValueError(f"entry {order_id} needs a side")
        order = {"id": order_id, "category": category, "type": kind, "side": side,
                 "tradeKeys": list(raw.get("tradeKeys") or []), "plan": raw.get("plan"),
                 "oca": raw.get("oca"), "fromEntry": raw.get("fromEntry"),
                 "profitType": raw.get("profitType") or "limit", "tif": raw.get("tif") or "gtc"}
        for name in ("limit", "stop", "profitTicks", "lossTicks", "trailPrice", "trailPointsTicks",
                     "trailOffsetTicks", "qtyCap", "qtyPercent", "sizeScale", "profitPercent", "lossPercent"):
            order[name] = dec(raw.get(name), f"{order_id}.{name}")
        if order["profitType"] not in ("limit", "market"):
            raise ValueError(f"order {order_id}: profitType must be limit or market")
        if order["tif"] not in ("gtc", "ioc") or (order["tif"] == "ioc" and (category, kind) != ("entry", "limit")):
            raise ValueError(f"order {order_id}: only limit entries can be immediate-or-cancel")
        for name in ("profitPercent", "lossPercent"):
            if order[name] is not None and not 0 < order[name] < 100:
                raise ValueError(f"order {order_id}: {name} must be between 0 and 100")
        if category == "entry":
            if kind in ("limit", "stop-limit") and order["limit"] is None:
                raise ValueError(f"entry {order_id}: limit price missing")
            if kind in ("stop", "stop-limit") and order["stop"] is None:
                raise ValueError(f"entry {order_id}: stop price missing")
        order["conditional"] = category == "exit" and any(order[name] is not None for name in (
            "limit", "stop", "profitTicks", "lossTicks", "trailPrice", "trailPointsTicks",
            "profitPercent", "lossPercent"))
        return order

    def _plan_closes(self, order):
        plan = order.get("plan") or {}
        return [(item["tradeKey"], dec(item["qty"], "plan qty")) for item in plan.get("closes") or []]

    def _sync_trades(self, rows, fills_through):
        if not isinstance(rows, list):
            raise ValueError("order set needs a trades list")
        seen = set()
        for row in rows:
            key = row.get("key")
            if not isinstance(key, str) or row.get("side") not in ("long", "short"):
                raise ValueError("trade needs key and side")
            seen.add(key)
            pine_qty = dec(row.get("qty"), "trade qty")
            entry = dec(row.get("entryPrice"), "trade entry")
            bracket = dec(row.get("bracketEntryPrice"), "trade bracket entry") or entry
            trade = self.trades.get(key)
            if trade is None:
                self.trades[key] = Trade(key, row.get("entryId", ""), row["side"], pine_qty, ZERO,
                                         entry, bracket, int(row.get("entryTime", 0)))
            else:
                trade.pine_qty, trade.entry_price, trade.bracket_price = pine_qty, entry, bracket
        for key, trade in list(self.trades.items()):
            if key in seen:
                continue
            if trade.opened_fill_seq > fills_through:
                continue  # Pine has not seen the fill that opened it yet
            if trade.real_qty > 0:
                # Pine no longer holds it: the real remainder must be flattened.
                self._add_residual(trade.side, trade.real_qty)
                self.log(f"Pine trade {key} closed without a matching real exit; "
                         f"{trade.real_qty} {trade.side} queued for flattening")
            del self.trades[key]
            for leg_key in [k for k, leg in self.legs.items() if leg.trade_key == key and leg.state != "executing"]:
                del self.legs[leg_key]

    def _add_residual(self, side, qty):
        if side == "long":
            self.residual_long += qty
        else:
            self.residual_short += qty

    def _ensure_bracket(self, order, trade_key, live_at):
        key = f"exit:{order['id']}:{trade_key}"
        if key in self.legs or trade_key not in self.trades:
            return
        self.legs[key] = Leg(key, order, trade_key=trade_key, live_at_ms=live_at)

    # ----- prices and triggers ------------------------------------------------

    def on_quote(self, bid, ask, now_ms):
        self.bid, self.ask, self.quote_ms = Decimal(str(bid)), Decimal(str(ask)), now_ms
        self.evaluate(now_ms)

    def next_wakeup_ms(self, now_ms):
        """Next FUTURE moment a leg changes state by time alone (arrival or trigger delay).

        Legs already due are evaluated on the next fresh market input; returning
        a past time here would make the caller re-arm an immediate timer forever.
        """
        times = [leg.due_ms for leg in self.legs.values()
                 if leg.state == "triggered" and leg.due_ms is not None and leg.due_ms > now_ms]
        times += [leg.live_at_ms for leg in self.legs.values() if leg.state == "waiting" and leg.live_at_ms > now_ms]
        return min(times) if times else None

    def evaluate(self, now_ms):
        if self.bid is None or self.ask is None:
            return
        self._flatten_residual()
        for leg in list(self.legs.values()):
            if leg.key not in self.legs or leg.state in ("executing", "done"):
                continue
            if leg.order["category"] == "entry" and self.entries_gated:
                continue
            if now_ms < leg.live_at_ms:
                continue
            if leg.state == "triggered":
                if now_ms >= leg.due_ms:
                    self._execute(leg, now_ms)
                continue
            if leg.order["category"] == "entry":
                self._evaluate_entry(leg, now_ms)
            elif leg.trade_key is None:
                self._execute(leg, now_ms, trigger="market")
            else:
                self._evaluate_bracket(leg, now_ms)

    def _evaluate_entry(self, leg, now_ms):
        order = leg.order
        buy = order["side"] == "long"
        kind = order["type"]
        if kind == "market":
            self._execute(leg, now_ms, trigger="market")
        elif order.get("tif") == "ioc":
            # Sent on the strategy's own decision: it meets whatever the book
            # holds at its limit on arrival, touched or not.
            self._execute(leg, now_ms, trigger="limit")
        elif kind == "limit":
            if (self.ask <= order["limit"]) if buy else (self.bid >= order["limit"]):
                self._execute(leg, now_ms, trigger="limit")
        elif kind == "stop-limit" and leg.stop_triggered:
            if (self.ask <= order["limit"]) if buy else (self.bid >= order["limit"]):
                self._execute(leg, now_ms, trigger="limit")
        else:  # stop, stop-limit
            if (self.ask >= order["stop"]) if buy else (self.bid <= order["stop"]):
                leg.stop_triggered = True
                self._trigger(leg, now_ms, "stop")

    def _bracket_levels(self, leg):
        order, trade = leg.order, self.trades[leg.trade_key]
        sign = Decimal(1) if trade.side == "long" else Decimal(-1)
        profit = order["limit"]
        if profit is None and order["profitTicks"] is not None:
            profit = trade.bracket_price + sign * order["profitTicks"] * self.tick
        if profit is None and order["profitPercent"] is not None:
            profit = trade.bracket_price * (1 + sign * order["profitPercent"] / 100)
        loss = order["stop"]
        if loss is None and order["lossTicks"] is not None:
            loss = trade.bracket_price - sign * order["lossTicks"] * self.tick
        if loss is None and order["lossPercent"] is not None:
            loss = trade.bracket_price * (1 - sign * order["lossPercent"] / 100)
        return profit, loss

    def _evaluate_bracket(self, leg, now_ms):
        order, trade = leg.order, self.trades.get(leg.trade_key)
        if trade is None:
            del self.legs[leg.key]
            return
        long = trade.side == "long"
        exit_price = self.bid if long else self.ask  # price a closing order meets
        profit, loss = self._bracket_levels(leg)
        if profit is not None and ((exit_price >= profit) if long else (exit_price <= profit)):
            if order.get("profitType") == "market":
                self._trigger(leg, now_ms, "profit")  # take-profit market: trigger, then market
            else:
                self._execute(leg, now_ms, trigger="profit")
            return
        if loss is not None and ((exit_price <= loss) if long else (exit_price >= loss)):
            self._trigger(leg, now_ms, "loss")
            return
        offset = order["trailOffsetTicks"]
        if offset is None or (order["trailPrice"] is None and order["trailPointsTicks"] is None):
            return
        if not leg.trail_armed:
            activation = order["trailPrice"]
            if activation is None:
                step = order["trailPointsTicks"] * self.tick
                activation = trade.bracket_price + step if long else trade.bracket_price - step
            if (exit_price >= activation) if long else (exit_price <= activation):
                leg.trail_armed, leg.trail_best = True, exit_price
                self.log(f"{order['id']} trailing stop armed at {exit_price}")
            return
        if (exit_price > leg.trail_best) if long else (exit_price < leg.trail_best):
            leg.trail_best = exit_price
        stop = leg.trail_best - offset * self.tick if long else leg.trail_best + offset * self.tick
        if (exit_price <= stop) if long else (exit_price >= stop):
            self._trigger(leg, now_ms, "trail")

    def _trigger(self, leg, now_ms, kind):
        leg.state, leg.trigger_kind, leg.due_ms = "triggered", kind, now_ms + self.trigger_delay_ms
        leg.source_ns = self.input_source_ns
        self.signals += 1
        if self.trigger_delay_ms <= 0:
            # Live: the closing order leaves on the same price update that crossed the level.
            self._execute(leg, now_ms)
            self.log(f"{leg.order['category']} {leg.order['id']} {kind} triggered; executing now")
            return
        self.log(f"{leg.order['category']} {leg.order['id']} {kind} triggered; executes in {self.trigger_delay_ms} ms")

    # ----- execution --------------------------------------------------------

    def _real_close_plan(self, leg):
        """Real quantity and per-trade Pine quantities an exit or reversal closes."""
        rows = []
        if leg.trade_key is not None:
            trade = self.trades.get(leg.trade_key)
            if trade is None:
                return rows
            cap = leg.order["qtyCap"]
            if leg.order["qtyPercent"] is not None and cap is None:
                total = sum((self.trades[k].pine_qty for k in leg.order["tradeKeys"] if k in self.trades), ZERO)
                cap = total * leg.order["qtyPercent"] / 100
            pine_q = trade.pine_qty if cap is None else min(cap, trade.pine_qty)
            rows.append((trade, pine_q))
        else:
            for trade_key, pine_q in leg.plan_closes:
                trade = self.trades.get(trade_key)
                if trade is not None:
                    rows.append((trade, min(pine_q, trade.pine_qty)))
        return [(trade, pine_q, self._real_share(trade, pine_q)) for trade, pine_q in rows if pine_q > 0]

    @staticmethod
    def _real_share(trade, pine_q):
        if trade.real_qty <= 0 or trade.pine_qty <= 0:
            return ZERO
        return trade.real_qty if pine_q >= trade.pine_qty else trade.real_qty * pine_q / trade.pine_qty

    def _execute(self, leg, now_ms, trigger=None):
        order = leg.order
        if trigger is not None:
            leg.trigger_kind = trigger
            if trigger in ("market", "limit", "profit"):
                self.signals += 1
        closes = self._real_close_plan(leg)
        if order["category"] == "exit" and not closes:
            del self.legs[leg.key]
            return
        real_close = sum((row[2] for row in closes), ZERO)
        if order["category"] == "exit":
            side_long = closes[0][0].side == "long"
            side = "sell" if side_long else "buy"
            open_side = None
        else:
            side = "buy" if order["side"] == "long" else "sell"
            plan = order.get("plan") or {}
            open_side = plan.get("opensSide", order["side"])
        limit = None
        if leg.trigger_kind == "limit" or (leg.trigger_kind == "profit" and order.get("profitType") != "market"):
            limit = order["limit"] if leg.trade_key is None or order["limit"] is not None else self._bracket_levels(leg)[0]
        elif leg.trigger_kind == "stop" and order["type"] == "stop-limit":
            limit = order["limit"]
        if real_close <= 0 and open_side is None:
            # Only shadow (Pine-only) quantity: report at the live price.
            self._report_shadow(leg, closes, now_ms)
            return
        if leg.attempt_started_ms is None:
            leg.attempt_started_ms = now_ms
        self.request_seq += 1
        reference = self.ask if side == "buy" else self.bid
        ioc = order.get("tif") == "ioc"
        request = ExecRequest(f"{self.track}:{self.request_seq}", leg.key, order["category"], side, limit,
                              real_close, open_side, reduce_only=order["category"] == "exit" and open_side is None,
                              reference_price=reference, size_scale=order.get("sizeScale") or Decimal(1),
                              ioc=ioc, source_ns=leg.source_ns if (ioc or leg.state == "triggered") else 0,
                              created_ms=now_ms)
        leg.state, leg.request_id = "executing", request.id
        leg.closes_snapshot = closes
        self.requests.append(request)

    def take_requests(self):
        requests, self.requests = self.requests, []
        return requests

    def exec_result(self, request_id, *, filled, average, opened, now_ms, reason=None):
        """Sandbox outcome of one IOC request. `opened` is the part that opened new exposure."""
        leg = next((item for item in self.legs.values() if item.request_id == request_id), None)
        if leg is None:
            raise ValueError(f"unknown execution request {request_id}")
        filled, opened = Decimal(str(filled)), Decimal(str(opened))
        if leg.key.startswith("residual:"):
            # A late fill may already have closed part of the residual (Live).
            if leg.key == "residual:long":
                self.residual_long = max(ZERO, self.residual_long - filled)
            else:
                self.residual_short = max(ZERO, self.residual_short - filled)
            del self.legs[leg.key]
            return
        closed = filled - opened
        closes = leg.closes_snapshot
        order = leg.order
        if filled > 0:
            leg.filled_real += filled
            leg.filled_quote += filled * Decimal(str(average))
        if order["category"] == "exit":
            self._finish_exit(leg, closes, closed, average, now_ms, reason)
        else:
            self._finish_entry(leg, closes, closed, opened, average, now_ms, reason)

    def _allocate_closed(self, closes, closed):
        """FIFO allocation of a real closed quantity; returns Pine quantity closed."""
        pine_total = ZERO
        left = closed
        for trade, pine_q, real_q in closes:
            if trade.real_qty <= 0:
                trade.pine_qty -= min(pine_q, trade.pine_qty)
                pine_total += pine_q  # shadow part closes with the order
                continue
            take = min(left, real_q)
            if take <= 0:
                continue
            pine_part = pine_q if take >= real_q else pine_q * take / real_q
            trade.real_qty -= take
            trade.pine_qty -= pine_part
            pine_total += pine_part
            left -= take
        return pine_total

    def _finish_exit(self, leg, closes, closed, average, now_ms, reason):
        if closed > 0:
            pine_q = self._allocate_closed(closes, closed)
            trade_key = leg.trade_key
            self._report(leg, average, now_ms, pine_q, trade_key)
        remaining = [row for row in self._real_close_plan(leg) if row[2] > 0]
        resting = leg.trigger_kind == "limit" or (leg.trigger_kind == "profit" and leg.order.get("profitType") != "market")
        if remaining and leg.key in self.legs and closed <= 0 and resting:
            leg.state, leg.request_id = "waiting", None  # touched, nothing filled: keep resting
            return
        if remaining and leg.key in self.legs:
            # Partial IOC: the rest of a triggered exit retries on a newer book.
            leg.state = "triggered"
            leg.due_ms = now_ms
            if reason:
                self.log(f"exit {leg.order['id']} waiting for liquidity: {reason}")
            return
        self.legs.pop(leg.key, None)

    def _finish_entry(self, leg, closes, closed, opened, average, now_ms, reason):
        order = leg.order
        retry = (order["type"] in ("market", "stop") and leg.filled_real <= 0
                 and leg.attempt_started_ms is not None
                 and now_ms - leg.attempt_started_ms < self.entry_retry_window_ms and reason in (None, "no_liquidity"))
        resting = order.get("tif") != "ioc" and (order["type"] == "limit" or (order["type"] == "stop-limit" and leg.stop_triggered))
        if leg.filled_real <= 0 and resting and reason in (None, "no_liquidity"):
            leg.state, leg.request_id = "waiting", None  # touch without fill: keep resting
            return
        if retry:
            leg.state, leg.due_ms = "triggered", now_ms
            return
        self._allocate_closed(closes, closed)
        if leg.filled_real > 0:
            price = leg.filled_quote / leg.filled_real
        else:
            price = self.ask if order["side"] == "long" else self.bid
            self.log(f"entry {order['id']} not filled: {reason or 'no real fill'}" if self.python
                     else f"entry {order['id']} executed in Pine only: {reason or 'no real fill'}")
        seq = self._report(leg, price, now_ms, None, None,
                           reason=None if leg.filled_real > 0 else (reason or "not_filled"))
        key = f"{order['id']}@{now_ms}"
        if (order.get("plan") or {}).get("opensSide") or opened > 0:
            provisional = dec((order.get("plan") or {}).get("opensQty"), "plan opensQty") or Decimal(1)
            # Pine's own quantity arrives with the next order set; until then
            # the planned quantity keeps proportional exits consistent.
            self.trades[key] = Trade(key, order["id"], order["side"], provisional, opened, price, price, now_ms,
                                     opened_fill_seq=seq)
            for exit_order in self.orders.values():
                if (exit_order["category"] == "exit" and exit_order["conditional"]
                        and exit_order.get("fromEntry") in (None, "", order["id"])):
                    # OTO: brackets attach at the real fill, priced from it.
                    self.legs[f"exit:{exit_order['id']}:{key}"] = Leg(
                        f"exit:{exit_order['id']}:{key}", exit_order, trade_key=key, live_at_ms=now_ms)
        self.legs.pop(leg.key, None)
        oca = order.get("oca")
        if oca and oca.get("type") == "cancel":
            for other in list(self.legs.values()):
                if other.state != "executing" and (other.order.get("oca") or {}).get("name") == oca.get("name"):
                    del self.legs[other.key]

    def _report_shadow(self, leg, closes, now_ms):
        price = self.bid if closes[0][0].side == "long" else self.ask
        if leg.trigger_kind == "profit" and leg.order.get("profitType") != "market":
            price = self._bracket_levels(leg)[0] if leg.trade_key else leg.order["limit"] or price
        pine_q = self._allocate_closed(closes, ZERO)
        self._report(leg, price, now_ms, pine_q, leg.trade_key)
        self.legs.pop(leg.key, None)

    def _report(self, leg, price, now_ms, pine_qty, trade_key, reason=None):
        self.report_seq += 1
        order = leg.order
        leg_name = {"profit": "profit", "loss": "loss", "trail": "trail", "limit": "limit",
                    "stop": "stop"}.get(leg.trigger_kind, "market")
        item = {"seq": self.report_seq, "orderId": order["id"], "category": order["category"],
                "price": format(Decimal(str(price)).quantize(Decimal("1e-12")).normalize(), "f"), "time": now_ms, "leg": leg_name}
        if pine_qty is not None and order["category"] == "exit":
            item["qty"] = format(pine_qty, "f")
        if trade_key is not None:
            item["tradeKey"] = trade_key
        if reason is not None:
            item["reason"] = reason
        self.reports.append(item)
        return self.report_seq

    def take_reports(self):
        reports, self.reports = self.reports, []
        return reports

    # ----- late fills (Live) and residual flattening ---------------------------

    def late_fill(self, side, closing, opening):
        """Real quantity filled after its order had ended (Live: Lighter's fill can follow its cancel).

        Exposure it opened belongs to no trade and is flattened at market; exposure it closed leaves
        the residual first, then the oldest trades of that side.
        """
        closing, opening = Decimal(str(closing)), Decimal(str(opening))
        if opening > 0:
            opened_side = "long" if side == "buy" else "short"
            self._add_residual(opened_side, opening)
            self.log(f"late fill: {opening} {opened_side} owned by no trade; queued for flattening")
        if closing > 0:
            held = "short" if side == "buy" else "long"
            left = closing
            take = min(left, self.residual_long if held == "long" else self.residual_short)
            if held == "long":
                self.residual_long -= take
            else:
                self.residual_short -= take
            left -= take
            for trade in self.trades.values():
                if left <= 0:
                    break
                if trade.side == held and trade.real_qty > 0:
                    take = min(left, trade.real_qty)
                    trade.real_qty -= take
                    left -= take
            self.log(f"late fill: {closing - left} {held} closed outside its order"
                     + (f"; {left} more than the trades held" if left > 0 else ""))
        self._flatten_residual()


    def _flatten_residual(self):
        for side, qty in (("long", self.residual_long), ("short", self.residual_short)):
            if qty <= 0 or any(item.leg_key == f"residual:{side}" for item in self.requests):
                continue
            if f"residual:{side}" in self.legs:
                continue
            self.request_seq += 1
            leg = Leg(f"residual:{side}", {"id": f"residual-{side}", "category": "exit", "type": "market",
                                           "side": side, "limit": None})
            leg.state, leg.request_id = "executing", f"{self.track}:{self.request_seq}"
            leg.closes_snapshot = []
            self.legs[leg.key] = leg
            self.requests.append(ExecRequest(leg.request_id, leg.key, "exit", "sell" if side == "long" else "buy",
                                             None, qty, None, reduce_only=True))

    # ----- inspection -------------------------------------------------------

    def real_position(self):
        signed = sum(((t.real_qty if t.side == "long" else -t.real_qty) for t in self.trades.values()), ZERO)
        return signed + self.residual_long - self.residual_short

    def pending_count(self):
        return sum(1 for leg in self.legs.values() if leg.state != "done")

    def stop(self):
        for key in [k for k, leg in self.legs.items() if leg.state != "executing"]:
            del self.legs[key]
        self.requests = [item for item in self.requests if item.leg_key.startswith("residual:")]


def outward_price(price, increment, side):
    """Round a limit to the instrument grid without making it more aggressive."""
    step = Decimal(str(increment))
    rounding = ROUND_FLOOR if side == "buy" else ROUND_CEILING
    return (Decimal(str(price)) / step).to_integral_value(rounding=rounding) * step
