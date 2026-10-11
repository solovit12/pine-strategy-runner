"""Generic Pine order execution in real, network-free Nautilus Sandbox.

Prices and instrument steps are synthetic. The checks prove routing of Pine
order sets into IOC orders, Pine fill reports and account arithmetic.
"""

import asyncio
from decimal import Decimal
import json
import os
from pathlib import Path
import sys
import tempfile
import time

from sandbox_harness import SandboxRun

MINUTE = 60_000


def pine_config(folder, label, tracks, market_fees=None):
    return {
        "v": 1, "runId": f"offline-pine-{label}", "parentPid": os.getpid(),
        "strategyVersion": 1, "nativeStrategy": "pine_orders_v1", "sourceSha256": "b" * 64,
        "maxQuoteAgeMs": 1000, "maxBookAgeMs": 1000, "maxVenueSourceAgeMs": 2000, "maxTrackQuietMs": 30000,
        "mode": "offline", "hyperliquidFastBook": False,
        "eventOutboxPath": str(folder / "nautilus-events.jsonl"),
        "capitalPerVenue": "10000", "orderSizePercent": "10", "timeframeMs": MINUTE,
        "fees": {venue: {"makerPercent": "0", "takerPercent": "0.05"} for venue in ("lighter", "hyperliquid")},
        "tracks": [{"venue": venue, "market": market} for venue, market in tracks],
        "minticks": {(venue if market == "HYPE" else f"{venue}:{market}"): "0.01" for venue, market in tracks},
        **({"marketFees": market_fees} if market_fees else {}),
    }


