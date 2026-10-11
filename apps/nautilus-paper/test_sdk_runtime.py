"""Python SDK strategy in real, network-free Nautilus Sandbox."""

import asyncio
from decimal import Decimal
import json
from pathlib import Path
import sys
import tempfile
import time

from test_pine_runtime import MINUTE, PineRun, pine_config

PACK = '''
from psr_sdk import Param, Strategy


class FirstBarLong(Strategy):
    name = "First bar long"
    timeframe = "1m"
    params = {"tp": Param(int, 100, min=1)}

    def on_bar(self, ctx, bar):
        if ctx.is_history:
            ctx.state["warm"] = ctx.state.get("warm", 0) + 1
            return
        if ctx.position == 0 and not ctx.state.get("done"):
            ctx.entry("L", "long")
            ctx.exit("XL", "L", profit_ticks=ctx.params["tp"], loss_ticks=500)

    def on_fill(self, ctx, fill):
        ctx.log(f"strategy saw {fill.category} {fill.side} {fill.qty} @ {fill.price} ({fill.leg})")
        if fill.category == "exit":
            ctx.state["done"] = True
'''


IOC_PACK = """
from psr_sdk import Strategy


class DipBuyer(Strategy):
    name = "Dip buyer"
    timeframe = "1m"

    def on_quote(self, ctx, quote):
        if ctx.position == 0 and not ctx.orders and quote.ask <= 99.0 and not ctx.state.get("done"):
            ctx.entry("L", "long", limit="99.00", ioc=True)
            ctx.exit("XL", "L", profit_percent=1.2, loss_percent=1.0, profit_type="market")

    def on_order_rejected(self, ctx, order_id, reason):
        ctx.log(f"strategy saw rejection {order_id}: {reason}")

    def on_fill(self, ctx, fill):
        ctx.log(f"strategy saw {fill.category} {fill.qty} @ {fill.price} ({fill.leg})")
        if fill.category == "exit":
            ctx.state["done"] = True
"""


def bars(count, end_ms):
    return [{"openTime": end_ms - (count - i) * MINUTE, "closeTime": end_ms - (count - i - 1) * MINUTE,
             "open": 100, "high": 100.1, "low": 99.9, "close": 100, "volume": 1} for i in range(count)]


async def scenario():
    with tempfile.TemporaryDirectory(prefix="psr-nautilus-sdk-") as tmp:
        folder = Path(tmp)
        pack = folder / "private_pack"
        pack.mkdir()
        (pack / "first.py").write_text(PACK)
        run = PineRun(folder, "sdk", [("lighter", "SOL")])
        run.config = {**pine_config(folder, "sdk", [("lighter", "SOL")]), "nativeStrategy": "python_strategy_v1",
                      "strategy": {"ref": "private_pack/first:FirstBarLong", "packPaths": [str(pack)], "params": {"tp": 100}}}
        try:
            await run.start()
            now = time.time_ns() // 1_000_000
            await run.send({"cmd": "bars", "venue": "lighter", "market": "SOL", "bars": bars(5, now - 1000)})
            await run.wait(lambda: run.messages("warmed up on 5 bars"), "warm-up")
            await run.send({"cmd": "bar", "venue": "lighter", "market": "SOL", "bars": bars(1, now + 500)})
            await asyncio.sleep(0.3)
            await run.prices(("100.00", "100.10"))
            await run.wait(lambda: run.fills("entry"), "real entry")
            [entry] = run.fills("entry")
            assert Decimal(entry["quantity"]) == Decimal("9.990") and Decimal(entry["price"]) == Decimal("100.10"), entry
            await run.wait(lambda: run.messages("strategy saw entry long 9.99 @ 100.1"), "on_fill callback")
            await asyncio.sleep(0.2)
            await run.prices(("101.20", "101.30"))  # TP 100.10 + 100 ticks = 101.10
            await run.wait(lambda: run.fills("exit"), "take-profit")
            [exit_fill] = run.fills("exit")
            assert Decimal(exit_fill["price"]) == Decimal("101.20"), exit_fill
            await run.wait(lambda: run.messages("strategy saw exit long"), "exit callback")
            snapshot = await run.snapshot()
            lighter = next(a for a in snapshot["accounts"] if a["venue"] == "Lighter")
            assert not lighter["positions"], snapshot
            assert not run.failures(), run.failures()
            run.stderr.flush()
            past = (folder / "stderr.log").read_text(errors="replace").count("was in the past")
            assert past < 20, past
        except Exception:
            print((folder / "stderr.log").read_text(errors="replace")[-8000:], file=sys.stderr)
            print(json.dumps(run.events[-25:], indent=2), file=sys.stderr)
            raise
        finally:
            await run.close()
        print("sdk strategy PASS fills", len(run.fills()), flush=True)


