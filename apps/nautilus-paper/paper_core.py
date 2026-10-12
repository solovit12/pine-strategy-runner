"""Shared core of Paper market tracks: run settings, helpers and the track base.

A track is one market of one venue inside a Nautilus Sandbox run. TrackStrategy
receives that market's public quotes and books, keeps them current across
reconnects, times modeled order arrival and reports the account. Strategies
(Pine order sets, Python SDK strategies) decide what to trade on top of it.
"""

from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
import re
import time

from nautilus_trader.config import StrategyConfig
from nautilus_trader.model import BookType, OrderSide, QuoteTick, StrategyId
from nautilus_trader.trading import Strategy

from data_bridge import SPECS, USDC, complete_book, make_specs
from latency import InputTiming


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ACTIVE_ORDER_STATES = {"INITIALIZED", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "PENDING_CANCEL", "PENDING_UPDATE"}
# Modeled order arrival after a touch/trigger. The order is evaluated exactly
# at arrival by a clock alert against the latest known book; it no longer
# waits for the next book message (Hyperliquid snapshots arrive ~every 540 ms).
ENTRY_DELAY_MS = 200
EXIT_DELAY_MS = 300
# A venue stamps data with its own clock. Data received after a reconnect may carry a
# source time slightly before our local reconnect moment (clock skew, or a snapshot
# built when the subscribe arrived); only data received before the reconnect is stale.
SOURCE_CLOCK_SKEW_NS = 2_000_000_000
# An entry that cannot be evaluated on current data within this window after
# arrival is dropped (a real IOC would have been answered long before).
ENTRY_MAX_WAIT_MS = 2_000
# Venue stream liveness: change-only feeds stay silent for an unchanged market.
# A market is current while its venue socket keeps delivering recent messages.
DEFAULT_VENUE_SOURCE_AGE_MS = 2_000
DEFAULT_TRACK_QUIET_MS = 30_000
# A book first seen after arrival may stand in for the arrival-time book only
# within one Hyperliquid snapshot period after the touch; later is look-ahead.
ENTRY_BOOK_WINDOW_MS = 600


def now_ms():
    return time.time_ns() // 1_000_000


def decimal_string(value):
    return format(Decimal(str(value)), "f")


def positive(value, label):
    result = Decimal(str(value))
    if not result.is_finite() or result <= 0:
        raise ValueError(f"{label} must be a positive finite decimal")
    return result


def validate_common(raw: dict):
    if raw.get("v") != 1 or not isinstance(raw.get("runId"), str) or not raw["runId"]:
        raise ValueError("config requires v=1 and runId")
    if not isinstance(raw.get("strategyVersion"), int) or raw["strategyVersion"] < 1:
        raise ValueError("strategyVersion must be a positive saved version number")
    if not isinstance(raw.get("sourceSha256"), str) or not SHA256_RE.fullmatch(raw["sourceSha256"]):
        raise ValueError("sourceSha256 must pin the saved Pine source")
    if raw.get("mode", "public") not in ("public", "offline"):
        raise ValueError("mode must be public or offline")
    if type(raw.get("hyperliquidFastBook", False)) is not bool:
        raise ValueError("hyperliquidFastBook must be a boolean")
    if not isinstance(raw.get("parentPid"), int) or raw["parentPid"] <= 0:
        raise ValueError("parentPid must identify the controlling API process")
    outbox = raw.get("eventOutboxPath")
    if not isinstance(outbox, str) or not Path(outbox).is_absolute() or Path(outbox).name != "nautilus-events.jsonl":
        raise ValueError("eventOutboxPath must be the absolute run-directory nautilus-events.jsonl")
    if not Path(outbox).parent.is_dir() or Path(outbox).parent.is_symlink():
        raise ValueError("event outbox run directory missing or symlinked")
    for key in ("maxQuoteAgeMs", "maxBookAgeMs"):
        if raw.get(key) != 1000:
            raise ValueError(f"{key} must be pinned at 1000")
    for key, default, low, high in (("maxVenueSourceAgeMs", DEFAULT_VENUE_SOURCE_AGE_MS, 1000, 5000),
                                    ("maxTrackQuietMs", DEFAULT_TRACK_QUIET_MS, 1000, 55_000)):
        value = raw.setdefault(key, default)
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f"{key} must be an integer {low}..{high}")
    capital = positive(raw.get("capitalPerVenue"), "capitalPerVenue")
    if capital < Decimal("100"):
        raise ValueError("capitalPerVenue must be at least 100 USDC")
    raw["capitalPerVenue"] = decimal_string(capital)
    fees = raw.get("fees")
    if not isinstance(fees, dict) or set(fees) != set(SPECS):
        raise ValueError("fees must contain exactly lighter and hyperliquid")
    for venue in SPECS:
        row = fees[venue]
        if not isinstance(row, dict) or set(row) != {"makerPercent", "takerPercent"}:
            raise ValueError(f"{venue} needs explicit makerPercent and takerPercent")
        for name in ("makerPercent", "takerPercent"):
            value = Decimal(str(row[name]))
            if not value.is_finite() or not Decimal("0") <= value <= Decimal("100"):
                raise ValueError(f"{venue} {name} must be 0..100 percent")
    # Optional per-track fees (Hyperliquid HIP-3 markets charge a multiple of the venue fee).
    market_fees = raw.setdefault("marketFees", {})
    track_keys = set(make_specs(raw.get("tracks"), require_both=False)) if raw.get("tracks") else set(SPECS)
    if not isinstance(market_fees, dict) or not set(market_fees) <= track_keys:
        raise ValueError("marketFees must name selected tracks")
    for key, row in market_fees.items():
        if not isinstance(row, dict) or set(row) != {"makerPercent", "takerPercent"}:
            raise ValueError(f"{key} needs explicit makerPercent and takerPercent")
        for name in ("makerPercent", "takerPercent"):
            value = Decimal(str(row[name]))
            if not value.is_finite() or not Decimal("0") <= value <= Decimal("100"):
                raise ValueError(f"{key} {name} must be 0..100 percent")


