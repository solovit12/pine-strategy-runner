"""Public venue data -> distinct USDC-only Paper instruments.

Only the official Lighter/Hyperliquid public DataClients may publish source
instruments. These Python clients own the separate PAPER_* IDs, so an upstream
instrument refresh cannot overwrite virtual account economics. All execution
clients are Nautilus SandboxExecutionClient instances in runtime.py.
"""

from dataclasses import dataclass, field
from decimal import Decimal
import re
import time

from book_diagnostics import batch_state

from nautilus_trader.config import StrategyConfig
from nautilus_trader.live.clients import DataClient, DataClientFactory
from nautilus_trader.model import (
    BookAction, BookOrder, BookType, CryptoPerpetual, Currency, InstrumentId,
    Money, OrderBookDelta, OrderBookDeltas, OrderSide, Price, Quantity,
    QuoteTick, RecordFlag, StrategyId, Symbol, Venue,
)
from nautilus_trader.trading import Strategy


USDC = Currency.from_str("USDC")
USD = Currency.from_str("USD")
HYPE = Currency.from_str("HYPE")
PAPER_MARKETS = ("HYPE", "SOL", "XRP", "SUI", "DOGE")
VENUE_KEYS = ("lighter", "hyperliquid")
# Any USDC perpetual base symbol (Hyperliquid uses e.g. kPEPE).
MARKET_RE = re.compile(r"^[A-Za-z0-9]{1,20}$")
# Hyperliquid HIP-3 markets carry their deployer prefix, e.g. xyz:NVDA.
HIP3_MARKET_RE = re.compile(r"^[a-z][a-z0-9]{0,7}:[A-Za-z0-9]{1,20}$")


def track_key(venue, market="HYPE"):
    valid = isinstance(market, str) and (MARKET_RE.fullmatch(market)
        or venue == "hyperliquid" and HIP3_MARKET_RE.fullmatch(market))
    if venue not in VENUE_KEYS or not valid:
        raise ValueError("unsupported Paper venue or market")
    return venue if market == "HYPE" else f"{venue}:{market}"


@dataclass(frozen=True)
class VenueSpec:
    key: str
    display: str
    source_id: InstrumentId
    paper_id: InstrumentId
    source_venue: Venue
    paper_venue: Venue
    market: str = "HYPE"
    ordinal: int = field(default=0, compare=False)

    @property
    def venue_key(self):
        return self.key.split(":", 1)[0]

    @property
    def strategy_tag(self):
        # Stable across selections; preserve the existing HYPE strategy IDs.
        if self.market in PAPER_MARKETS:
            return str(101 + PAPER_MARKETS.index(self.market) * 2 + VENUE_KEYS.index(self.venue_key))
        return str(1001 + self.ordinal * 2 + VENUE_KEYS.index(self.venue_key))


def make_specs(tracks=None, require_both=True):
    if tracks is None:
        tracks = [{"venue": venue, "market": "HYPE"} for venue in VENUE_KEYS]
    if not isinstance(tracks, list) or not tracks:
        raise ValueError("Paper tracks must be a nonempty list")
    specs = {}
    for track in tracks:
        if not isinstance(track, dict) or set(track) != {"venue", "market"}:
            raise ValueError("Paper track must contain venue and market")
        venue, market = track["venue"], track["market"]
        key = track_key(venue, market)
        if key in specs:
            raise ValueError(f"duplicate Paper track: {key}")
        lighter = venue == "lighter"
        source_venue = Venue("LIGHTER" if lighter else "HYPERLIQUID")
        paper_venue = Venue("PAPER_LIGHTER" if lighter else "PAPER_HL")
        symbol = f"{market}-PERP" if lighter else f"{market}-USD-PERP"
        specs[key] = VenueSpec(key, "Lighter" if lighter else "Hyperliquid",
            InstrumentId.from_str(f"{symbol}.{source_venue}"),
            InstrumentId.from_str(f"{symbol}.{paper_venue}"), source_venue, paper_venue, market, len(specs))
    if require_both and {spec.venue_key for spec in specs.values()} != set(VENUE_KEYS):
        raise ValueError("Paper tracks must select at least one market on each venue")
    for venue in VENUE_KEYS:
        if sum(1 for spec in specs.values() if spec.venue_key == venue) > 10:
            raise ValueError("Paper allows at most 10 markets per venue")
    return specs