async def ioc_scenario():
    """IOC entry: a miss when the price leaves before arrival, then a partial fill; market take-profit."""
    with tempfile.TemporaryDirectory(prefix="psr-nautilus-sdk-ioc-") as tmp:
        folder = Path(tmp)
        pack = folder / "ioc_pack"
        pack.mkdir()
        (pack / "dip.py").write_text(IOC_PACK)
        run = PineRun(folder, "sdk-ioc", [("lighter", "SOL")])
        run.config = {**pine_config(folder, "sdk-ioc", [("lighter", "SOL")]), "nativeStrategy": "python_strategy_v1",
                      "strategy": {"ref": "ioc_pack/dip:DipBuyer", "packPaths": [str(pack)], "params": {}}}
        try:
            await run.start()
            now = time.time_ns() // 1_000_000
            await run.send({"cmd": "bars", "venue": "lighter", "market": "SOL", "bars": bars(3, now - 1000)})
            await run.wait(lambda: run.messages("warmed up on 3 bars"), "warm-up")
            await run.prices(("98.90", "99.00"))  # touch: IOC sent
            await asyncio.sleep(0.05)
            await run.prices(("99.50", "99.60"))  # gone before the 200 ms arrival
            await run.wait(lambda: run.messages("strategy saw rejection L: no_liquidity"), "missed IOC")
            assert not run.fills(), run.fills()
            await run.send({"cmd": "frame", "venue": "lighter", "market": "SOL",
                            "bids": [["98.90", "50.000"]], "asks": [["98.95", "2.000"], ["99.50", "50.000"]]})
            await run.wait(lambda: run.fills("entry"), "partial IOC entry")
            [entry] = run.fills("entry")
            assert (Decimal(entry["quantity"]), Decimal(entry["price"])) == (Decimal("2"), Decimal("98.95")), entry
            await asyncio.sleep(0.2)
            snapshot = await run.snapshot()
            [position] = next(a for a in snapshot["accounts"] if a["venue"] == "Lighter")["positions"]
            assert position["side"] == "long" and Decimal(position["avgEntryPrice"]) == Decimal("98.95"), position
            assert Decimal(position["unrealizedPnl"]) == ((Decimal(position["markPrice"]) - Decimal("98.95")) * 2).quantize(Decimal("1e-8")), position
            assert position["openedAt"].endswith("Z"), position
            take_profit = Decimal("98.95") * Decimal("1.012")  # 100.1374, reached by the bid
            await run.prices(("100.14", "100.20"))
            await run.wait(lambda: run.fills("exit"), "market take-profit")
            [exit_fill] = run.fills("exit")
            assert Decimal(exit_fill["price"]) == Decimal("100.14") >= take_profit, exit_fill
            assert Decimal(exit_fill["quantity"]) == Decimal("2"), exit_fill
            await run.wait(lambda: run.messages("strategy saw exit 2.0 @ 100.14 (profit)"), "exit callback")
            assert not run.failures(), run.failures()
        except Exception:
            print((folder / "stderr.log").read_text(errors="replace")[-8000:], file=sys.stderr)
            print(json.dumps(run.events[-25:], indent=2), file=sys.stderr)
            raise
        finally:
            await run.close()
        print("sdk ioc PASS fills", len(run.fills()), flush=True)


if __name__ == "__main__":
    asyncio.run(scenario())
    asyncio.run(ioc_scenario())
