"""Same-process reconnect recovery of a Pine run in real, network-free Nautilus Sandbox.

A lost venue connection pauses both accounts; an open position, its fees and the
cash balance survive the pause unchanged, no order executes while recovering, and
the same process, run and accounts resume once fresh books arrive.
"""

import asyncio
from decimal import Decimal
import json
from pathlib import Path
import sys
import tempfile

from test_pine_runtime import PineRun
from sandbox_harness import stable_positions

TRACKS = [("hyperliquid", "HYPE"), ("lighter", "HYPE")]
ENTRY = {"id": "L", "category": "entry", "type": "market", "side": "long", "tradeKeys": [],
         "qtyCap": None, "plan": {"accepted": True, "closes": [], "opensSide": "long", "opensQty": 9.9}}


def accounts(snapshot):
    return {a["venue"]: a for a in snapshot["accounts"]}


async def recovery_keeps_position_and_blocks_orders():
    with tempfile.TemporaryDirectory(prefix="psr-nautilus-pine-recovery-") as tmp:
        run = PineRun(Path(tmp), "recovery", TRACKS)
        try:
            await run.start()
            await run.orders("lighter", "HYPE", [ENTRY])
            await run.wait(lambda: run.pine_fills(), "Pine entry report")
            before = accounts(await run.snapshot())
            assert before["Lighter"]["positions"], before
            pid, run_id = run.proc.pid, run.config["runId"]

            await run.socket("hyperliquid", "DISCONNECTED")
            await run.wait_stage("recovering")
            await asyncio.sleep(0.15)
            paused = await run.snapshot()
            assert paused["stage"] == "recovering", paused
            assert not any(a["priceReady"] for a in paused["accounts"]), paused
            for venue, account in accounts(paused).items():
                assert account["cashBalance"] == before[venue]["cashBalance"], (venue, account)
                assert stable_positions(account["positions"]) == stable_positions(before[venue]["positions"])

            # An order set that arrives during the pause waits; it never executes against the old book.
            await run.orders("hyperliquid", "HYPE", [ENTRY])
            await asyncio.sleep(0.5)
            assert len(run.fills()) == 1, run.fills()

            await run.socket("hyperliquid", "CONNECTED")
            await run.prices(("100.00", "100.10"))
            await run.wait_stage("running")
            resumed = accounts(await run.snapshot())
            assert all(a["priceReady"] for a in resumed.values()), resumed
            assert stable_positions(resumed["Lighter"]["positions"]) == stable_positions(before["Lighter"]["positions"])
            assert Decimal(resumed["Lighter"]["cashBalance"]) == Decimal(before["Lighter"]["cashBalance"])
            assert run.proc.pid == pid and all(e["runId"] == run_id for e in run.events)
            # The held entry executes on the first price after the resume, not on the recovery book.
            await run.prices(("100.20", "100.30"))
            await run.wait(lambda: run.fills("entry")[1:], "held entry after recovery")
            held = run.fills("entry")[1]
            resumed_seq = next(e["seq"] for e in run.events if e["type"] == "phase" and e["stage"] == "running"
                               and "recovered" in e["message"])
            assert held["venue"] == "Hyperliquid" and held["seq"] > resumed_seq, held
            assert Decimal(held["price"]) == Decimal("100.30"), held

            # The resumed run still trades: the next bar's exit closes the Lighter position.
            report = run.pine_fills()[0]
            key = f"L@{report['time']}"
            trade = {"key": key, "entryId": "L", "side": "long", "qty": 9.9, "entryPrice": 100.1,
                     "bracketEntryPrice": 100.1, "entryTime": report["time"]}
            close = {"id": "XL", "category": "exit", "type": "market", "side": "long", "fromEntry": "L",
                     "tradeKeys": [key], "qtyCap": None, "plan": {"accepted": True, "closes": [{"tradeKey": key, "qty": 9.9}]}}
            await run.orders("lighter", "HYPE", [close], [trade], fills_through=1)
            await run.wait(lambda: run.fills("exit"), "exit after recovery")
            final = accounts(await run.snapshot())
            assert not final["Lighter"]["positions"], final
            assert not run.failures(), run.failures()
            await run.stop()
        except Exception:
            print((run.folder / "stderr.log").read_text(errors="replace")[-8000:], file=sys.stderr)
            print(json.dumps(run.events[-30:], indent=2), file=sys.stderr)
            raise
        finally:
            await run.close()
        print("pine recovery PASS fills", len(run.fills()), "events", len(run.events),
              "same PID/run and contiguous persisted outbox", flush=True)


if __name__ == "__main__":
    asyncio.run(recovery_keeps_position_and_blocks_orders())