SPECS = make_specs()


def complete_book(batch):
    deltas = batch.deltas
    return bool(deltas and deltas[0].action == BookAction.CLEAR
                and int(deltas[0].flags) & int(RecordFlag.F_SNAPSHOT)
                and int(deltas[-1].flags) & int(RecordFlag.F_LAST))


def snapshot_from_cache(book, batch):
    """Replace a broken projection at a *new eligible* source observation.

    Managed source books have already consumed the complete ordered stream.
    Check callback identity to avoid stamping an earlier/later cache view with
    this batch's time. This is never used to satisfy a socket snapshot gate.
    """
    if (book is None or book.instrument_id != batch.instrument_id
            or book.sequence != batch.sequence or book.ts_last != batch.ts_event):
        raise ValueError("source book does not match the eligible repair batch")
    book.check_integrity()
    bids, asks = book.bids(), book.asks()
    if not bids or not asks or bids[0].price >= asks[0].price:
        raise ValueError("source book is not two-sided and uncrossed for repair")
    ts_event, ts_init, seq = batch.ts_event, batch.ts_init, batch.sequence
    rows = [OrderBookDelta.clear(batch.instrument_id, seq, ts_event, ts_init)]
    for level in [*bids, *asks]:
        for order in level.get_orders():
            rows.append(OrderBookDelta(batch.instrument_id, BookAction.ADD, order,
                int(RecordFlag.F_SNAPSHOT), seq, ts_event, ts_init))
    last = rows[-1]
    rows[-1] = OrderBookDelta(batch.instrument_id, last.action, last.order,
        int(RecordFlag.F_SNAPSHOT) | int(RecordFlag.F_LAST), seq, ts_event, ts_init)
    return OrderBookDeltas(batch.instrument_id, rows)


def _venue_specs(spec):
    specs = (spec,) if isinstance(spec, VenueSpec) else tuple(spec)
    if not specs or any(not isinstance(item, VenueSpec) for item in specs):
        raise ValueError("Paper client needs instrument specs")
    first = specs[0]
    if any((item.venue_key, item.source_venue, item.paper_venue) !=
           (first.venue_key, first.source_venue, first.paper_venue) for item in specs):
        raise ValueError("Paper client cannot mix venues")
    if len({item.source_id for item in specs}) != len(specs) or len({item.market for item in specs}) != len(specs):
        raise ValueError("duplicate Paper client instrument")
    return specs


def _source_spec(specs, source_id):
    try:
        return specs[source_id]
    except KeyError:
        raise ValueError(f"unconfigured Paper source instrument: {source_id}") from None


def normalize_instrument(source, spec: VenueSpec):
    if source.id != spec.source_id or str(source.base_currency) != spec.market:
        raise ValueError(f"{spec.display}: wrong source instrument")
    if str(source.settlement_currency) != "USDC":
        raise ValueError(f"{spec.display}: Paper requires USDC settlement")
    if source.is_inverse or (source.multiplier is not None and Decimal(str(source.multiplier)) != Decimal("1")):
        raise ValueError(f"{spec.display}: Paper requires a linear contract with unit multiplier")
    if spec.venue_key == "lighter" and str(source.quote_currency) != "USDC":
        raise ValueError(f"Lighter {spec.market} quote is not USDC")
    if spec.venue_key == "hyperliquid" and str(source.quote_currency) != "USD":
        raise ValueError(f"Hyperliquid {spec.market} source quote is not USD")
    return CryptoPerpetual(
        instrument_id=spec.paper_id, raw_symbol=source.raw_symbol,
        base_currency=source.base_currency, quote_currency=USDC,
        settlement_currency=USDC, is_inverse=source.is_inverse,
        price_precision=source.price_precision, size_precision=source.size_precision,
        price_increment=source.price_increment, size_increment=source.size_increment,
        ts_event=source.ts_event, ts_init=source.ts_init,
        multiplier=source.multiplier, lot_size=source.lot_size,
        max_quantity=source.max_quantity, min_quantity=source.min_quantity,
        max_notional=source.max_notional,
        min_notional=Money(
            source.min_notional.as_decimal() if source.min_notional else 10, USDC,
        ),
        max_price=source.max_price, min_price=source.min_price,
        # This is a 1x Paper capital-reservation rule, not a liquidation threshold.
        margin_init=Decimal("1"), margin_maint=Decimal("1"),
        tick_scheme=source.tick_scheme, info=source.info,
    )