class TrackStrategy(Strategy):
    """Inputs, timing and reporting of one market track; subclasses decide and execute."""

    def __init__(self, context):
        spec, controller, config = context
        tag = str(int(spec.strategy_tag) + 100)
        super().__init__(StrategyConfig(strategy_id=StrategyId(f"PSR-PAPER-{tag}")))
        self.spec = spec
        self.controller = controller
        self.run_config = config
        self.last_quote_ms = 0
        self.last_quote_event_ms = 0
        self.last_quote_event_ns = 0
        self.last_book_ms = 0
        self.last_book_event_ms = 0
        self.last_book_event_ns = 0
        # Quotes older than an open position's source time never act on it.
        self.position_source_floor_ns = 0
        self.last_book_key = None
        self.book_revision = 0
        self.last_order_book_revision = 0
        self.last_quote = None
        self.broker_revision = 0
        self.signals = 0
        self.intents = 0
        self.fills = 0
        self.rejected_signals = 0
        self.stale_skipped = 0
        self.pending_order_ids = set()
        self.last_socket_connected = False
        self.recovery_cash = None
        self.recovery_fills = 0
        self.input_floor_ns = 0
        self.recovery_audit_blocker = None
        self.quote_timing = self.book_timing = None
        # Source time of the last venue BBO message; the effective quote may
        # instead come from a newer book top (see _quote_from_book).
        self.last_bbo_event_ns = 0
        self.timer_seq = 0

    # ----- decisions and execution: provided by the strategy kind ------------

    def _decide(self, quote, at_ms):
        raise NotImplementedError

    def _try_orders(self, at_ms):
        raise NotImplementedError

    def _on_due(self):
        raise NotImplementedError

    def _on_fill(self, event):
        raise NotImplementedError

    def _on_canceled(self, event):
        raise NotImplementedError

    def observe_diagnostics(self):
        raise NotImplementedError

    def stop_new_orders(self):
        raise NotImplementedError

    def pause_for_recovery(self, floor_ns):
        raise NotImplementedError

    def recovery_audit_ready(self):
        raise NotImplementedError

    def resume_after_recovery(self):
        raise NotImplementedError

    def _order_latency(self, stage, event, stamp=None, **fields):
        """Hook for per-order latency traces; none by default."""

    # ----- public inputs ------------------------------------------------------

    def on_start(self):
        self.subscribe_quotes(self.spec.paper_id)
        self.subscribe_book_deltas(self.spec.paper_id, BookType.L2_MBP, managed=True)

    def _guard(self, label, action, *, allow_during_stop=False):
        if self.controller.stopping and not allow_during_stop:
            return
        try:
            action()
        except Exception as exc:
            self.controller.fail(f"{self.spec.display} {label}: {type(exc).__name__}: {exc}", self.spec.key)

    def fresh(self, at_ms=None):
        return not self.input_diagnostics(at_ms)[0]

    def input_diagnostics(self, at_ms=None):
        """Current-input rule for change-only public streams.

        Venues publish a market only when it changes, so a silent market is
        not stale by itself. A track is current when it has a quote and book
        accepted after the latest reconnect floor, its venue socket delivered a
        recent message (any selected market, delivery <= 1 s, source time <=
        maxVenueSourceAgeMs) and the track itself was heard from within
        maxTrackQuietMs. Messages on one socket are processed in arrival order,
        so a newer message for another market proves this market's last state
        was not overtaken by a queued update.
        """
        at_ms = now_ms() if at_ms is None else at_ms
        reasons, ages = [], {}
        if self.spec.key in self.controller.book_sync_required:
            reasons.append("book_sync_required")
        for kind in ("quote", "book"):
            delivered = getattr(self, f"last_{kind}_ms")
            source = getattr(self, f"last_{kind}_event_ms")
            ages[f"{kind}DeliveryMs"] = at_ms - delivered if delivered else None
            ages[f"{kind}SourceMs"] = at_ms - source if source else None
            if not delivered:
                reasons.append(f"{kind}_missing")
        stream = self.controller.venue_stream[self.spec.venue_key]
        venue_delivery = at_ms - stream["delivery_ms"] if stream["delivery_ms"] else None
        venue_source = at_ms - stream["source_ns"] // 1_000_000 if stream["source_ns"] else None
        ages["venueDeliveryMs"], ages["venueSourceMs"] = venue_delivery, venue_source
        if venue_delivery is None:
            reasons.append("venue_missing")
        else:
            if venue_delivery < 0:
                reasons.append("venue_delivery_future")
            elif venue_delivery > self.run_config["maxQuoteAgeMs"]:
                reasons.append("venue_delivery_stale")
            if venue_source < 0:
                reasons.append("venue_source_future")
            elif venue_source > self.run_config["maxVenueSourceAgeMs"]:
                reasons.append("venue_source_stale")
        heard = max(self.last_quote_ms, self.last_book_ms)
        if heard and at_ms - heard > self.run_config["maxTrackQuietMs"]:
            reasons.append("track_quiet")
        return reasons, ages

    def skip(self, scope, reasons, event=None):
        _, ages = self.input_diagnostics()
        if event is not None:
            at_ms = now_ms()
            ages.update(eventSourceMs=at_ms - event.ts_event // 1_000_000,
                        eventInitMs=at_ms - event.ts_init // 1_000_000)
        self.controller.diagnostics[self.spec.key].skip(scope, reasons, ages)

    def _market_callback(self, action):
        # Let _guard preserve a trading error before collecting diagnostics.
        action()
        self.observe_diagnostics()

    def _instrument(self):
        instrument = self.cache.instrument(self.spec.paper_id)
        if instrument is None:
            raise ValueError("Paper instrument not loaded")
        return instrument

    def _book(self):
        book = self.cache.order_book(self.spec.paper_id)
        if book is None:
            raise ValueError("Paper book unavailable")
        return book

    def on_quote(self, quote):
        self._guard("quote", lambda: self._market_callback(lambda: self._on_quote(quote)))

    def _accept_quote(self, quote, timing, at_ms):
        self.last_quote = quote
        self.quote_timing = timing
        self.last_quote_ms = at_ms
        self.last_quote_event_ns = quote.ts_event
        self.last_quote_event_ms = quote.ts_event // 1_000_000

    def _on_quote(self, quote):
        timing = InputTiming.capture(quote)
        at_ms = now_ms()
        source_floor_ns = self.input_floor_ns - SOURCE_CLOCK_SKEW_NS
        if (quote.ts_event < self.last_bbo_event_ns or quote.ts_event < self.position_source_floor_ns
                or quote.ts_event < source_floor_ns or quote.ts_init < self.input_floor_ns):
            self.stale_skipped += 1
            self.skip("quote", [reason for reason, blocked in (
                ("source_out_of_order", quote.ts_event < self.last_bbo_event_ns),
                ("source_before_position", quote.ts_event < self.position_source_floor_ns),
                ("source_before_reconnect", quote.ts_event < source_floor_ns),
                ("initialized_before_reconnect", quote.ts_init < self.input_floor_ns)) if blocked], quote)
            return
        self.last_bbo_event_ns = quote.ts_event
        self.controller.note_venue_input(self.spec.venue_key, quote.ts_event, at_ms)
        if quote.ts_event < self.last_quote_event_ns:
            # A newer book top already defines the price. The BBO message still
            # proves the track and socket are alive, but never moves time back.
            self.skip("quote", ["superseded_by_book"], quote)
            self._after_input("quote", at_ms, False)
            return
        self._accept_quote(quote, timing, at_ms)
        self._after_input("quote", at_ms, True)

    def _quote_from_book(self, batch, timing, at_ms):
        """Use a strictly newer book top as the effective quote.

        Hyperliquid BBO and l2Book are separate channels; quiet markets may
        not send a BBO for seconds while periodic books keep confirming it.
        After a reconnect the complete snapshot also provides the first quote.
        """
        if batch.ts_event <= self.last_quote_event_ns or batch.ts_event < self.position_source_floor_ns:
            return False
        book = self._book()
        bid, ask = book.best_bid_price(), book.best_ask_price()
        bid_size, ask_size = book.best_bid_size(), book.best_ask_size()
        if bid is None or ask is None or bid_size is None or ask_size is None:
            return False
        if Decimal(str(bid)) >= Decimal(str(ask)) or Decimal(str(bid_size)) <= 0 or Decimal(str(ask_size)) <= 0:
            return False
        quote = QuoteTick(self.spec.paper_id, bid, ask, bid_size, ask_size, batch.ts_event, batch.ts_init)
        self._accept_quote(quote, timing, at_ms)
        return True

    def _after_input(self, scope, at_ms, quote_changed):
        if self.controller.track_recovering(self.spec.key):
            self.skip(scope, ["recovery"])
            self.controller.observe_recovery_inputs()
            return
        reasons = self.input_diagnostics(at_ms)[0]
        if reasons:
            self.stale_skipped += 1
            self.skip(scope, reasons)
            return
        if quote_changed:
            self._decide(self.last_quote, at_ms)
        self._try_orders(at_ms)

    def _alert(self, kind, due_ms):
        """Evaluate a pending order exactly at its modeled arrival time."""
        self.timer_seq += 1
        name = f"psr-{kind}-{self.spec.key}-{self.timer_seq}"
        self.clock.set_time_alert_ns(name, due_ms * 1_000_000, callback=self._on_alert, allow_past=True)

    def _on_alert(self, _event):
        self._guard("arrival timer", lambda: self._market_callback(lambda: self._on_due()))

    def on_book_deltas(self, batch):
        self._guard("book", lambda: self._market_callback(lambda: self._on_book(batch)))

    def _on_book(self, batch):
        timing = InputTiming.capture(batch)
        source_floor_ns = self.input_floor_ns - SOURCE_CLOCK_SKEW_NS
        if (batch.ts_event < self.last_book_event_ns or batch.ts_event < source_floor_ns
                or batch.ts_init < self.input_floor_ns):
            self.stale_skipped += 1
            self.skip("book", [reason for reason, blocked in (
                ("source_out_of_order", batch.ts_event < self.last_book_event_ns),
                ("source_before_reconnect", batch.ts_event < source_floor_ns),
                ("initialized_before_reconnect", batch.ts_init < self.input_floor_ns)) if blocked], batch)
            return
        fingerprint = tuple((str(delta.action), str(delta.order), delta.flags, delta.sequence)
                            for delta in batch.deltas)
        key = (batch.ts_event, batch.sequence, fingerprint)
        if key == self.last_book_key:
            self.skip("book", ["duplicate_book"])
            return
        self.last_book_key = key
        self.book_timing = timing
        self.book_revision += 1
        at_ms = now_ms()
        self.last_book_ms = at_ms
        self.last_book_event_ns = batch.ts_event
        self.last_book_event_ms = batch.ts_event // 1_000_000
        self.controller.note_venue_input(self.spec.venue_key, batch.ts_event, at_ms)
        if (complete_book(batch) and self.spec.key in self.controller.book_sync_required
                and self.controller.book_sync_required[self.spec.key] == (batch.ts_event, batch.ts_init, batch.sequence)):
            del self.controller.book_sync_required[self.spec.key]
            self.controller.book_sync_diagnostic("book_projection_restored", self.spec.key,
                sequence=batch.sequence, sourceNs=batch.ts_event, initNs=batch.ts_init)
        quote_changed = (self.spec.key not in self.controller.book_sync_required
                         and self._quote_from_book(batch, timing, at_ms))
        self._after_input("book", at_ms, quote_changed)

    def _visible_depth(self, side, limit_price=None):
        book = self._book()
        levels = book.asks(depth=20) if side == OrderSide.BUY else book.bids(depth=20)
        total = Decimal("0")
        for level in levels:
            price = Decimal(str(level.price))
            if limit_price is not None:
                if side == OrderSide.BUY and price > limit_price:
                    break
                if side == OrderSide.SELL and price < limit_price:
                    break
            total += sum((Decimal(str(order.size)) for order in level.get_orders()), Decimal("0"))
        return total

    def on_order_submitted(self, event):
        self._guard("order submitted", lambda: self._order_transition("submitted", event), allow_during_stop=True)

    def on_order_accepted(self, event):
        self._guard("order accepted", lambda: self._order_transition("accepted", event), allow_during_stop=True)

    def _order_transition(self, name, event):
        self._order_latency(name, event)
        self.broker_revision += 1
        self.controller.event(self.spec.key, f"Paper order {event.client_order_id} {name}")

    def on_order_filled(self, event):
        self._guard("order fill", lambda: self._on_fill(event), allow_during_stop=True)

    def on_order_canceled(self, event):
        self._guard("order canceled", lambda: self._on_canceled(event), allow_during_stop=True)

    def on_order_rejected(self, event):
        self._guard("order rejected latency", lambda: self._order_latency("rejected", event), allow_during_stop=True)
        self.controller.fail(f"{self.spec.display} order rejected {event.client_order_id}: {event.reason}", self.spec.key)

    def on_order_denied(self, event):
        self._guard("order denied latency", lambda: self._order_latency("denied", event), allow_during_stop=True)
        self.controller.fail(f"{self.spec.display} order denied {event.client_order_id}: {event.reason}", self.spec.key)

    def on_order_cancel_rejected(self, event):
        self.controller.fail(f"{self.spec.display} order cancel rejected {event.client_order_id}: {event.reason}", self.spec.key)

    def invalidate_inputs(self, floor_ns):
        self.input_floor_ns = max(self.input_floor_ns, floor_ns)
        self.last_quote_ms = self.last_book_ms = 0
        self.last_quote = None
        self.quote_timing = self.book_timing = None
        self.last_book_key = None

    def account_snapshot(self):
        account = self.cache.account_for_venue(self.spec.paper_venue)
        balance = account.balance(USDC) if account else None
        positions = []
        quote = self.last_quote
        mark = ((Decimal(str(quote.bid_price)) + Decimal(str(quote.ask_price))) / 2) if quote is not None else None
        for position in self.cache.positions_open(instrument_id=self.spec.paper_id):
            side = "long" if str(position.side).upper().endswith("LONG") else "short"
            quantity = Decimal(str(position.quantity))
            row = {"market": self.spec.market, "side": side, "remainingBaseQuantity": decimal_string(quantity)}
            # Display-only facts for the positions table (absent in older snapshots).
            average = Decimal(str(position.avg_px_open))
            if average > 0:
                row["avgEntryPrice"] = decimal_string(average.quantize(Decimal("1e-12")).normalize())
                if mark is not None and mark > 0:
                    sign = Decimal(1) if side == "long" else Decimal(-1)
                    row["markPrice"] = decimal_string(mark.normalize())
                    row["unrealizedPnl"] = decimal_string(((mark - average) * quantity * sign).quantize(Decimal("1e-8")))
            if position.ts_opened:
                row["openedAt"] = datetime.fromtimestamp(position.ts_opened / 1e9, timezone.utc) \
                    .isoformat(timespec="milliseconds").replace("+00:00", "Z")
            positions.append(row)
        return {
            "venue": self.spec.display,
            "cashBalance": decimal_string(balance.total.as_decimal()) if balance else self.run_config["capitalPerVenue"],
            "brokerRevision": self.broker_revision,
            "publicFrames": self.controller.public_frames[self.spec.key],
            "pendingOrders": len(self.pending_order_ids),
            "signals": self.signals, "intents": self.intents, "fills": self.fills,
            "rejectedSignals": self.rejected_signals,
            "priceReady": bool(self.fresh()) and not self.controller.stopping and not self.controller.track_recovering(self.spec.key),
            "stalePriceObservationsSkipped": self.stale_skipped,
            "positions": positions,
        }
