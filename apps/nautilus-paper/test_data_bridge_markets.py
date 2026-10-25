"""Offline checks for market identity, instrument rules and per-venue routing."""

from decimal import Decimal
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import data_bridge as bridge
from nautilus_trader.model import (
    BookAction, BookOrder, BookType, CryptoPerpetual, Currency, Money, OrderBook, OrderBookDelta,
    OrderBookDeltas, OrderSide, Price, Quantity, QuoteTick, RecordFlag, Symbol,
)


def source_instrument(spec, **overrides):
    # Deliberately different per-market rules, including integer quantities.
    size_dp = {"HYPE": 2, "SOL": 3, "XRP": 0, "SUI": 1, "DOGE": 0}[spec.market]
    price_dp = {"HYPE": 4, "SOL": 3, "XRP": 6, "SUI": 5, "DOGE": 6}[spec.market]
    minimum = {"HYPE": "0.07", "SOL": "0.055", "XRP": "4", "SUI": "7.5", "DOGE": "65"}[spec.market]
    quote = bridge.USDC if spec.venue_key == "lighter" else bridge.USD
    args = dict(instrument_id=spec.source_id, raw_symbol=Symbol(spec.market),
        base_currency=Currency.from_str(spec.market), quote_currency=quote,
        settlement_currency=bridge.USDC, is_inverse=False,
        price_precision=price_dp, size_precision=size_dp,
        price_increment=Price.from_str(f"{Decimal(1).scaleb(-price_dp):.{price_dp}f}"),
        size_increment=Quantity.from_str(f"{Decimal(1).scaleb(-size_dp):.{size_dp}f}"),
        min_quantity=Quantity.from_str(minimum), min_notional=Money(10, quote),
        ts_event=100, ts_init=200)
    args.update(overrides)
    return CryptoPerpetual(**args)