class PaperFeedClient(DataClient):
    def __init__(self, *, spec, **kwargs):
        specs = _venue_specs(spec)
        super().__init__(venue=specs[0].paper_venue, **kwargs)
        self.specs = specs
        self.spec = specs[0]
        self.source_specs = {item.source_id: item for item in self.specs}
        self.instrument_count = 0
        self.quote_count = 0
        self.book_count = 0

    async def _connect(self):
        pass

    async def _disconnect(self):
        pass

    async def _subscribe_quotes(self, command):
        pass

    async def _subscribe_book_deltas(self, command):
        pass

    def publish_instrument(self, source):
        self._handle_instrument(normalize_instrument(source, _source_spec(self.source_specs, source.id)))
        self.instrument_count += 1

    def publish_quote(self, quote):
        spec = _source_spec(self.source_specs, quote.instrument_id)
        self._handle_data(QuoteTick(
            spec.paper_id, quote.bid_price, quote.ask_price,
            quote.bid_size, quote.ask_size, quote.ts_event, quote.ts_init,
        ))
        self.quote_count += 1

    def publish_book(self, batch):
        spec = _source_spec(self.source_specs, batch.instrument_id)
        if any(delta.instrument_id != spec.source_id for delta in batch.deltas):
            raise ValueError("Paper book batch contains a foreign instrument")
        copied = [OrderBookDelta(
            spec.paper_id, delta.action, delta.order, delta.flags,
            delta.sequence, delta.ts_event, delta.ts_init,
        ) for delta in batch.deltas]
        self._handle_data(OrderBookDeltas(spec.paper_id, copied))
        self.book_count += 1


class PaperFeedFactory(DataClientFactory):
    def __init__(self, spec, registry: dict):
        self.specs = _venue_specs(spec)
        self.spec = self.specs[0]
        self.registry = registry

    def create(self, *, name, config, cache, clock):
        client = PaperFeedClient(spec=self.specs, name=name, config=config, cache=cache, clock=clock)
        self.registry[self.spec.venue_key] = client
        return client


