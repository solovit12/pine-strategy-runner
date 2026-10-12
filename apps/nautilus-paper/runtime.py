"""Multi-market Nautilus Sandbox sidecar with one shared account per venue.

Only official public venue DataClients and simulated Sandbox execution clients
are registered. Venue credentials are removed before client construction. The
child exits on stdin EOF or parent death; an interrupted child is never resumed.
"""

import argparse
import asyncio
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN
import errno
import json
import os
from pathlib import Path
import signal as os_signal
import sys
import time

import nautilus_trader
import nautilus_trader.adapters.hyperliquid as hyperliquid_adapter
from nautilus_trader.adapters.hyperliquid import (
    HyperliquidDataClientConfig, HyperliquidDataClientFactory, HyperliquidEnvironment,
)
from nautilus_trader.adapters.lighter import (
    LighterDataClientConfig, LighterDataClientFactory, LighterDeployment, LighterEnvironment,
)
from nautilus_trader.adapters.sandbox import SandboxExecutionClientConfig, SandboxExecutionClientFactory
from nautilus_trader.common import Environment
from nautilus_trader.config import DataClientConfig
from nautilus_trader.execution import MakerTakerFeeModel
from nautilus_trader.live import LiveNode, RoutingConfig
from nautilus_trader.model import (
    AccountType, BookType, ClientId, ClientOrderId, Money, OmsType, OrderSide, Quantity, TimeInForce, TraderId,
)

from data_bridge import (
    OfflineSourceFactory, PaperFeedFactory, PublicBridge, SPECS, USDC, make_specs, track_key,
)
from pine_orders import PineOrderManager, outward_price
from psr_sdk import Instrument, resolve_params
from psr_sdk.packs import load_strategy
from psr_sdk.runner import StrategyRunner
from paper_core import (
    ACTIVE_ORDER_STATES, ENTRY_BOOK_WINDOW_MS, ENTRY_MAX_WAIT_MS, SOURCE_CLOCK_SKEW_NS, TrackStrategy, decimal_string,
    now_ms, positive, validate_common,
)
from diagnostics import DecisionDiagnostics


PINNED_NAUTILUS = "2.0.0rc6.dev20260929"
PINNED_FAST_NAUTILUS = "2.0.0rc6.dev20260929+hlfast5.1"
RECOVERY_PROGRESS_MS = 30_000
# A reconnected market without a fresh book is revived on its own: resubscribe its book
# (the venue answers with a full snapshot) after these waits, the last one repeating.
# The venue socket is never reconnected for one market: that would pause the healthy ones.
REVIVE_DELAYS_MS = (10_000, 30_000, 60_000, 300_000)
# Runs now continue across UTC days; bound per-run journal growth instead.
OUTBOX_CAP_BYTES = 512 * 1024 * 1024
SNAPSHOT_IDLE_MS = 15_000


def require_fast_book_support():
    # The stock pinned adapter silently ignores unknown subscription params.
    # This marker is exported by the patched native module, not a config file.
    if (nautilus_trader.__version__ != PINNED_FAST_NAUTILUS
            or getattr(hyperliquid_adapter, "HYPERLIQUID_FAST_BOOK_SUPPORTED", False) is not True):
        raise ValueError("Hyperliquid fast book requires the separately qualified native fast-book build")


