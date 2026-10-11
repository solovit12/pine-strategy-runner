"""Pure real-time Pine order rules; no Nautilus or network."""

from decimal import Decimal
import unittest

from pine_orders import ARRIVAL_MS, TRIGGER_DELAY_MS, PineOrderManager

T0 = 1_791_000_000_000
H = 3_600_000


def order(**fields):
    base = {"category": "entry", "type": "market", "side": "long", "tradeKeys": [], "qtyCap": None}
    base.update(fields)
    return base


def entry(oid="L", side="long", kind="market", plan_side="long", closes=(), **extra):
    return order(id=oid, side=side, type=kind, plan={
        "accepted": True, "closes": [{"tradeKey": k, "qty": q} for k, q in closes],
        "opensSide": plan_side, "opensQty": 10}, **extra)


def bracket(oid="XL", from_entry="L", trade_keys=(), **legs):
    return order(id=oid, category="exit", side=None, fromEntry=from_entry, tradeKeys=list(trade_keys), **legs)


class PineOrdersTest(unittest.TestCase):
    def setUp(self):
        self.logs = []
        self.m = PineOrderManager("lighter:BTC", "0.01", self.logs.append)

    def send(self, orders, trades=(), at=T0, bar=T0, through=None):
        self.m.apply_set({"barCloseMs": bar, "fillsThrough": self.m.report_seq if through is None else through,
                          "orders": list(orders), "trades": list(trades)}, at)

    def fill_entry(self, request, qty, price, at):
        self.m.exec_result(request.id, filled=qty, average=price, opened=max(Decimal(0), Decimal(qty) - request.close_qty),
                           now_ms=at)

    def test_market_entry_executes_at_arrival_and_reports_real_price(self):
        self.send([entry()])
        self.m.on_quote("99.9", "100.1", T0 + ARRIVAL_MS - 1)
        self.assertEqual(self.m.take_requests(), [])
        self.m.on_quote("99.9", "100.1", T0 + ARRIVAL_MS)
        [request] = self.m.take_requests()
        self.assertEqual((request.side, request.open_side, request.close_qty, request.limit), ("buy", "long", 0, None))
        self.fill_entry(request, "2", "100.12", T0 + 260)
        [report] = self.m.take_reports()
        self.assertEqual((report["orderId"], report["price"], report["time"]), ("L", "100.12", T0 + 260))
        trade = self.m.trades[f"L@{T0 + 260}"]
        self.assertEqual((trade.side, trade.real_qty), ("long", Decimal("2")))
        self.assertEqual(self.m.real_position(), Decimal("2"))

    def test_oto_bracket_from_real_entry_price_take_profit_and_stop(self):
        self.send([entry(), bracket(profitTicks=100, lossTicks=50)])
        self.m.on_quote("99.9", "100", T0 + 300)
        [request] = self.m.take_requests()
        self.fill_entry(request, "2", "100", T0 + 310)
        self.m.take_reports()
        key = f"L@{T0 + 310}"
        self.m.on_quote("100.99", "101.1", T0 + 400)
        self.assertEqual(self.m.take_requests(), [])  # TP 101.00 not touched yet
        self.m.on_quote("101.00", "101.1", T0 + 500)
        [tp] = self.m.take_requests()
        self.assertEqual((tp.side, tp.limit, tp.close_qty, tp.reduce_only), ("sell", Decimal("101.00"), Decimal("2"), True))
        self.m.exec_result(tp.id, filled="2", average="101.00", opened="0", now_ms=T0 + 501)
        [report] = self.m.take_reports()
        self.assertEqual((report["orderId"], report["leg"], report["tradeKey"], report["qty"]), ("XL", "profit", key, "10"))
        self.assertEqual(self.m.real_position(), Decimal("0"))

    def test_stop_loss_waits_trigger_delay_then_market(self):
        self.send([entry(), bracket(profitTicks=100, lossTicks=50)])
        self.m.on_quote("99.9", "100", T0 + 300)
        [request] = self.m.take_requests()
        self.fill_entry(request, "2", "100", T0 + 310)
        self.m.take_reports()
        self.m.on_quote("99.50", "99.6", T0 + 1000)
        self.assertEqual(self.m.take_requests(), [])
        self.assertEqual(self.m.next_wakeup_ms(T0 + 1000), T0 + 1000 + TRIGGER_DELAY_MS)
        # Live, untriggered legs never ask for a timer (no immediate-timer loop).
        self.assertIsNone(self.m.next_wakeup_ms(T0 + 1000 + TRIGGER_DELAY_MS))
        self.m.evaluate(T0 + 1000 + TRIGGER_DELAY_MS)
        [sl] = self.m.take_requests()
        self.assertEqual((sl.side, sl.limit, sl.close_qty), ("sell", None, Decimal("2")))
        # Partial IOC: half fills, the rest retries.
        self.m.exec_result(sl.id, filled="1", average="99.4", opened="0", now_ms=T0 + 1310)
        [report] = self.m.take_reports()
        self.assertEqual((report["leg"], report["qty"]), ("loss", "5"))
        self.m.on_quote("99.3", "99.4", T0 + 1400)
        [rest] = self.m.take_requests()
        self.assertEqual(rest.close_qty, Decimal("1"))

    def test_shadow_trade_from_history_reports_without_sandbox_order(self):
        trades = [{"key": "S@1", "entryId": "S", "side": "short", "qty": 4, "entryPrice": 100,
                   "bracketEntryPrice": 100, "entryTime": 1}]
        self.send([bracket("XS", "S", ["S@1"], lossTicks=100)], trades)
        self.m.on_quote("100.9", "101.0", T0 + 300)
        self.m.evaluate(T0 + 300 + TRIGGER_DELAY_MS)
        self.assertEqual(self.m.take_requests(), [])
        [report] = self.m.take_reports()
        self.assertEqual((report["orderId"], report["tradeKey"], report["qty"], report["price"]), ("XS", "S@1", "4", "101"))

    def test_entries_wait_for_the_order_set_of_the_latest_bar_exits_do_not(self):
        trades = [{"key": "S@1", "entryId": "S", "side": "short", "qty": 4, "entryPrice": 100,
                   "bracketEntryPrice": 100, "entryTime": 1}]
        self.send([entry("L2"), bracket("XS", "S", ["S@1"], lossTicks=100)], trades, bar=T0)
        self.m.boundary(T0 + H)
        self.m.on_quote("101.0", "101.1", T0 + 400)
        self.m.evaluate(T0 + 800)
        self.assertEqual(self.m.take_requests(), [])  # entry gated
        self.assertEqual(len(self.m.take_reports()), 1)  # shadow stop still executed
        self.send([entry("L2")], [], at=T0 + 900, bar=T0 + H)
        self.m.on_quote("101.0", "101.1", T0 + 900 + ARRIVAL_MS)
        self.assertEqual(len(self.m.take_requests()), 1)

    def test_limit_entry_touch_without_fill_keeps_resting(self):
        self.send([entry(kind="limit", limit=99)])
        self.m.on_quote("99.5", "99.6", T0 + 300)
        self.assertEqual(self.m.take_requests(), [])
        self.m.on_quote("98.9", "99.0", T0 + 400)
        [request] = self.m.take_requests()
        self.assertEqual(request.limit, Decimal("99"))
        self.m.exec_result(request.id, filled="0", average="0", opened="0", now_ms=T0 + 401, reason="no_liquidity")
        self.assertEqual(self.m.take_reports(), [])
        self.m.on_quote("98.9", "99.0", T0 + 500)
        self.assertEqual(len(self.m.take_requests()), 1)

    def test_reversal_closes_mirrored_trade_and_opens_new(self):
        self.send([entry()])
        self.m.on_quote("99.9", "100", T0 + 300)
        [request] = self.m.take_requests()
        self.fill_entry(request, "2", "100", T0 + 310)
        key = f"L@{T0 + 310}"
        trades = [{"key": key, "entryId": "L", "side": "long", "qty": 10, "entryPrice": 100,
                   "bracketEntryPrice": 100, "entryTime": T0 + 310}]
        self.send([entry("S", "short", plan_side="short", closes=[(key, 10)])], trades, at=T0 + H, bar=T0 + H)
        self.m.on_quote("99", "99.1", T0 + H + ARRIVAL_MS)
        [rev] = self.m.take_requests()
        self.assertEqual((rev.side, rev.close_qty, rev.open_side, rev.reduce_only), ("sell", Decimal("2"), "short", False))
        self.m.exec_result(rev.id, filled="5", average="99", opened="3", now_ms=T0 + H + 210)
        self.assertEqual(self.m.real_position(), Decimal("-3"))

    def test_pine_closed_mirrored_trade_is_flattened(self):
        self.send([entry()])
        self.m.on_quote("99.9", "100", T0 + 300)
        [request] = self.m.take_requests()
        self.fill_entry(request, "2", "100", T0 + 310)
        self.send([], [], at=T0 + H, bar=T0 + H)
        self.m.on_quote("99.9", "100", T0 + H + 10)
        [flat] = self.m.take_requests()
        self.assertEqual((flat.side, flat.close_qty, flat.reduce_only), ("sell", Decimal("2"), True))
        self.m.exec_result(flat.id, filled="2", average="99.9", opened="0", now_ms=T0 + H + 20)
        self.assertEqual(self.m.real_position(), Decimal("0"))

    def test_trailing_stop_arms_and_follows_best_price(self):
        self.send([entry(), bracket(trailPointsTicks=100, trailOffsetTicks=50)])
        self.m.on_quote("99.9", "100", T0 + 300)
        [request] = self.m.take_requests()
        self.fill_entry(request, "1", "100", T0 + 310)
        self.m.on_quote("101.00", "101.1", T0 + 400)  # armed at 101.00
        self.m.on_quote("102.00", "102.1", T0 + 500)  # best 102 -> stop 101.50
        self.m.on_quote("101.60", "101.7", T0 + 600)
        self.assertEqual(self.m.take_requests(), [])
        self.m.on_quote("101.50", "101.6", T0 + 700)
        self.m.evaluate(T0 + 700 + TRIGGER_DELAY_MS)
        [trail] = self.m.take_requests()
        self.assertEqual(trail.side, "sell")


if __name__ == "__main__":
    unittest.main()