class PineRun(SandboxRun):
    def __init__(self, folder, label, tracks, market_fees=None):
        super().__init__(folder, pine_config(folder, label, tracks, market_fees))
        self.tracks = tracks

    async def start(self):
        await self.launch()
        for venue in {venue for venue, _ in self.tracks}:
            await self.socket(venue, "CONNECTED")
        await self.prices(("100.00", "100.10"))
        await self.wait_stage("running")

    async def prices(self, prices, size="1000.000"):
        for venue, market in self.tracks:
            await self.send({"cmd": "frame", "venue": venue, "market": market,
                             "bids": [[prices[0], size]], "asks": [[prices[1], size]]})

    def messages(self, text):
        return [event for event in self.events if event["type"] == "event" and text in event["message"]]

    def pine_fills(self):
        return [e for e in self.events if e["type"] == "pine_fill"]

    async def orders(self, venue, market, orders, trades=(), fills_through=0):
        bar = (time.time_ns() // 1_000_000 // MINUTE + 1) * MINUTE
        await self.send({"cmd": "pine_orders", "venue": venue, "market": market, "barCloseMs": bar,
                         "fillsThrough": fills_through, "orders": list(orders), "trades": list(trades)})


async def scenario():
    with tempfile.TemporaryDirectory(prefix="psr-nautilus-pine-") as tmp:
        run = PineRun(Path(tmp), "single-venue", [("lighter", "SOL")])
        try:
            await run.start()
            snapshot = await run.snapshot()
            assert len(snapshot["accounts"]) == 2, snapshot
            idle = next(a for a in snapshot["accounts"] if a["venue"] == "Hyperliquid")
            assert idle["cashBalance"] == "10000" and idle["priceReady"], idle

            entry = {"id": "L", "category": "entry", "type": "market", "side": "long", "tradeKeys": [],
                     "qtyCap": None, "plan": {"accepted": True, "closes": [], "opensSide": "long", "opensQty": 9.9}}
            await run.orders("lighter", "SOL", [entry])
            await run.wait(lambda: run.pine_fills(), "Pine entry report")
            [report] = run.pine_fills()
            assert report["orderId"] == "L" and report["category"] == "entry", report
            assert Decimal(report["price"]) == Decimal("100.10"), report
            [fill] = run.fills("entry")
            assert fill["positionSide"] == "long" and Decimal(fill["quantity"]) == Decimal("9.990"), fill

            key = f"L@{report['time']}"
            trade = {"key": key, "entryId": "L", "side": "long", "qty": 9.9, "entryPrice": 100.1,
                     "bracketEntryPrice": 100.1, "entryTime": report["time"]}
            bracket = {"id": "XL", "category": "exit", "type": "market", "side": "long", "fromEntry": "L",
                       "profitTicks": 100, "lossTicks": 100, "tradeKeys": [key], "qtyCap": None}
            await run.orders("lighter", "SOL", [bracket], [trade], fills_through=1)
            await asyncio.sleep(0.3)
            await run.prices(("101.20", "101.30"))
            await run.wait(lambda: len(run.pine_fills()) == 2, "Pine take-profit report")
            exit_report = run.pine_fills()[1]
            assert (exit_report["orderId"], exit_report["leg"], exit_report["tradeKey"]) == ("XL", "profit", key), exit_report
            assert Decimal(exit_report["qty"]) == Decimal("9.9"), exit_report
            [exit_fill] = run.fills("exit")
            assert Decimal(exit_fill["price"]) == Decimal("101.20"), exit_fill
            assert Decimal(exit_fill["realizedPnl"]) > 0, exit_fill
            final = await run.snapshot()
            lighter = next(a for a in final["accounts"] if a["venue"] == "Lighter")
            assert not lighter["positions"], final
            expected = Decimal("10000") + (Decimal("101.20") - Decimal("100.10")) * Decimal("9.990") \
                - Decimal("0.0005") * Decimal("9.990") * (Decimal("100.10") + Decimal("101.20"))
            assert Decimal(lighter["cashBalance"]) == expected, (lighter, expected)
            # Realized PnL is net of both fees: it equals the account change of the round trip.
            assert Decimal(exit_fill["realizedPnl"]) == expected - Decimal("10000"), exit_fill
            assert not run.failures(), run.failures()
            run.stderr.flush()
            past_timers = (run.folder / "stderr.log").read_text(errors="replace").count("was in the past")
            assert past_timers < 20, f"{past_timers} immediate timers: alert loop"
        except Exception:
            print((run.folder / "stderr.log").read_text(errors="replace")[-8000:], file=sys.stderr)
            print(json.dumps(run.events[-25:], indent=2), file=sys.stderr)
            raise
        finally:
            await run.close()
        print("pine single-venue PASS fills", len(run.fills()), "reports", len(run.pine_fills()), flush=True)


async def hip3_scenario():
    """A Hyperliquid HIP-3 market (xyz:NVDA) runs like any market and pays its own fee."""
    with tempfile.TemporaryDirectory(prefix="psr-nautilus-pine-hip3-") as tmp:
        tracks = [("hyperliquid", "xyz:NVDA"), ("hyperliquid", "SOL")]
        fees = {"hyperliquid:xyz:NVDA": {"makerPercent": "0.003", "takerPercent": "0.009"}}
        run = PineRun(Path(tmp), "hip3", tracks, fees)
        try:
            await run.start()
            entry = {"id": "L", "category": "entry", "type": "market", "side": "long", "tradeKeys": [],
                     "qtyCap": None, "plan": {"accepted": True, "closes": [], "opensSide": "long", "opensQty": 9.9}}
            for market in ("xyz:NVDA", "SOL"):
                await run.orders("hyperliquid", market, [entry])
            await run.wait(lambda: len(run.fills("entry")) == 2, "both entries")
            by_market = {fill["market"]: fill for fill in run.fills("entry")}
            for market, rate in (("xyz:NVDA", Decimal("0.00009")), ("SOL", Decimal("0.0005"))):
                fill = by_market[market]
                assert Decimal(fill["fee"]) == rate * Decimal(fill["quantity"]) * Decimal(fill["price"]), (market, fill)
            assert not run.failures(), run.failures()
        except Exception:
            print((run.folder / "stderr.log").read_text(errors="replace")[-8000:], file=sys.stderr)
            print(json.dumps(run.events[-25:], indent=2), file=sys.stderr)
            raise
        finally:
            await run.close()
        print("pine hip3 PASS fills", len(run.fills()), flush=True)


if __name__ == "__main__":
    asyncio.run(scenario())
    asyncio.run(hip3_scenario())