class MarketBridgeTests(unittest.TestCase):
    def setUp(self):
        self.specs = bridge.make_specs([
            {"venue": venue, "market": market}
            for venue in bridge.VENUE_KEYS for market in bridge.PAPER_MARKETS
        ])

    def test_ids_and_tags_are_unique_and_hype_stays_compatible(self):
        self.assertEqual(bridge.make_specs(None), bridge.SPECS)
        self.assertEqual(bridge.make_specs(), bridge.SPECS)
        self.assertEqual(len(self.specs), 10)
        self.assertEqual(len({spec.strategy_tag for spec in self.specs.values()}), 10)
        for venue, legacy in bridge.SPECS.items():
            self.assertEqual(self.specs[venue], legacy)
        for spec in self.specs.values():
            suffix = "-PERP.LIGHTER" if spec.venue_key == "lighter" else "-USD-PERP.HYPERLIQUID"
            self.assertEqual(str(spec.source_id), spec.market + suffix)
        asymmetric = bridge.make_specs([{"venue": "lighter", "market": "SOL"},
            {"venue": "lighter", "market": "DOGE"}, {"venue": "hyperliquid", "market": "HYPE"}])
        self.assertEqual(set(asymmetric), {"lighter:SOL", "lighter:DOGE", "hyperliquid"})
        for tracks in ([], [{"venue": "lighter", "market": "BTC"}],
                       [{"venue": "Lighter", "market": "HYPE"}],
                       [{"venue": "lighter", "market": "SOL"}],
                       [{"venue": "lighter", "market": "SOL"}] * 2):
            with self.assertRaises(ValueError):
                bridge.make_specs(tracks)

    def test_hyperliquid_hip3_markets_keep_their_prefix_and_lighter_rejects_it(self):
        specs = bridge.make_specs([{"venue": "hyperliquid", "market": "xyz:NVDA"}], require_both=False)
        spec = specs["hyperliquid:xyz:NVDA"]
        self.assertEqual(str(spec.source_id), "xyz:NVDA-USD-PERP.HYPERLIQUID")
        self.assertEqual(str(spec.paper_id), "xyz:NVDA-USD-PERP.PAPER_HL")
        self.assertEqual(spec.venue_key, "hyperliquid")
        for venue, market in (("lighter", "xyz:NVDA"), ("hyperliquid", "XYZ:NVDA"), ("hyperliquid", "xyz:")):
            with self.assertRaises(ValueError):
                bridge.track_key(venue, market)

    def test_repair_preserves_entire_book_and_observation_identity(self):
        from nautilus_trader.model import OrderBook
        spec = self.specs["lighter:SUI"]
        book = OrderBook(spec.source_id, bridge.BookType.L2_MBP)
        changes = [OrderBookDelta.clear(spec.source_id, 72, 200, 250)]
        for side, start in ((OrderSide.BUY, 90), (OrderSide.SELL, 110)):
            for i in range(12):
                changes.append(OrderBookDelta(spec.source_id, BookAction.ADD,
                    BookOrder(side, Price.from_str(str(start + i)), Quantity.from_str("12.345"), 0),
                    int(RecordFlag.F_LAST) if side == OrderSide.SELL and i == 11 else 0, 72, 200, 250))
        batch = OrderBookDeltas(spec.source_id, changes)
        book.apply_deltas(batch)
        repaired = bridge.snapshot_from_cache(book, batch)
        self.assertTrue(bridge.complete_book(repaired))
        self.assertEqual((repaired.ts_event, repaired.ts_init, repaired.sequence), (200, 250, 72))
        self.assertEqual(len(repaired.deltas), 25)  # full depth, not the diagnostic top five
        copy = OrderBook(spec.source_id, bridge.BookType.L2_MBP)
        copy.apply_deltas(repaired)
        self.assertEqual(copy.bids_to_dict(), book.bids_to_dict())
        self.assertEqual(copy.asks_to_dict(), book.asks_to_dict())
        self.assertEqual(book.update_count, 25)  # repair only reads the source

    def test_repair_rejects_unknown_or_mismatched_source_view(self):
        from nautilus_trader.model import OrderBook
        spec = self.specs["lighter:SUI"]
        batch = OrderBookDeltas(spec.source_id, [OrderBookDelta.clear(spec.source_id, 72, 200, 250)])
        book = OrderBook(spec.source_id, bridge.BookType.L2_MBP)
        for invalid in (None, book):
            with self.assertRaisesRegex(ValueError, "does not match"):
                bridge.snapshot_from_cache(invalid, batch)
        book.apply_deltas(batch)
        with self.assertRaisesRegex(ValueError, "two-sided"):
            bridge.snapshot_from_cache(book, batch)
        for bid, ask in (("100", "100"), ("101", "100")):
            bad = OrderBook(spec.source_id, bridge.BookType.L2_MBP)
            bad.add(BookOrder(OrderSide.BUY, Price.from_str(bid), Quantity.from_str("1"), 0), 0, 72, 200)
            bad.add(BookOrder(OrderSide.SELL, Price.from_str(ask), Quantity.from_str("1"), 0), 0, 72, 200)
            with self.assertRaisesRegex((ValueError, RuntimeError), "two-sided|orders in cross"):
                bridge.snapshot_from_cache(bad, batch)

    def test_normalizer_preserves_each_market_rules_on_both_venues(self):
        for spec in self.specs.values():
            with self.subTest(track=spec.key):
                source = source_instrument(spec)
                paper = bridge.normalize_instrument(source, spec)
                self.assertEqual(paper.id, spec.paper_id)
                self.assertEqual(str(paper.base_currency), spec.market)
                self.assertEqual(paper.quote_currency, bridge.USDC)
                self.assertEqual(paper.settlement_currency, bridge.USDC)
                for field in ("price_increment", "size_increment", "price_precision",
                              "size_precision", "min_quantity", "multiplier", "lot_size"):
                    self.assertEqual(getattr(paper, field), getattr(source, field), field)
                self.assertEqual(paper.min_notional.as_decimal(), Decimal("10"))
                self.assertEqual(paper.min_notional.currency, bridge.USDC)
                self.assertEqual(paper.margin_init, Decimal("1"))
                self.assertEqual(paper.margin_maint, Decimal("1"))

    def test_normalizer_rejects_wrong_market_id_base_and_settlement(self):
        spec = self.specs["lighter:SOL"]
        with self.assertRaisesRegex(ValueError, "wrong source instrument"):
            bridge.normalize_instrument(source_instrument(self.specs["lighter:DOGE"]), spec)
        with self.assertRaisesRegex(ValueError, "wrong source instrument"):
            bridge.normalize_instrument(source_instrument(spec, base_currency=bridge.HYPE), spec)
        with self.assertRaisesRegex(ValueError, "USDC settlement"):
            bridge.normalize_instrument(source_instrument(spec, settlement_currency=bridge.USD), spec)
        with self.assertRaisesRegex(ValueError, "linear contract"):
            bridge.normalize_instrument(source_instrument(spec, is_inverse=True), spec)

    def test_one_feed_routes_quotes_books_and_instruments_by_source_id(self):
        for venue in bridge.VENUE_KEYS:
            specs = [spec for spec in self.specs.values() if spec.venue_key == venue]
            data, instruments = [], []
            client = SimpleNamespace(source_specs={spec.source_id: spec for spec in specs},
                _handle_data=data.append, _handle_instrument=instruments.append,
                quote_count=0, book_count=0, instrument_count=0)
            for spec in specs:
                bridge.PaperFeedClient.publish_instrument(client, source_instrument(spec))
                quote = QuoteTick(spec.source_id, Price.from_str("1.00"), Price.from_str("1.01"),
                    Quantity.from_str("100"), Quantity.from_str("101"), 100, 200)
                bridge.PaperFeedClient.publish_quote(client, quote)
                deltas = [OrderBookDelta.clear(spec.source_id, 1, 100, 200),
                    OrderBookDelta(spec.source_id, BookAction.ADD,
                        BookOrder(OrderSide.BUY, Price.from_str("1.00"), Quantity.from_str("100"), 1),
                        int(RecordFlag.F_LAST), 2, 100, 200)]
                bridge.PaperFeedClient.publish_book(client, OrderBookDeltas(spec.source_id, deltas))
                self.assertEqual(data[-2].instrument_id, spec.paper_id)
                self.assertEqual(data[-1].instrument_id, spec.paper_id)
                self.assertTrue(all(delta.instrument_id == spec.paper_id for delta in data[-1].deltas))
                self.assertEqual((data[-1].ts_event, data[-1].ts_init), (100, 200))
            self.assertEqual({instrument.id for instrument in instruments}, {spec.paper_id for spec in specs})
            self.assertEqual((client.instrument_count, client.quote_count, client.book_count), (5, 5, 5))
            foreign = next(spec for spec in self.specs.values() if spec.venue_key != venue)
            with self.assertRaisesRegex(ValueError, "unconfigured Paper source"):
                bridge.PaperFeedClient.publish_instrument(client, source_instrument(foreign))

    def test_book_before_the_paper_book_exists_waits_for_a_snapshot(self):
        # Run e651c787 (2026-10-23): Lighter DOGE's first book came 0.2 s after connect, before the
        # busy node had set up the PAPER_LIGHTER book; the strategy failed on "order book unavailable".
        spec = self.specs["lighter:DOGE"]
        books, published, failures = {}, [], []
        sync = {}
        controller = SimpleNamespace(
            public_frame=lambda *_: None, allow_public_frame=lambda *_: True,
            stopping=False, recovering=False, live=None, book_sync_required=sync,
            invalidate_book_projection=lambda key: sync.__setitem__(key, None),
            fail=lambda message, key: failures.append(message))
        bridge_self = SimpleNamespace(spec=spec, controller=controller,
            cache=SimpleNamespace(order_book=books.get), _ensure_instrument=lambda: True,
            feeds={"lighter": SimpleNamespace(publish_book=published.append)})
        source = OrderBook(spec.source_id, BookType.L2_MBP)
        books[spec.source_id] = source

        def order(side, price):
            return BookOrder(side, Price.from_str(price), Quantity.from_str("100"), 0)

        snapshot = OrderBookDeltas(spec.source_id, [OrderBookDelta.clear(spec.source_id, 1, 100, 200),
            OrderBookDelta(spec.source_id, BookAction.ADD, order(OrderSide.BUY, "0.100000"),
                int(RecordFlag.F_SNAPSHOT), 1, 100, 200),
            OrderBookDelta(spec.source_id, BookAction.ADD, order(OrderSide.SELL, "0.100100"),
                int(RecordFlag.F_SNAPSHOT) | int(RecordFlag.F_LAST), 1, 100, 200)])
        source.apply_deltas(snapshot)
        bridge.PublicBridge.on_book_deltas(bridge_self, snapshot)
        self.assertEqual((published, failures, sync), ([], [], {spec.key: None}))

        books[spec.paper_id] = OrderBook(spec.paper_id, BookType.L2_MBP)
        update = OrderBookDeltas(spec.source_id, [OrderBookDelta(spec.source_id, BookAction.UPDATE,
            order(OrderSide.BUY, "0.100050"), int(RecordFlag.F_LAST), 2, 300, 400)])
        source.apply_deltas(update)
        bridge.PublicBridge.on_book_deltas(bridge_self, update)
        self.assertEqual(failures, [])
        self.assertEqual(len(published), 1)
        self.assertTrue(bridge.complete_book(published[0]))
        self.assertEqual(sync, {spec.key: (300, 400, 2)})

    def test_factories_keep_one_client_per_venue_and_register_all_offline_tracks(self):
        for venue in bridge.VENUE_KEYS:
            specs = [spec for spec in self.specs.values() if spec.venue_key == venue]
            registry, sentinel = {}, object()
            with patch.object(bridge, "OfflineSourceClient", return_value=sentinel) as create:
                result = bridge.OfflineSourceFactory(specs, registry).create(
                    name=venue, config=None, cache=None, clock=None)
                create.assert_called_once()
                self.assertIs(result, sentinel)
                self.assertEqual(set(registry), {spec.key for spec in specs})
                self.assertTrue(all(value is sentinel for value in registry.values()))
            registry = {}
            with patch.object(bridge, "PaperFeedClient", return_value=sentinel) as create:
                bridge.PaperFeedFactory(specs, registry).create(name=venue, config=None, cache=None, clock=None)
                create.assert_called_once()
                self.assertEqual(registry, {venue: sentinel})
        with self.assertRaisesRegex(ValueError, "mix venues"):
            bridge.PaperFeedFactory(list(self.specs.values()), {})

    def test_offline_frames_select_market_without_an_extra_client(self):
        specs = [spec for spec in self.specs.values() if spec.venue_key == "lighter"]
        data = []
        client = SimpleNamespace(market_specs={spec.market: spec for spec in specs},
            sequence=0, _handle_data=data.append)
        for spec in specs:
            bridge.OfflineSourceClient.publish_frame(client, [["100", "1"]], [["101", "2"]], market=spec.market)
            self.assertEqual([item.instrument_id for item in data[-2:]], [spec.source_id] * 2)
        bridge.OfflineSourceClient.publish_frame(client, [["100", "1"]], [["101", "2"]])
        self.assertEqual(data[-1].instrument_id, bridge.SPECS["lighter"].source_id)
        with self.assertRaisesRegex(ValueError, "unconfigured offline market"):
            bridge.OfflineSourceClient.publish_frame(client, [["100", "1"]], [["101", "2"]], market="BTC")


if __name__ == "__main__":
    unittest.main()