def utc_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class EventEmitter:
    def __init__(self, run_id: str, output_fd: int, outbox_path: Path):
        self.run_id = run_id
        self.output_fd = output_fd
        self.seq = 0
        self.bytes_written = 0
        self.outbox_fd = os.open(str(outbox_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        self.on_failure = None

    def close(self):
        os.close(self.outbox_fd)

    @staticmethod
    def _write_full(fd, content):
        view = memoryview(content)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("event stream write made no progress")
            view = view[written:]

    def emit(self, event_type: str, **fields):
        self.seq += 1
        item = {"v": 1, "seq": self.seq, "at": utc_iso(), "type": event_type,
                "runId": self.run_id, **fields}
        if item.get("venue", "__absent__") is None:
            item.pop("venue")
        payload = (json.dumps(item, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        if self.bytes_written + len(payload) > OUTBOX_CAP_BYTES:
            error = OSError("Paper event outbox reached 512 MiB cap")
            if self.on_failure:
                self.on_failure(error)
            raise error
        try:
            self._write_full(self.outbox_fd, payload)
            os.fsync(self.outbox_fd)
            self.bytes_written += len(payload)
            self._write_full(self.output_fd, b"PSR_EVENT=" + payload)
        except OSError as exc:
            if self.on_failure:
                self.on_failure(exc)
            raise


def write_child_identity(run_id: str, parent_pid: int, directory: Path):
    path = directory / "nautilus-child.json"
    content = (json.dumps({"experimentId": run_id, "childPid": os.getpid(),
                           "parentPid": parent_pid}, separators=(",", ":")) + "\n").encode()
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        EventEmitter._write_full(fd, content)
        os.fsync(fd)
    finally:
        os.close(fd)
    dir_fd = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


PINE_STRATEGY = "pine_orders_v1"
PINE_TIMEFRAMES_MS = (60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000, 604_800_000)


def validate_pine_config(raw: dict):
    """Generic Pine strategy: orders arrive from the API after every closed bar."""
    validate_common(raw)
    specs = make_specs(raw.get("tracks"), require_both=False)
    if raw.get("timeframeMs") not in PINE_TIMEFRAMES_MS:
        raise ValueError("timeframeMs must be a supported Pine timeframe")
    percent = positive(raw.get("orderSizePercent"), "orderSizePercent")
    if percent > Decimal("100"):
        raise ValueError("orderSizePercent must be 0..100")
    raw["orderSizePercent"] = decimal_string(percent)
    ticks = raw.get("minticks")
    if not isinstance(ticks, dict) or set(ticks) != set(specs):
        raise ValueError("minticks must cover exactly the selected tracks")
    for key, value in ticks.items():
        tick = positive(value, f"{key} mintick")
        ticks[key] = decimal_string(tick)
    return raw


PYTHON_STRATEGY = "python_strategy_v1"


def validate_python_config(raw: dict):
    """A Python SDK strategy from a strategy pack; bars arrive from the API."""
    strategy = raw.get("strategy")
    if not isinstance(strategy, dict) or set(strategy) - {"ref", "packPaths", "params", "packSha256"}:
        raise ValueError("strategy must contain ref, packPaths, params and packSha256")
    paths = strategy.get("packPaths") or []
    if not isinstance(paths, list) or any(not isinstance(path, str) or not Path(path).is_absolute() for path in paths):
        raise ValueError("strategy.packPaths must be absolute directories")
    cls, digest = load_strategy(strategy.get("ref"), paths)
    if strategy.get("packSha256") not in (None, digest):
        raise ValueError("strategy pack changed after launch was prepared")
    strategy["packSha256"] = digest
    strategy["params"] = resolve_params(cls, strategy.get("params") or {})
    raw["strategyClass"] = cls
    return validate_pine_config({**raw, "nativeStrategy": PINE_STRATEGY}) | {"nativeStrategy": PYTHON_STRATEGY}


def native_module():
    """The private native strategy module; absent from the public edition."""
    try:
        import native_strategy
    except ImportError as exc:
        raise ValueError("this edition runs Pine and Python strategies only") from exc
    return native_strategy


def validate_config(raw: dict):
    if raw.get("nativeStrategy") == PYTHON_STRATEGY:
        return validate_python_config(raw)
    if raw.get("nativeStrategy") == PINE_STRATEGY:
        return validate_pine_config(raw)
    return native_module().validate_native_config(raw)


class PineTrackStrategy(TrackStrategy):
    """One market track of an arbitrary Pine strategy.

    Inputs (quotes, books, freshness, reconnect recovery) come from the shared
    TrackStrategy core. Decisions come from Pine order sets (PineOrderManager);
    every execution is a Sandbox IOC order against the current book.
    """

    def __init__(self, context):
        super().__init__(context)
        self.manager = PineOrderManager(self.spec.key, self.run_config["minticks"][self.spec.key],
                                        lambda message: self.controller.event(self.spec.key, message))
        self.queue = []
        self.inflight = None
        self.next_alert_ms = None
        self.avg_open = Decimal("0")
        self.position = Decimal("0")  # signed real position of this track
        self.open_fee = Decimal("0")  # entry fees of the open position not yet charged to an exit
        self.reported = 0

    # ----- Pine order sets and decisions -------------------------------------

    def bar_boundary(self, boundary_ms):
        self.manager.boundary(boundary_ms)

    def apply_orders(self, item):
        self.manager.apply_set(item, now_ms())
        self.controller.event(self.spec.key, f"Pine order set for bar closing {item['barCloseMs']}: "
                              f"{len(item.get('orders') or [])} order(s), {len(item.get('trades') or [])} open Pine trade(s)")
        if not self.controller.track_recovering(self.spec.key) and not self.controller.stopping and self.fresh():
            self._try_orders(now_ms())
        self._flush_reports()

    def _decide(self, quote, at_ms):
        self.manager.input_source_ns = quote.ts_event
        self.manager.on_quote(quote.bid_price, quote.ask_price, at_ms)

    def _try_orders(self, at_ms):
        if self.controller.track_recovering(self.spec.key) or self.controller.stopping:
            return
        if self.last_quote is not None:
            self.manager.input_source_ns = self.last_quote_event_ns
            self.manager.evaluate(at_ms)
        self.queue.extend(self.manager.take_requests())
        self._pump(at_ms)
        self._flush_reports()
        self._schedule()

    def _on_due(self):
        self.next_alert_ms = None
        if self.controller.track_recovering(self.spec.key) or self.controller.stopping:
            return
        at_ms = now_ms()
        if self.input_diagnostics(at_ms)[0]:
            self._schedule()
            return
        self._try_orders(at_ms)

    def _schedule(self):
        at_ms = now_ms()
        wake = self.manager.next_wakeup_ms(at_ms)
        deadlines = [request.created_ms + ENTRY_MAX_WAIT_MS for request in self.queue
                     if request.ioc and request.created_ms + ENTRY_MAX_WAIT_MS > at_ms]
        if deadlines:
            wake = min([wake, *deadlines]) if wake is not None else min(deadlines)
        if wake is None:
            return
        if self.next_alert_ms is not None and at_ms < self.next_alert_ms <= wake:
            return  # an earlier alert is already armed
        self.next_alert_ms = wake
        self._alert("pine", wake)

    def _flush_reports(self):
        for report in self.manager.take_reports():
            fields = {name: report[name] for name in ("orderId", "category", "price", "time", "leg", "qty", "tradeKey")
                      if name in report}
            self.controller.emitter.emit("pine_fill", venue=self.spec.display, market=self.spec.market,
                                         reportSeq=report["seq"], **fields)
            self.reported += 1

    # ----- Sandbox execution -------------------------------------------------

    # Engine outcome -> bounded diagnostic reason.
    DIAGNOSTIC_REASON = {"no_liquidity": "no_liquidity_at_limit", "position_limit": "shared_capital_exhausted",
                         "fillable_below_minimum": "notional_below_minimum"}

    def _pump(self, at_ms):
        progressed = True
        while progressed and self.queue and self.inflight is None:
            progressed = False
            if self.book_revision <= self.last_order_book_revision:
                return  # each IOC needs a book it has not already consumed
            for request in list(self.queue):
                verdict = self._gate(request, at_ms)
                if verdict == "wait":
                    continue  # a later request may go first
                self.queue.remove(request)
                progressed = True
                if verdict == "go":
                    self._submit(request, at_ms)
                else:
                    self._not_sent(request, at_ms, verdict)
                break

    def _gate(self, request, at_ms):
        """Whether a request can meet the current book now ("go"), later ("wait"), or never (a reason)."""
        if not request.ioc:
            # A triggered order must meet a book at least as new as the price
            # that triggered it (a BBO can be newer than the periodic book).
            return "wait" if request.source_ns and self.last_book_event_ns < request.source_ns else "go"
        # Immediate-or-cancel limit entry, evaluated at its modeled arrival.
        side = OrderSide.BUY if request.side == "buy" else OrderSide.SELL
        limit = Decimal(str(request.limit))
        quote = self.last_quote
        if quote is not None and self.last_quote_event_ns > self.last_book_event_ns and not (
                Decimal(str(quote.ask_price)) <= limit if side == OrderSide.BUY else Decimal(str(quote.bid_price)) >= limit):
            return "price_left_limit"  # the newest price already left the limit: nothing to meet
        depth = self._visible_depth(side, limit)
        if depth <= 0 and self.last_book_event_ns < request.source_ns:
            if at_ms >= request.created_ms + ENTRY_MAX_WAIT_MS:
                return "entry_wait_expired"
            request.waited = True
            return "wait"  # the book has not caught up with the price that prompted the order
        if request.waited and self.last_book_event_ns > request.source_ns + ENTRY_BOOK_WINDOW_MS * 1_000_000:
            return "entry_wait_expired"  # only a book from after the arrival is left
        return "go" if depth > 0 else "no_liquidity"

    def _not_sent(self, request, at_ms, reason):
        self.skip("exit" if request.kind == "exit" else "entry", [self.DIAGNOSTIC_REASON.get(reason, reason)])
        self.controller.event(self.spec.key, f"{request.kind} {request.side} not sent: {reason.replace('_', ' ')}")
        self.manager.exec_result(request.id, filled=0, average=0, opened=0, now_ms=at_ms, reason=reason)
        self.queue.extend(self.manager.take_requests())

    def _step(self, value, rounding=ROUND_DOWN):
        step = Decimal(str(self._instrument().size_increment))
        return (Decimal(value) / step).to_integral_value(rounding=rounding) * step

    def _venue_used_notional(self):
        used = Decimal("0")
        for strategy in self.controller.strategies.values():
            if strategy.spec.venue_key == self.spec.venue_key and isinstance(strategy, PineTrackStrategy):
                used += abs(strategy.position) * strategy.avg_open
        return used

    def _submit(self, request, at_ms):
        instrument = self._instrument()
        side = OrderSide.BUY if request.side == "buy" else OrderSide.SELL
        held = Decimal("0")
        if (self.position > 0 and side == OrderSide.SELL) or (self.position < 0 and side == OrderSide.BUY):
            held = abs(self.position)
        close_qty = min(request.close_qty, held)
        if held - close_qty < Decimal(str(instrument.size_increment)):
            close_qty = held  # rounding dust of a full close
        close_qty = self._step(close_qty)
        reason = None
        open_qty = Decimal("0")
        price_ref = Decimal(str(request.limit)) if request.limit is not None else (
            Decimal(str(self.last_quote.ask_price)) if side == OrderSide.BUY else Decimal(str(self.last_quote.bid_price)))
        limit_positions = getattr(self.run_config.get("strategyClass"), "max_positions_per_venue", None)
        if request.open_side is not None and limit_positions and self.position == 0 and sum(
                1 for strategy in self.controller.strategies.values()
                if strategy is not self and strategy.spec.venue_key == self.spec.venue_key
                and isinstance(strategy, PineTrackStrategy)
                and (strategy.position != 0 or (strategy.inflight and strategy.inflight["request"].open_side))
        ) >= limit_positions:
            reason = "position_limit"
        elif request.open_side is not None:
            cash = self.controller.venue_cash(self)
            target = cash * Decimal(self.run_config["orderSizePercent"]) / Decimal("100") * request.size_scale
            fee_rate = self.controller.entry_fee_rate(self.spec.venue_key, self.spec.key)
            available = cash - (self._venue_used_notional() - close_qty * self.avg_open)
            target = min(target, available / (1 + fee_rate))
            open_qty = self._step(max(target, Decimal("0")) / price_ref) if price_ref > 0 else Decimal("0")
            if open_qty <= 0 and target <= 0:
                reason = "shared_capital_exhausted"
            elif (open_qty <= 0 or (instrument.min_quantity and open_qty < Decimal(str(instrument.min_quantity)))
                  or (instrument.min_notional and open_qty * price_ref < instrument.min_notional.as_decimal())):
                open_qty, reason = Decimal("0"), "notional_below_minimum"
        total = close_qty + open_qty
        if request.limit is None:
            visible = self._step(self._visible_depth(side))
            if visible < total:
                total = visible
                reason = reason or "no_liquidity"
        elif request.ioc and open_qty > 0:
            # What can execute at the limit must itself be a closable position.
            fillable = min(total, self._step(self._visible_depth(side, Decimal(str(request.limit)))))
            if ((instrument.min_quantity and fillable < Decimal(str(instrument.min_quantity)))
                    or (instrument.min_notional and fillable * price_ref < instrument.min_notional.as_decimal())
                    or fillable <= 0):
                total, reason = Decimal("0"), "fillable_below_minimum"
        if total <= 0:
            reason = reason or "no_liquidity"
            self.skip("exit" if request.kind == "exit" else "entry",
                      ["insufficient_exit_depth" if request.kind == "exit" and reason == "no_liquidity"
                       else self.DIAGNOSTIC_REASON.get(reason, reason)])
            self.manager.exec_result(request.id, filled=0, average=0, opened=0, now_ms=at_ms, reason=reason)
            self.queue.extend(self.manager.take_requests())
            return
        qty = Quantity.from_str(f"{total:.{instrument.size_precision}f}")
        reduce_only = request.reduce_only or open_qty <= 0
        if request.limit is not None:
            price = instrument.make_price(float(outward_price(request.limit, instrument.price_increment, request.side)))
            order = self.order_factory.limit(self.spec.paper_id, side, qty, price, time_in_force=TimeInForce.IOC,
                                             reduce_only=reduce_only)
        else:
            order = self.order_factory.market(self.spec.paper_id, side, qty, time_in_force=TimeInForce.IOC,
                                              reduce_only=reduce_only)
        self.inflight = {"id": order.client_order_id, "request": request, "requested": Decimal(str(qty)),
                         "close": min(close_qty, Decimal(str(qty))), "filled": Decimal("0"),
                         "quote": Decimal("0"), "reason": reason}
        self.last_order_book_revision = self.book_revision
        self.pending_order_ids.add(str(order.client_order_id))
        self.intents += 1
        self.broker_revision += 1
        what = (f"{request.kind} {request.side} {qty} {self.spec.market}"
                + (f" IOC limit {price}" if request.limit is not None else " IOC market"))
        self.controller.event(self.spec.key, f"Pine {what} submitted (leg {request.leg_key})")
        self.submit_order(order)

    def _on_fill(self, event):
        state = self.inflight
        if state is None or event.client_order_id != state["id"]:
            raise ValueError(f"unowned fill {event.client_order_id}")
        qty = Decimal(str(event.last_qty))
        price = Decimal(str(event.last_px))
        fee = event.commission.as_decimal() if event.commission else Decimal("0")
        state["filled"] += qty
        state["quote"] += qty * price
        if state["filled"] > state["requested"]:
            raise ValueError("Pine order overfill")
        self.fills += 1
        self.broker_revision += 1
        buy = event.order_side == OrderSide.BUY
        sign = Decimal("1") if buy else Decimal("-1")
        closing = min(qty, abs(self.position)) if (self.position < 0) == buy and self.position != 0 else Decimal("0")
        opening = qty - closing
        base_id = (f"{self.spec.key}:{event.trade_id}" if getattr(event, "trade_id", None)
                   else f"{self.spec.key}:{event.client_order_id}:{event.ts_event}")
        parts = []
        if closing > 0:
            gross = (price - self.avg_open) * closing * (Decimal("1") if self.position > 0 else Decimal("-1"))
            share = (fee * closing / qty).quantize(Decimal("0.00000001"))
            remaining = abs(self.position) - closing
            # Realized PnL is net of the exit fee and of the closed part's entry fees.
            entry_share = self.open_fee if remaining == 0 else self.open_fee * closing / abs(self.position)
            self.open_fee -= entry_share
            parts.append(("exit", closing, "long" if self.position > 0 else "short", share,
                          (gross - share - entry_share).quantize(Decimal("0.00000001"))))
            self.position = (remaining if self.position > 0 else -remaining)
            if remaining == 0:
                self.avg_open = Decimal("0")
                self.open_fee = Decimal("0")
        if opening > 0:
            total = abs(self.position) + opening
            self.avg_open = (self.avg_open * abs(self.position) + price * opening) / total
            self.position += sign * opening
            entry_fee = (fee * opening / qty).quantize(Decimal("0.00000001"))
            self.open_fee += entry_fee
            parts.append(("entry", opening, "long" if buy else "short", entry_fee, None))
        for index, (kind, part_qty, position_side, part_fee, realized) in enumerate(parts):
            self.controller.emitter.emit(
                "fill", venue=self.spec.display, market=self.spec.market, kind=kind,
                side="buy" if buy else "sell", positionSide=position_side, quantity=decimal_string(part_qty),
                quote=decimal_string(part_qty * price), price=decimal_string(price), fee=decimal_string(part_fee),
                realizedPnl=decimal_string(realized) if realized is not None else None,
                id=base_id if len(parts) == 1 else f"{base_id}:{index}",
            )
        if state["filled"] == state["requested"]:
            self._complete_inflight()

    def _complete_inflight(self, reason=None):
        state = self.inflight
        self.inflight = None
        self.pending_order_ids.discard(str(state["id"]))
        filled = state["filled"]
        average = state["quote"] / filled if filled > 0 else Decimal("0")
        opened = max(Decimal("0"), filled - state["close"])
        self.manager.exec_result(state["request"].id, filled=filled, average=average, opened=opened,
                                 now_ms=now_ms(), reason=reason or state["reason"])
        self.controller.snapshot()
        if not self.controller.stopping and not self.controller.track_recovering(self.spec.key):
            self._try_orders(now_ms())
        else:
            self._flush_reports()

    def _on_canceled(self, event):
        state = self.inflight
        self.pending_order_ids.discard(str(event.client_order_id))
        self.broker_revision += 1
        if state is None or event.client_order_id != state["id"]:
            self.controller.event(self.spec.key, f"order {event.client_order_id} canceled")
            return
        if state["filled"] < state["requested"]:
            self.controller.event(self.spec.key, f"IOC {event.client_order_id} remainder canceled; filled "
                                  f"{decimal_string(state['filled'])} of {decimal_string(state['requested'])} {self.spec.market}")
        self._complete_inflight("no_liquidity" if state["filled"] <= 0 else None)

    # ----- lifecycle, recovery and reporting -----------------------------------

    def observe_diagnostics(self):
        at_ms = now_ms()
        reasons, ages = self.input_diagnostics(at_ms)
        if self.controller.stopping:
            reasons = []
        elif self.controller.track_recovering(self.spec.key):
            reasons = ["recovery"]
        else:
            if self.manager.entries_gated and any(leg.order.get("category") == "entry" for leg in self.manager.legs.values()):
                reasons.append("entry_delay")  # waiting for the order set of the latest bar
            if any(leg.state == "triggered" for leg in self.manager.legs.values()):
                reasons.append("exit_delay")
            if self.queue and self.book_revision <= self.last_order_book_revision:
                reasons.append("book_not_advanced")
        self.controller.diagnostics[self.spec.key].waits(sorted(set(reasons)), ages)

    def stop_new_orders(self):
        if not (self.controller.track_recovering(self.spec.key) and not self.controller.stopping):
            self.manager.stop()
            self.queue = []
        for order_id in list(self.pending_order_ids):
            order = self.cache.order(ClientOrderId.from_str(order_id))
            if order is not None and str(order.status) in ACTIVE_ORDER_STATES:
                self.cancel_order(order)

    def pause_for_recovery(self, floor_ns):
        self.recovery_cash = self.account_snapshot()["cashBalance"]
        self.recovery_fills = self.controller.venue_fills(self.spec.venue_key)
        self.stop_new_orders()
        self.invalidate_inputs(floor_ns)

    def recovery_audit_ready(self):
        self.recovery_audit_blocker = None
        if self.pending_order_ids or self.inflight:
            self.recovery_audit_blocker = "orders_pending"
            return False
        book = self._book()
        bids, asks = book.bids(depth=1), book.asks(depth=1)
        if not bids or not asks or Decimal(str(bids[0].price)) >= Decimal(str(asks[0].price)):
            self.recovery_audit_blocker = "book_invalid"
            self.controller.record_invalid_book(self)
            return False
        if self.cache.orders_open(instrument_id=self.spec.paper_id):
            raise ValueError("unowned open Sandbox order during recovery")
        quote = self.last_quote
        if quote is None or Decimal(str(quote.ask_price)) <= Decimal(str(quote.bid_price)):
            self.recovery_audit_blocker = "quote_invalid"
            return False
        positions = self.cache.positions_open(instrument_id=self.spec.paper_id)
        sandbox = Decimal("0")
        for position in positions:
            qty = Decimal(str(position.quantity))
            sandbox += qty if str(position.side).upper().endswith("LONG") else -qty
        if sandbox != self.position or self.position != self.manager.real_position():
            raise ValueError(f"Sandbox ({sandbox}), track ({self.position}) and Pine mirror "
                             f"({self.manager.real_position()}) positions disagree during recovery")
        balance = self.cache.account_for_venue(self.spec.paper_venue).balance(USDC)
        if balance is None or not balance.total.as_decimal().is_finite():
            raise ValueError("virtual USDC balance unavailable during recovery")
        if self.controller.venue_fills(self.spec.venue_key) == self.recovery_fills and balance.total.as_decimal() != Decimal(self.recovery_cash):
            raise ValueError("virtual balance changed without a recorded fill during recovery")
        return True

    def resume_after_recovery(self):
        self.last_order_book_revision = self.book_revision
        self.recovery_cash = None

    def account_snapshot(self):
        row = super().account_snapshot()
        row["pendingOrders"] = self.manager.pending_count() + (1 if self.inflight else 0)
        row["signals"] = self.manager.signals
        return row


class SdkTrackStrategy(PineTrackStrategy):
    """A Python SDK strategy on one market track.

    The strategy runs inside this callback thread: every accepted quote and
    every fill reaches it synchronously, and its orders go to the same order
    engine and Sandbox IOC path as Pine orders.
    """

    def __init__(self, context):
        super().__init__(context)
        strategy = self.run_config["strategy"]
        self.runner = StrategyRunner(self.run_config["strategyClass"], params=strategy["params"],
                                     venue=self.spec.venue_key, market=self.spec.market,
                                     mintick=self.run_config["minticks"][self.spec.key],
                                     log=lambda message: self.controller.event(self.spec.key, message),
                                     manager=self.manager)

    def bar_boundary(self, boundary_ms):
        pass  # Python strategies decide on their own bars and quotes; entries are never gated

    def apply_orders(self, item):
        raise ValueError("Pine order sets are not accepted by a Python strategy run")

    def receive_bars(self, bars, live):
        if not isinstance(bars, list) or not bars or len(bars) > 10_000:
            raise ValueError("bars must be a non-empty list")
        at_ms = now_ms()
        if not self.runner.started:
            if live:
                raise ValueError("live bar before warm-up")
            self.runner.warm_up(bars)
            self.runner.start(at_ms)
            self.controller.event(self.spec.key, f"{self.runner.strategy_cls.name}: warmed up on {len(bars)} bars, started")
        else:
            for bar in bars:
                self.runner.on_bar(bar, at_ms)
        if not self.controller.track_recovering(self.spec.key) and not self.controller.stopping and self.fresh():
            self._try_orders(at_ms)

    def _decide(self, quote, at_ms):
        self.manager.input_source_ns = quote.ts_event
        if self.runner.instrument is None:
            instrument = self._instrument()
            self.runner.instrument = Instrument(
                Decimal(str(instrument.price_increment)), Decimal(str(instrument.size_increment)),
                Decimal(str(instrument.min_quantity)) if instrument.min_quantity else None,
                instrument.min_notional.as_decimal() if instrument.min_notional else None)
        if self.runner.started:
            self.runner.on_quote(quote.bid_price, quote.ask_price, at_ms)
        else:
            self.manager.on_quote(quote.bid_price, quote.ask_price, at_ms)

    def _flush_reports(self):
        if not self.runner.started:
            return
        at_ms = now_ms()
        self.runner.drain(at_ms)
        # Orders placed from on_fill join the same queue at once.
        self.queue.extend(self.manager.take_requests())
        self._pump(at_ms)

    def account_snapshot(self):
        row = super().account_snapshot()
        row["signals"] = self.manager.signals
        row["rejectedSignals"] = self.runner.rejected
        return row


class RuntimeController:
    def __init__(self, config, emitter):
        self.config = config
        self.python = config.get("nativeStrategy") == PYTHON_STRATEGY
        self.pine = config.get("nativeStrategy") == PINE_STRATEGY or self.python
        self.specs = make_specs(config.get("tracks"), require_both=not self.pine)
        self.last_boundary_ms = None
        self.emitter = emitter
        self.emitter.on_failure = self._outbox_failure
        self.stop_event = asyncio.Event()
        self.stopping = False
        self.failed = False
        self.stop_reason = None
        self.stage = "waiting_for_data"
        self.strategies = {}
        # Source-side bridges per market; revival resubscribes a market's book through it.
        self.bridges = {}
        self.public_frames = {key: 0 for key in self.specs}
        self.last_public_ms = {key: None for key in self.specs}
        self.instrument_ready_keys = set()
        self.socket_status = {}
        self.connected_endpoints = set()
        self.started_ms = now_ms()
        self.recovery_started_ns = None
        self.recovery_gaps = {}
        self.recovery_count = 0
        self.last_recovery_progress_ns = None
        self.recovery_first_market_ready_ns = None
        self.recovery_rejection_examples = set()
        self.recovery_rejected_books = {}
        self.recovery_book_samples = {}
        # Presence blocks decisions; None awaits an eligible source batch,
        # otherwise the tuple identifies the replacement awaiting delivery.
        self.book_sync_required = {}
        self.accepted_source_ns = {(key, kind): 0 for key in self.specs for kind in ("quote", "book")}
        # Latest accepted PAPER input per venue socket (any selected market).
        self.venue_stream = {venue: {"delivery_ms": 0, "source_ns": 0} for venue in SPECS}
        self.diagnostics = {key: DecisionDiagnostics(lambda message, key=key: self.event(key, message))
                            for key in self.specs}

    @property
    def recovering(self):
        """Any market is recovering; each market pauses and resumes on its own."""
        return self.recovery_started_ns is not None

    def track_recovering(self, key):
        return key in self.recovery_gaps

    def _outbox_failure(self, error):
        self.failed = True
        self.stopping = True
        self.stop_reason = f"event outbox failure: {error}"
        self.stop_event.set()
        print(self.stop_reason, file=sys.stderr, flush=True)

    def event(self, venue_key, message):
        spec = self.specs[venue_key]
        extra = {"market": spec.market} if self.config.get("tracks") else {}
        self.emitter.emit("event", venue=spec.display, message=message, **extra)

    def note_venue_input(self, venue, source_ns, at_ms):
        stream = self.venue_stream[venue]
        stream["delivery_ms"] = max(stream["delivery_ms"], at_ms)
        stream["source_ns"] = max(stream["source_ns"], source_ns)

    def reset_venue_stream(self, venue):
        self.venue_stream[venue] = {"delivery_ms": 0, "source_ns": 0}

    def venue_fills(self, venue):
        return sum(strategy.fills for strategy in self.strategies.values()
                   if strategy.spec.venue_key == venue)

    def venue_cash(self, strategy):
        account = strategy.cache.account_for_venue(strategy.spec.paper_venue)
        balance = account.balance(USDC) if account else None
        if balance is None:
            raise ValueError("virtual USDC account unavailable")
        return balance.total.as_decimal()

    def entry_fee_rate(self, venue, key=None):
        fees = self.config.get("marketFees", {}).get(key) or self.config["fees"][venue]
        return max(Decimal(str(fees["makerPercent"])), Decimal(str(fees["takerPercent"]))) / Decimal("100")

    def flush_diagnostics(self, *, force=False, reason="periodic", close=False):
        for diagnostic in self.diagnostics.values():
            if close:
                diagnostic.waits([])
            diagnostic.flush(force=force, reason=reason)

    def close_diagnostics(self, reason):
        # A diagnostics failure must never strand Stop or suppress the final
        # account snapshot. The raw process log remains a fallback if disk fails.
        try:
            self.flush_diagnostics(force=True, reason=reason, close=True)
        except Exception as exc:
            message = f"Paper diagnostic flush failed: {type(exc).__name__}: {exc}"
            self.failed = True
            self.stop_reason = self.stop_reason or message
            print(message, file=sys.stderr, flush=True)
            try:
                self.emitter.emit("failure", message=message)
            except OSError:
                pass

    def public_frame(self, venue_key, kind):
        self.public_frames[venue_key] += 1
        self.last_public_ms[venue_key] = now_ms()

    def instrument_ready(self, venue_key):
        self.instrument_ready_keys.add(venue_key)
        self.event(venue_key, f"Paper {self.specs[venue_key].market} instrument verified and published")

    def socket_state(self, endpoint, state):
        if self.socket_status.get(endpoint) == state:
            return
        self.socket_status[endpoint] = state
        key = "hyperliquid" if "hyperliquid" in endpoint.lower() else "lighter" if "lighter" in endpoint.lower() else None
        self.emitter.emit("event", venue=SPECS[key].display if key else None,
                          message=f"public socket {endpoint}: {state}")
        connected = state in ("SocketState.CONNECTED", "CONNECTED")
        if connected:
            self.connected_endpoints.add(endpoint)
            after_ns = time.time_ns()
            for track_key, spec in self.specs.items():
                if spec.venue_key == key and track_key in self.recovery_gaps and not self.stopping:
                    gap = self.recovery_gaps[track_key]
                    gap.update(connected=True, after_ns=after_ns, book_ready=False, quote_ready=False,
                               next_revive_ns=time.monotonic_ns() + REVIVE_DELAYS_MS[0] * 1_000_000)
                    gap["attempt"] += 1
                    self.strategies[track_key].invalidate_inputs(gap["after_ns"])
                    self.reset_venue_stream(key)
                    self.recovery_diagnostic("socket_connected", venue=key, market=spec.market, attempt=gap["attempt"])
        elif key and endpoint in self.connected_endpoints and not self.stopping:
            for track_key, spec in self.specs.items():
                if spec.venue_key == key:
                    self.begin_recovery(track_key)

    def begin_recovery(self, key):
        floor_ns = time.time_ns()
        if not self.recovering:
            self.recovery_started_ns = time.monotonic_ns()
            self.recovery_first_market_ready_ns = None
            self.recovery_rejection_examples.clear()
            self.recovery_rejected_books.clear()
            self.recovery_book_samples.clear()
            self.recovery_count += 1
            self.last_recovery_progress_ns = None
            self.stage = "recovering"
            self.flush_diagnostics(force=True, reason="recovery", close=True)
            self.emitter.emit("phase", stage="recovering",
                              message="Public data interrupted; the affected markets wait for reconnection and fresh market data")
        if key not in self.recovery_gaps:
            self.recovery_gaps[key] = {
                "started_ns": time.monotonic_ns(), "started_ms": now_ms(), "discarded": 0, "attempt": 0, "revives": 0,
            }
            # Only this market pauses; other markets and the other venue keep trading.
            self.strategies[key].pause_for_recovery(floor_ns)
            self.event(key, f"Public data gap started: {self.specs[key].display}; gap {self.recovery_count}; waiting for verified recovery.")
        self.recovery_gaps[key].update(connected=False, after_ns=floor_ns, book_ready=False, quote_ready=False)
        self.strategies[key].invalidate_inputs(floor_ns)
        self.reset_venue_stream(self.specs[key].venue_key)
        self.snapshot()

    def recover_silent_feed(self, key):
        """Pause on silence too; ask the existing native client to reconnect once.

        Subsequent network retries belong to that client, not a second loop.
        Full post-CONNECTED snapshots and the ordinary account audit still apply.
        """
        spec = self.specs[key]
        for track, candidate in self.specs.items():
            if candidate.venue_key == spec.venue_key:
                self.begin_recovery(track)
        self.event(key, f"Public feed silent for 60 seconds: {spec.market}; reconnect requested.")
        if self.config["mode"] == "public":
            endpoints = [endpoint for endpoint in self.connected_endpoints
                         if spec.venue_key in endpoint.lower()]
            if not endpoints:
                raise ValueError("silent feed has no known public socket to reconnect")
            for endpoint in endpoints:
                self.strategies[key].reconnect_socket(ClientId(str(spec.source_venue)), endpoint)

    def recover_silent_market(self, key):
        """One market silent while its venue still delivers the others: pause and resubscribe it alone."""
        spec = self.specs[key]
        self.begin_recovery(key)
        gap = self.recovery_gaps[key]
        after_ns = time.time_ns()
        gap.update(connected=True, after_ns=after_ns, next_revive_ns=time.monotonic_ns())
        gap["attempt"] += 1
        self.strategies[key].invalidate_inputs(after_ns)
        self.event(key, f"Public feed silent for 60 seconds: {spec.market}; requesting its order book again.")
        self.revive_stalled_tracks()

    def allow_public_frame(self, key, kind, ts_event, ts_init, complete=False):
        if self.stopping:
            return False
        gap = self.recovery_gaps.get(key)
        # System socket callbacks can overtake queued data in Nautilus. Gate
        # before publishing to PAPER_*: Sandbox consumes books before strategy.
        strategy = self.strategies[key]
        # Quotes are ordered within the BBO stream only; a newer book top may
        # already define the effective quote without making this BBO stale.
        previous = max(self.accepted_source_ns[(key, kind)],
                       strategy.last_book_event_ns if kind == "book" else strategy.last_bbo_event_ns)
        source_floor_ns = strategy.input_floor_ns - SOURCE_CLOCK_SKEW_NS
        if ts_event < max(source_floor_ns, previous) or ts_init < strategy.input_floor_ns:
            if gap:
                gap["discarded"] += 1
            reason = ("source_before_reconnect" if ts_event < source_floor_ns else
                      "received_before_reconnect" if ts_init < strategy.input_floor_ns else "source_out_of_order")
            self.diagnostics[key].skip(f"bridge_{kind}", ["initialized_before_reconnect" if reason == "received_before_reconnect" else reason],
                {"eventSourceMs": now_ms() - ts_event // 1_000_000, "eventInitMs": now_ms() - ts_init // 1_000_000})
            self.recovery_rejection(key, kind, reason, ts_event, ts_init, complete)
            return False
        if gap is None:
            self.accepted_source_ns[(key, kind)] = ts_event
            return True
        allowed = (gap["connected"] and ts_init >= gap["after_ns"]
                   and ts_event >= gap["after_ns"] - SOURCE_CLOCK_SKEW_NS)
        if kind == "book" and not gap["book_ready"] and not complete:
            allowed = False
        if not allowed:
            gap["discarded"] += 1
            self.diagnostics[key].skip(f"bridge_{kind}", ["socket_disconnected" if not gap["connected"] else "snapshot_required"],
                {"eventSourceMs": now_ms() - ts_event // 1_000_000, "eventInitMs": now_ms() - ts_init // 1_000_000})
            self.recovery_rejection(key, kind, "socket_disconnected" if not gap["connected"] else "snapshot_required",
                                    ts_event, ts_init, complete)
            return False
        if kind == "book":
            first = not gap["book_ready"]
            gap["book_ready"] = True
        else:
            first = not gap["quote_ready"]
            gap["quote_ready"] = True
        self.accepted_source_ns[(key, kind)] = ts_event
        if first:
            at_ns = time.time_ns()
            self.recovery_diagnostic(f"{kind}_accepted", venue=key, attempt=gap["attempt"],
                sourceAgeMs=(at_ns - ts_event) // 1_000_000, receiveAgeMs=(at_ns - ts_init) // 1_000_000)
        return True

    def book_sync_diagnostic(self, stage, key, **fields):
        self.recovery_diagnostic(stage, track=key, recoveryActive=self.recovering,
            started_ns=self.recovery_started_ns or time.monotonic_ns(), **fields)

    def invalidate_book_projection(self, key):
        if key not in self.book_sync_required:
            self.book_sync_diagnostic("book_projection_invalidated", key)
        self.book_sync_required[key] = None

    def recovery_rejection(self, key, kind, reason, ts_event, ts_init, complete):
        if not self.recovering:
            return
        attempt = self.recovery_gaps.get(key, {}).get("attempt", 0)
        example = (key, kind, reason, attempt)
        if example in self.recovery_rejection_examples:
            return
        self.recovery_rejection_examples.add(example)
        at_ns = time.time_ns()
        self.recovery_diagnostic(f"{kind}_rejected", venue=key, attempt=attempt, reason=reason,
            sourceAgeMs=(at_ns - ts_event) // 1_000_000, receiveAgeMs=(at_ns - ts_init) // 1_000_000,
            complete=bool(complete))

    def record_invalid_book(self, strategy, *, final=False):
        from book_diagnostics import book_state, quote_state

        key = strategy.spec.key
        at_ns = time.monotonic_ns()
        previous = self.recovery_book_samples.get(key)
        if not final and previous is not None and at_ns - previous < 5_000_000_000:
            return
        self.recovery_book_samples[key] = at_ns
        # Separate bounded rows share one sample id. These are DataEngine's
        # source and PAPER caches, not direct inspection of Sandbox's private
        # matching-engine liquidity-consumption state.
        sample = f"{self.recovery_count}:{key}:{at_ns}"
        common = {"track": key, "sample": sample, "final": final}
        for view, instrument in (("paper", strategy.spec.paper_id), ("source", strategy.spec.source_id)):
            self.recovery_diagnostic("book_invalid_detail", **common, view=view,
                book=book_state(strategy.cache.order_book(instrument)))
        self.recovery_diagnostic("book_invalid_detail", **common, view="inputs",
            quote=quote_state(strategy.last_quote), bookRevision=strategy.book_revision,
            sourceFloorNs=strategy.input_floor_ns, lastBookSourceNs=strategy.last_book_event_ns,
            lastBookDeliveryMs=strategy.last_book_ms, ages=strategy.input_diagnostics()[1])

    def recovery_diagnostic(self, stage, *, started_ns=None, **fields):
        # Keep this inside the existing durable event envelope. UI projection
        # hides the technical rows before applying its recent-activity limit.
        origin = self.recovery_started_ns if started_ns is None else started_ns
        elapsed = (time.monotonic_ns() - origin) // 1_000_000
        payload = {"gap": self.recovery_count, "elapsedMs": elapsed, "stage": stage, **fields}
        def emit(body):
            message = "Recovery diagnostic: " + json.dumps(body, separators=(",", ":"))
            if len(message) > 2048:
                raise ValueError("recovery diagnostic exceeds bounded message size")
            self.emitter.emit("event", message=message)
        if len(json.dumps(payload)) < 1800:
            emit(payload)
        else:
            # Ten markets must not overflow the existing durable event contract.
            ages = payload.pop("ages", {})
            blockers = payload.pop("blockedBy", [])
            global_blockers = [reason for reason in blockers if "." not in reason]
            for key in self.specs:
                emit({**payload, "track": key, "ages": {key: ages.get(key, {})},
                      "blockedBy": global_blockers + [reason for reason in blockers if reason.startswith(key + ".")]})

    def recovery_input_state(self):
        blockers, ages = [], {}
        for key, gap in self.recovery_gaps.items():
            # A complete post-reconnect book snapshot also yields the first
            # quote (its top of book); a quiet market need not send a BBO.
            for flag, reason in (("connected", "socket_disconnected"), ("book_ready", "snapshot_missing")):
                if not gap[flag]:
                    blockers.append(f"{key}.{reason}")
        if not self.recovery_gaps:
            blockers.append("gap_missing")
        blockers.extend(self.recovery_input_blockers())
        at_ms = now_ms()
        for key, strategy in self.strategies.items():
            reasons, ages[key] = strategy.input_diagnostics(at_ms)
            blockers.extend(f"{key}.{reason}" for reason in reasons)
        return blockers, ages

    def split_recovery_blockers(self, blockers):
        """Blockers of each recovering market, and those that hold every market."""
        own = {key: [reason for reason in blockers if reason.startswith(f"{key}.")] for key in self.recovery_gaps}
        shared = [reason for reason in blockers if not any(reason.startswith(f"{key}.") for key in self.specs)]
        return own, shared

    def observe_recovery_inputs(self):
        # Evaluate on actual strategy delivery, after Sandbox processed the book.
        # A usable sub-500ms window must not be lost between watchdog polls.
        if self.stopping:
            return
        blockers, ages = self.recovery_input_state()
        own, shared = self.split_recovery_blockers(blockers)
        if not shared and any(not reasons for reasons in own.values()):
            if self.recovery_first_market_ready_ns is None:
                self.recovery_first_market_ready_ns = time.monotonic_ns()
                self.recovery_diagnostic("market_ready", blockedBy=[], ages=ages)
            self.check_recovery(log_wait=False)

    def check_recovery(self, *, log_wait=True):
        if not self.recovering or self.stopping:
            return
        # A network outage is a trading pause, not account/process expiry.
        # Keep checks frequent, but bound repetitive durable diagnostics during
        # an hours-long outage. Milestone/error events still log immediately.
        at_ns = time.monotonic_ns()
        log_wait = log_wait and (self.last_recovery_progress_ns is None
            or (at_ns - self.last_recovery_progress_ns) // 1_000_000 >= RECOVERY_PROGRESS_MS)
        if log_wait:
            self.last_recovery_progress_ns = at_ns
        blockers, ages = self.recovery_input_state()
        own, shared = self.split_recovery_blockers(blockers)
        waiting, resumed, audited = list(shared), [], False
        audit_started_ns = time.monotonic_ns()
        try:
            for key in list(self.recovery_gaps):
                if shared or own[key]:
                    waiting.extend(own[key])
                    continue
                # Each market resumes as soon as its own data and account audit are verified.
                strategy = self.strategies[key]
                audited = True
                if not strategy.recovery_audit_ready():
                    waiting.append(f"{key}.{strategy.recovery_audit_blocker}")
                    continue
                strategy.resume_after_recovery()
                resumed.append(key)
        except Exception as exc:
            self.fail(f"Paper recovery account audit failed: {type(exc).__name__}: {exc}")
            return
        audit_ms = (time.monotonic_ns() - audit_started_ns) / 1_000_000
        for key in resumed:
            gap = self.recovery_gaps.pop(key)
            duration = (time.monotonic_ns() - gap["started_ns"]) // 1_000_000
            self.event(key, f"Public data gap recovered: {self.specs[key].display}; gap {self.recovery_count}; duration {duration} ms; discarded {gap['discarded']} observations.")
        if self.recovery_gaps:
            if log_wait or resumed:
                self.recovery_diagnostic("check", blockedBy=waiting, ages=ages,
                                         audit="partial" if resumed else "waiting" if audited else "not_run", auditMs=audit_ms,
                                         resumed=resumed, waitingFor=sorted(self.recovery_gaps))
            if resumed:
                self.snapshot()
            return
        started_ns = self.recovery_started_ns
        first_ready_ms = ((self.recovery_first_market_ready_ns - started_ns) // 1_000_000
                          if self.recovery_first_market_ready_ns is not None else None)
        self.recovery_started_ns = None
        self.stage = "running"
        self.recovery_diagnostic("resumed", started_ns=started_ns, blockedBy=[], ages=ages,
            auditMs=audit_ms, firstMarketReadyMs=first_ready_ms)
        self.emitter.emit("phase", stage="running", message="Public data recovered; Paper accounts preserved")
        self.snapshot()

    def revive_stalled_tracks(self):
        """Reconnected markets still without a fresh book: ask the venue again, one market at a time.

        Both venues answer an unsubscribe + subscribe of one market's book on the same
        connection with a full snapshot.
        """
        if self.stopping or self.config["mode"] != "public":
            return
        at_ns = time.monotonic_ns()
        for key, gap in list(self.recovery_gaps.items()):
            if not gap.get("connected") or gap.get("book_ready") or at_ns < gap.get("next_revive_ns", at_ns + 1):
                continue
            gap["revives"] += 1
            attempt = gap["revives"]
            gap["next_revive_ns"] = at_ns + REVIVE_DELAYS_MS[min(attempt, len(REVIVE_DELAYS_MS) - 1)] * 1_000_000
            spec = self.specs[key]
            self.event(key, f"{spec.market}: no fresh order book since the reconnect; resubscribing (attempt {attempt}).")
            self.bridges[key].resubscribe_book()
            self.snapshot()

    # ----- strategy-kind hooks (the native strategy overrides them) -----------

    def strategy_class(self):
        return SdkTrackStrategy if self.python else PineTrackStrategy

    def on_tick(self, at_ms):
        """Watchdog tick: closed bars gate Pine entries until their order set arrives."""
        if self.pine:
            self.bar_boundary(at_ms)

    def extra_command(self, command, item):
        """A strategy-specific stdin command; False when unknown."""
        return False

    def recovery_input_blockers(self):
        """Extra inputs a strategy kind needs before recovery completes."""
        return []

    def fail(self, message, venue_key=None):
        if self.failed:
            return
        self.failed = True
        self.stopping = True
        self.stop_reason = message
        try:
            self.record_unresolved_gaps()
            extra = ({"market": self.specs[venue_key].market}
                     if venue_key and self.config.get("tracks") else {})
            self.emitter.emit("failure", venue=self.specs[venue_key].display if venue_key else None,
                              message=message, **extra)
            self.emitter.emit("phase", stage="stopping", message="Both virtual accounts interrupted")
        except OSError:
            pass
        finally:
            try:
                self.close_diagnostics("failure")
            finally:
                self.stage = "stopping"
                self.stop_event.set()

    def request_stop(self, reason):
        if self.stopping:
            return
        self.stopping = True
        self.stop_reason = reason
        self.stage = "stopping"
        try:
            self.record_unresolved_gaps()
            self.emitter.emit("phase", stage="stopping", message=f"Stopping both Paper accounts: {reason}")
        except OSError:
            pass
        finally:
            try:
                self.close_diagnostics("stop")
            finally:
                self.stop_event.set()

    def record_unresolved_gaps(self):
        for key, gap in self.recovery_gaps.items():
            if gap.get("ended"):
                continue
            duration = (time.monotonic_ns() - gap["started_ns"]) // 1_000_000
            gap["ended"] = True
            self.event(key, f"Public data gap ended without recovery: {self.specs[key].display}; gap {self.recovery_count}; duration {duration} ms; discarded {gap['discarded']} observations.")

    def material_state(self):
        return (self.stage, tuple(
            (key, strategy.fills, strategy.manager.pending_count(), str(strategy.position), bool(strategy.fresh()))
            for key, strategy in self.strategies.items()))

    def has_open_positions(self):
        return any(strategy.cache.positions_open(instrument_id=strategy.spec.paper_id)
                   for strategy in self.strategies.values())

    def snapshot(self):
        accounts, tracks = [], []
        counters = ("brokerRevision", "publicFrames", "pendingOrders", "signals", "intents", "fills",
                    "rejectedSignals", "stalePriceObservationsSkipped")
        for venue, venue_spec in SPECS.items():
            rows = []
            for key, spec in self.specs.items():
                if spec.venue_key != venue:
                    continue
                strategy = self.strategies.get(key)
                row = strategy.account_snapshot() if strategy else {
                    "venue": spec.display, "cashBalance": self.config["capitalPerVenue"],
                    **{name: 0 for name in counters}, "priceReady": False, "positions": [],
                }
                rows.append(row)
                gap = self.recovery_gaps.get(key)
                tracks.append({"venue": spec.display, "market": spec.market,
                    **{name: row[name] for name in counters if name != "brokerRevision"}, "priceReady": row["priceReady"],
                    # A market waiting for data after a gap; the page lists it with its age and retries.
                    **({"dataGap": {"sinceMs": gap["started_ms"], "connected": bool(gap.get("connected")),
                                    "resubscribes": gap["revives"]}} if gap else {})})
            if not rows:
                # A venue without selected markets keeps its untouched account.
                accounts.append({"venue": venue_spec.display, "cashBalance": self.config["capitalPerVenue"],
                    **{name: 0 for name in counters}, "priceReady": True, "positions": []})
                continue
            cash_values = {row["cashBalance"] for row in rows}
            if len(cash_values) != 1:
                raise ValueError("markets disagree on shared venue balance")
            accounts.append({"venue": venue_spec.display, "cashBalance": rows[0]["cashBalance"],
                **{name: sum(row[name] for row in rows) for name in counters},
                "priceReady": all(row["priceReady"] for row in rows),
                "positions": [position for row in rows for position in row["positions"]]})
        # Legacy HYPE-only clients/tests accept the original envelope unchanged.
        extra = {"tracks": tracks} if self.config.get("tracks") else {}
        self.emitter.emit("snapshot", stage=self.stage, accounts=accounts, **extra)

    def strategy_bars(self, item, live):
        if not self.python:
            raise ValueError("bars are accepted only by a Python strategy run")
        key = track_key(item.get("venue"), item.get("market"))
        if key not in self.strategies:
            raise ValueError("bars for an unselected track")
        if self.stopping:
            return
        strategy = self.strategies[key]
        strategy._guard("strategy bars", lambda: strategy.receive_bars(item.get("bars"), live))

    def pine_orders(self, item):
        if not self.pine or self.python:
            raise ValueError("Pine order sets require the Pine runtime")
        venue = item.get("venue")
        key = track_key(venue, item.get("market"))
        if key not in self.strategies:
            raise ValueError("Pine order set for an unselected track")
        if self.stopping:
            return
        self.strategies[key]._guard("Pine order set", lambda: self.strategies[key].apply_orders(item))

    def bar_boundary(self, at_ms):
        frame = self.config["timeframeMs"]
        boundary = at_ms // frame * frame
        if self.last_boundary_ms is None:
            self.last_boundary_ms = boundary
            return
        if boundary > self.last_boundary_ms:
            self.last_boundary_ms = boundary
            for strategy in self.strategies.values():
                strategy.bar_boundary(boundary)



def make_controller(config, emitter):
    """The run controller for the configured strategy kind."""
    if config.get("nativeStrategy") in (PINE_STRATEGY, PYTHON_STRATEGY):
        return RuntimeController(config, emitter)
    native = native_module()
    controller_class = type("NativeController", (native.NativeControllerMixin, RuntimeController), {})
    return controller_class(config, emitter)


def parent_alive(parent_pid):
    if os.getppid() != parent_pid:
        return False
    try:
        os.kill(parent_pid, 0)
        return True
    except OSError as exc:
        return exc.errno == errno.EPERM


def build_node(config, controller):
    if config["mode"] == "public" and config.get("hyperliquidFastBook", False):
        require_fast_book_support()
    feeds = {}
    offline_sources = {}
    builder = (LiveNode.builder(
        f"PSR-PAPER-{config['runId'][:8]}", TraderId("PSR-PAPER-001"), Environment.SANDBOX,
    ).with_reconciliation(False).with_delay_post_stop_secs(0).with_timeout_connection(20))
    for key, spec in SPECS.items():
        venue_specs = [track for track in controller.specs.values() if track.venue_key == key]
        if not venue_specs:
            continue  # a Pine run may use one venue only
        if config["mode"] == "public":
            if key == "lighter":
                factory = LighterDataClientFactory()
                source_config = LighterDataClientConfig(
                    environment=LighterEnvironment.MAINNET,
                    deployment=LighterDeployment.LIGHTER,
                )
            else:
                factory = HyperliquidDataClientFactory()
                source_config = HyperliquidDataClientConfig(environment=HyperliquidEnvironment.MAINNET)
        else:
            factory = OfflineSourceFactory(venue_specs, offline_sources)
            source_config = DataClientConfig()
        builder = builder.add_data_client(
            str(spec.source_venue), factory, source_config,
            RoutingConfig(default=False, venues=[str(spec.source_venue)]),
        )
        builder = builder.add_data_client(
            str(spec.paper_venue), PaperFeedFactory(venue_specs, feeds), DataClientConfig(),
            RoutingConfig(default=False, venues=[str(spec.paper_venue)]),
        )
        fee_row = config["fees"][key]
        maker_rate = Decimal(str(fee_row["makerPercent"])) / Decimal("100")
        taker_rate = Decimal(str(fee_row["takerPercent"])) / Decimal("100")
        overrides = {track.paper_id: (Decimal(str(row["makerPercent"])) / Decimal("100"),
                                      Decimal(str(row["takerPercent"])) / Decimal("100"))
                     for track in venue_specs
                     for row in [config.get("marketFees", {}).get(track.key)] if row}
        builder = builder.add_simulated_exec_client(
            str(spec.paper_venue), SandboxExecutionClientFactory(),
            SandboxExecutionClientConfig(
                venue=spec.paper_venue,
                starting_balances=[Money(Decimal(config["capitalPerVenue"]), USDC)],
                account_type=AccountType.MARGIN, oms_type=OmsType.NETTING,
                default_leverage=Decimal("1"), book_type=BookType.L2_MBP,
                trade_execution=False, bar_execution=False,
                liquidity_consumption=True,
                fee_model=MakerTakerFeeModel(maker_rate, taker_rate, overrides or None),
            ),
        )
    node = builder.build()
    for key, spec in controller.specs.items():
        node.add_strategy(PublicBridge((spec, feeds, controller)))
    strategy_class = controller.strategy_class()
    for key, spec in controller.specs.items():
        strategy = strategy_class((spec, controller, config))
        node.add_strategy(strategy)
        controller.strategies[key] = strategy
    return node, offline_sources


async def monitor_stdin(controller, offline_sources):
    fd = sys.stdin.fileno()
    os.set_blocking(fd, False)
    buffer = b""
    while not controller.stop_event.is_set():
        try:
            chunk = os.read(fd, 65_536)
        except BlockingIOError:
            await asyncio.sleep(0.02)
            continue
        if not chunk:
            controller.request_stop("stdin EOF / controlling API disconnected")
            return
        buffer += chunk
        if len(buffer) > 1_048_576:
            controller.fail("stdin command exceeded 1 MiB")
            return
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                if not isinstance(item, dict):
                    raise ValueError("command must be a JSON object")
                command = item.get("cmd")
                if command == "stop":
                    controller.request_stop(str(item.get("reason", "user"))[:200])
                    return
                if controller.extra_command(command, item):
                    continue
                if command in ("bars", "bar"):
                    controller.strategy_bars(item, command == "bar")
                    continue
                if command == "pine_orders":
                    controller.pine_orders(item)
                    continue
                if command == "socket" and controller.config["mode"] == "offline":
                    venue, state = item["venue"], item["state"]
                    if venue not in SPECS or state not in ("CONNECTED", "DISCONNECTED"):
                        raise ValueError("invalid offline socket state")
                    controller.socket_state(f"{venue}-data-streams", state)
                elif command == "snapshot" and controller.config["mode"] == "offline":
                    controller.snapshot()
                elif command == "frame" and controller.config["mode"] == "offline":
                    venue = item["venue"]
                    key = track_key(venue, item.get("market", "HYPE"))
                    if key not in controller.specs or key not in offline_sources:
                        raise ValueError("offline source not ready")
                    offline_sources[key].publish_frame(item["bids"], item["asks"], market=item.get("market", "HYPE"),
                        part=item.get("part", "both"), snapshot=item.get("snapshot", True), age_ms=item.get("ageMs", 0),
                        source_lag_ms=item.get("sourceLagMs", 0))
                else:
                    raise ValueError(f"unsupported command: {command}")
            except Exception as exc:
                controller.fail(f"stdin command failed: {type(exc).__name__}: {exc}")
                return


async def watchdog(controller, node_task):
    last_snapshot = 0
    last_signature = None
    while not controller.stop_event.is_set():
        await asyncio.sleep(0.5)
        if controller.stop_event.is_set() or controller.stopping:
            # Stop/failure owns shutdown; a node stopping now is expected.
            return
        if not parent_alive(controller.config["parentPid"]):
            controller.request_stop("controlling API process died")
            return
        try:
            controller.on_tick(now_ms())
        except Exception as exc:
            controller.fail(f"bar/day boundary handling failed: {type(exc).__name__}: {exc}")
            return
        if node_task.done():
            try:
                await node_task
                controller.fail("Nautilus node stopped unexpectedly")
            except Exception as exc:
                controller.fail(f"Nautilus node failed: {type(exc).__name__}: {exc}")
            return
        at_ms = now_ms()
        try:
            controller.revive_stalled_tracks()
            controller.check_recovery()
        except Exception as exc:
            controller.fail(f"Paper recovery check failed: {type(exc).__name__}: {exc}")
            return
        if controller.stopping:
            return
        try:
            for strategy in controller.strategies.values():
                strategy.observe_diagnostics()
            controller.flush_diagnostics()
        except Exception as exc:
            controller.fail(f"Paper diagnostics failed: {type(exc).__name__}: {exc}")
            return
        for key in controller.specs:
            if controller.track_recovering(key):
                continue
            last = controller.last_public_ms[key]
            if last is None and at_ms - controller.started_ms > 30_000:
                controller.fail(f"{controller.specs[key].display} {controller.specs[key].market} public feed produced no frames for 30 seconds", key)
                return
            if last is not None and at_ms - last > 60_000:
                venue = controller.specs[key].venue_key
                # The whole venue silent means a broken socket; one silent market is resubscribed alone.
                venue_silent = all(
                    controller.track_recovering(other) or (controller.last_public_ms[other] is not None
                                                           and at_ms - controller.last_public_ms[other] > 60_000)
                    for other, spec in controller.specs.items() if spec.venue_key == venue)
                try:
                    if venue_silent:
                        controller.recover_silent_feed(key)
                    else:
                        controller.recover_silent_market(key)
                except Exception as exc:
                    controller.fail(f"Public reconnect request failed: {type(exc).__name__}: {exc}", key)
                    return
                break
        if controller.stage == "waiting_for_data" and all(
            strategy.fresh(at_ms) for strategy in controller.strategies.values()
        ) and len(controller.instrument_ready_keys) == len(controller.specs):
            controller.stage = "running"
            controller.emitter.emit("phase", stage="running", message="All selected Paper markets have fresh public data")
        # Periodic snapshots every 5 s while accounts/orders change, otherwise
        # every 15 s; fills, recovery and phase changes emit their own.
        signature = controller.material_state()
        # Open positions refresh every 5 s so their unrealized PnL stays current.
        if at_ms - last_snapshot >= (5_000 if signature != last_signature or controller.has_open_positions()
                                     else SNAPSHOT_IDLE_MS):
            controller.snapshot()
            last_snapshot, last_signature = at_ms, signature


async def run(config, emitter):
    for key in list(os.environ):
        if key.startswith(("HYPERLIQUID_", "LIGHTER_")):
            del os.environ[key]
    controller = make_controller(config, emitter)
    node = None
    node_task = None
    stdin_task = None
    watchdog_task = None
    try:
        node, offline_sources = build_node(config, controller)
        controller.emitter.emit("phase", stage="waiting_for_data", message="Nautilus Sandbox starting selected markets on two shared venue accounts")
        # Reported on the first Hyperliquid track: a run need not include HYPE (or Hyperliquid at all).
        hyperliquid_track = next((key for key, spec in controller.specs.items() if spec.venue_key == "hyperliquid"), None)
        if config["mode"] == "public" and config.get("hyperliquidFastBook", False) and hyperliquid_track:
            controller.event(hyperliquid_track, "Hyperliquid fast book selected: five levels per side; BBO unchanged")
        controller.snapshot()
        node_task = asyncio.create_task(node.run_async(), name="nautilus-node")
        stdin_task = asyncio.create_task(monitor_stdin(controller, offline_sources), name="stdin-commands")
        watchdog_task = asyncio.create_task(watchdog(controller, node_task), name="runtime-watchdog")
        loop = asyncio.get_running_loop()
        try:
            loop.add_signal_handler(os_signal.SIGTERM, lambda: controller.request_stop("SIGTERM"))
        except NotImplementedError:
            pass
        await controller.stop_event.wait()
    except Exception as exc:
        controller.fail(f"sidecar failure: {type(exc).__name__}: {exc}")
    finally:
        controller.stopping = True
        controller.stage = "stopping"
        for strategy in controller.strategies.values():
            try:
                strategy.stop_new_orders()
            except Exception as exc:
                controller.fail(f"cancel pending Paper order failed: {type(exc).__name__}: {exc}")
        if node_task is not None:
            await asyncio.sleep(0.35)
            if node is not None:
                node.handle().stop()
            try:
                await asyncio.wait_for(asyncio.shield(node_task), timeout=20)
            except Exception as exc:
                controller.fail(f"Nautilus shutdown incomplete: {type(exc).__name__}: {exc}")
        for task in (stdin_task, watchdog_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        try:
            controller.close_diagnostics("shutdown")
            controller.snapshot()
            pending = sum(len(strategy.pending_order_ids) for strategy in controller.strategies.values())
            if pending:
                controller.fail(f"{pending} Paper order(s) remained unresolved at Stop")
            controller.emitter.emit("stopped", reason=controller.stop_reason or "completed")
        finally:
            if node is not None:
                node.dispose()


def main():
    parser = argparse.ArgumentParser(description="Five-market Nautilus Sandbox sidecar")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--check-fast-book", action="store_true")
    args = parser.parse_args()
    if nautilus_trader.__version__ == PINNED_FAST_NAUTILUS:
        require_fast_book_support()
    elif nautilus_trader.__version__ != PINNED_NAUTILUS:
        raise SystemExit(f"Expected qualified Nautilus build, got {nautilus_trader.__version__}")
    if args.check_fast_book:
        require_fast_book_support()
        print(f"PSR_FAST_BOOK_OK={PINNED_FAST_NAUTILUS}", flush=True)
        return
    if args.check:
        print(f"PSR_RUNTIME_OK={nautilus_trader.__version__}", flush=True)
        return
    if args.config is None:
        parser.error("--config is required unless --check is used")
    config = validate_config(json.loads(args.config.read_text(encoding="utf-8")))
    if not parent_alive(config["parentPid"]):
        raise SystemExit("controlling API parent PID is not alive")
    # Preserve the machine-readable pipe. Nautilus' native logger writes to fd
    # 1; redirect that fd to stderr before constructing/starting its node.
    event_fd = os.dup(1)
    os.dup2(2, 1)
    directory = Path(config["eventOutboxPath"]).parent
    write_child_identity(config["runId"], config["parentPid"], directory)
    emitter = EventEmitter(config["runId"], event_fd, Path(config["eventOutboxPath"]))
    try:
        asyncio.run(run(config, emitter))
    finally:
        emitter.close()
        os.close(event_fd)


if __name__ == "__main__":
    main()