class PublicBridge(Strategy):
    def __init__(self, context):
        spec, feeds, controller = context
        tag = spec.strategy_tag
        super().__init__(StrategyConfig(strategy_id=StrategyId(f"PSR-BRIDGE-{tag}")))
        self.spec = spec
        self.feeds = feeds
        self.controller = controller
        self.published = False
        self.source_signature = None
        if hasattr(controller, "bridges"):
            controller.bridges[spec.key] = self

    def _book_params(self):
        return ({"fast": True} if self.spec.venue_key == "hyperliquid"
                and self.controller.config.get("hyperliquidFastBook", False) else None)

    def on_start(self):
        self.subscribe_quotes(self.spec.source_id)
        self.subscribe_book_deltas(self.spec.source_id, BookType.L2_MBP, managed=True, params=self._book_params())
        self.subscribe_socket_state()

    def resubscribe_book(self):
        """Ask the venue for this market's book again; it answers with a full snapshot."""
        params = self._book_params()
        self.unsubscribe_book_deltas(self.spec.source_id, params=params)
        self.subscribe_book_deltas(self.spec.source_id, BookType.L2_MBP, managed=True, params=params)

    def _ensure_instrument(self):
        source = self.cache.instrument(self.spec.source_id)
        if source is None:
            return False
        signature = (
            str(source.quote_currency), str(source.settlement_currency),
            str(source.price_increment), str(source.size_increment),
            source.price_precision, source.size_precision,
            source.is_inverse, str(source.multiplier), str(source.lot_size),
            str(source.min_quantity), str(source.max_quantity),
            str(source.min_notional), str(source.max_notional),
            str(source.min_price), str(source.max_price),
        )
        if self.source_signature is not None and signature != self.source_signature:
            raise ValueError(f"{self.spec.display} instrument rules changed during Paper run")
        if not self.published:
            self.feeds[self.spec.venue_key].publish_instrument(source)
            self.source_signature = signature
            self.published = True
            self.controller.instrument_ready(self.spec.key)
        return True

    def on_quote(self, quote):
        try:
            self.controller.public_frame(self.spec.key, "quote")
            if not self.controller.allow_public_frame(self.spec.key, "quote", quote.ts_event, quote.ts_init):
                return
            if self._ensure_instrument():
                self.feeds[self.spec.venue_key].publish_quote(quote)
        except Exception as exc:
            self.controller.fail(f"{self.spec.display} quote bridge: {type(exc).__name__}: {exc}", self.spec.key)

    def on_book_deltas(self, batch):
        try:
            self.controller.public_frame(self.spec.key, "book")
            complete = complete_book(batch)
            if not self.controller.allow_public_frame(self.spec.key, "book", batch.ts_event, batch.ts_init, complete):
                if not self.controller.stopping:
                    self.controller.invalidate_book_projection(self.spec.key)
                if self.controller.recovering:
                    # Retain only the first rejected batch per track in this gap.
                    # The source cache has already applied it, unlike PAPER_*.
                    if self.spec.key not in self.controller.recovery_rejected_books:
                        detail = batch_state(batch)
                        detail["sourceFloorNs"] = self.controller.strategies[self.spec.key].input_floor_ns
                        detail["previousAcceptedSourceNs"] = self.controller.accepted_source_ns[(self.spec.key, "book")]
                        self.controller.recovery_rejected_books[self.spec.key] = detail
                        self.controller.recovery_diagnostic("book_discard_detail", track=self.spec.key,
                                                            batch=detail)
                return
            if self._ensure_instrument():
                if self.spec.key in self.controller.book_sync_required:
                    if not complete:
                        batch = snapshot_from_cache(self.cache.order_book(self.spec.source_id), batch)
                    # Remain blocked until this exact replacement reaches the
                    # PAPER strategy, after both its cache and Sandbox update.
                    self.controller.book_sync_required[self.spec.key] = (batch.ts_event, batch.ts_init, batch.sequence)
                self.feeds[self.spec.venue_key].publish_book(batch)
        except Exception as exc:
            self.controller.fail(f"{self.spec.display} book bridge: {type(exc).__name__}: {exc}", self.spec.key)

    def on_socket_state(self, event):
        try:
            self.controller.socket_state(str(event.endpoint), str(event.state))
        except Exception as exc:
            self.controller.fail(f"socket callback: {type(exc).__name__}: {exc}", self.spec.key)


class OfflineSourceClient(DataClient):
    """Synthetic source feed, available only when config.mode == 'offline'."""

    def __init__(self, *, spec, **kwargs):
        specs = _venue_specs(spec)
        super().__init__(venue=specs[0].source_venue, **kwargs)
        self.specs = specs
        self.spec = specs[0]
        self.market_specs = {item.market: item for item in self.specs}
        self.sequence = 0

    async def _connect(self):
        for spec in self.specs:
            self._handle_instrument(self._instrument(spec.market))

    async def _disconnect(self):
        pass

    async def _subscribe_quotes(self, command):
        pass

    async def _subscribe_book_deltas(self, command):
        pass

    def _instrument(self, market="HYPE"):
        spec = self.market_specs[market]
        now = time.time_ns()
        lighter = spec.venue_key == "lighter"
        return CryptoPerpetual(
            instrument_id=spec.source_id, raw_symbol=Symbol(spec.market),
            # Like the live adapter, a HIP-3 market keeps its prefix in the base currency (xyz:NVDA).
            base_currency=Currency.from_str(spec.market), quote_currency=USDC if lighter else USD,
            settlement_currency=USDC, is_inverse=False,
            price_precision=2, size_precision=3,
            price_increment=Price.from_str("0.01"),
            size_increment=Quantity.from_str("0.001"),
            min_quantity=Quantity.from_str("0.001"),
            min_notional=Money(10, USDC if lighter else USD),
            margin_init=Decimal("0.0666") if lighter else Decimal("0"),
            margin_maint=Decimal("0.03") if lighter else Decimal("0"),
            ts_event=now, ts_init=now,
        )

    def publish_frame(self, bids: list[list[str]], asks: list[list[str]], *, part="both", snapshot=True, age_ms=0, market="HYPE",
                      source_lag_ms=0):
        if market not in self.market_specs:
            raise ValueError(f"unconfigured offline market: {market}")
        spec = self.market_specs[market]
        if not bids or not asks:
            raise ValueError("offline frame requires nonempty bids and asks")
        if part not in ("both", "book", "quote") or not isinstance(snapshot, bool):
            raise ValueError("invalid offline frame part/snapshot")
        if not isinstance(age_ms, int) or not 0 <= age_ms <= 3_600_000:
            raise ValueError("offline frame age must be 0..3600000 ms")
        if not isinstance(source_lag_ms, int) or not 0 <= source_lag_ms <= 3_600_000:
            raise ValueError("offline frame source lag must be 0..3600000 ms")
        self.sequence += 1
        received = time.time_ns() - age_ms * 1_000_000
        # The venue's own clock may stamp the data earlier than its arrival.
        ts = received - source_lag_ms * 1_000_000
        seq = self.sequence * 1000
        deltas = [OrderBookDelta.clear(spec.source_id, seq, ts, received)] if snapshot else []
        for side, levels in ((OrderSide.BUY, bids), (OrderSide.SELL, asks)):
            for i, (price, size) in enumerate(levels):
                deltas.append(OrderBookDelta(
                    spec.source_id, BookAction.ADD,
                    BookOrder(side, Price.from_str(str(price)), Quantity.from_str(str(size)), seq + len(deltas) + 1),
                    0, seq + len(deltas) + 1, ts, received,
                ))
        last = deltas[-1]
        deltas[-1] = OrderBookDelta(
            spec.source_id, last.action, last.order,
            (int(RecordFlag.F_SNAPSHOT) if snapshot else 0) | int(RecordFlag.F_LAST),
            last.sequence, ts, received,
        )
        if part in ("both", "book"):
            self._handle_data(OrderBookDeltas(spec.source_id, deltas))
        bid, bid_qty = bids[0]
        ask, ask_qty = asks[0]
        if part in ("both", "quote"):
            self._handle_data(QuoteTick(
                spec.source_id, Price.from_str(str(bid)), Price.from_str(str(ask)),
                Quantity.from_str(str(bid_qty)), Quantity.from_str(str(ask_qty)), ts, received,
            ))


class OfflineSourceFactory(DataClientFactory):
    def __init__(self, spec, registry: dict):
        self.specs = _venue_specs(spec)
        self.spec = self.specs[0]
        self.registry = registry

    def create(self, *, name, config, cache, clock):
        client = OfflineSourceClient(spec=self.specs, name=name, config=config, cache=cache, clock=clock)
        for spec in self.specs:
            self.registry[spec.key] = client
        return client
