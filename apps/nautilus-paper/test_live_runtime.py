"""Live trading code path, network-free: a Sandbox client stands in for Lighter on the LIGHTER venue.

Proves that Live orders go to the venue's own instrument, that the exchange-side stop follows the
position, that positions may exceed the balance up to the account leverage, and that the daily loss limit, a position that differs from
the exchange's and a stop all end with every position closed (see docs/LIVE_TRADING_DESIGN.md).
"""

import asyncio
from decimal import Decimal
import json
import os
from pathlib import Path
import sys
import tempfile
import time

from test_pine_runtime import MINUTE, PineRun, pine_config
from test_sdk_runtime import bars

PACK = """
from psr_sdk import Strategy


class DipBuyer(Strategy):
    name = "Dip buyer"
    timeframe = "1m"

    def on_quote(self, ctx, quote):
        if ctx.position == 0 and not ctx.orders and quote.ask <= 99.0 and not ctx.state.get("done"):
            ctx.entry("L", "long", limit="99.00", ioc=True)
            ctx.exit("XL", "L", profit_percent=1.2, loss_percent=1.0, profit_type="market")

    def on_fill(self, ctx, fill):
        if fill.category == "exit":
            ctx.state["done"] = True
"""


def live_run(folder, label, markets=("SOL",), venues=("lighter",), **live):
    pack = folder / "live_pack"
    pack.mkdir(exist_ok=True)
    (pack / "dip.py").write_text(PACK)
    tracks = [(venue, market) for venue in venues for market in markets]
    run = PineRun(folder, label, tracks)
    run.config = {**pine_config(folder, label, tracks), "nativeStrategy": "python_strategy_v1",
                  "strategy": {"ref": "live_pack/dip:DipBuyer", "packPaths": [str(pack)], "params": {}},
                  "live": {"exchange": "sandbox", "dailyLossLimitPercent": "50", "maxLeverage": "10",
                           "stateFile": str(folder / "live-daily.json"),
                           "exchangeStopPercent": "0.3", "exchangeStopFrom": "strategy_stop", **live}}
    return run


async def enter(run, count=1):
    await run.start()
    now = time.time_ns() // 1_000_000
    for venue, market in run.tracks:
        await run.send({"cmd": "bars", "venue": venue, "market": market, "bars": bars(3, now - 1000)})
    await run.wait(lambda: len(run.messages("warmed up on 3 bars")) == len(run.tracks), "warm-up")
    await run.prices(("98.90", "99.00"))
    await run.wait(lambda: len(run.fills("entry")) == count, "Live entry")
    await run.wait(lambda: len(run.messages("exchange-side stop on ")) == count, "exchange-side stop placed")
    entries = run.fills("entry")
    return entries[0] if count == 1 else entries


CLOSED = "; LIVE: every position of this run is closed on Lighter"


async def live_stop(run, reason):
    """Stop a Live run; its reason ends with the engine's outcome: every position closed."""
    await run.send({"cmd": "stop", "reason": reason})
    await run.finish()
    assert not run.failures(), run.failures()
    assert stopped_reason(run) == [reason + CLOSED], stopped_reason(run)


def stopped_reason(run):
    return [e["reason"] for e in run.events if e["type"] == "stopped"]


def report(run, folder):
    print((folder / "stderr.log").read_text(errors="replace")[-6000:], file=sys.stderr)
    print(json.dumps(run.events[-30:], indent=2), file=sys.stderr)


async def take_profit_closes_the_position():
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-follow")
        try:
            entry = await enter(run)
            assert run.messages("LIVE run on Lighter mainnet: account clean"), run.events
            # Strategy stop 99.00 × 0.99 = 98.01; the exchange-side stop 0.3 % further, rounded down: 97.71.
            [placed] = run.messages("exchange-side stop on Lighter")
            assert placed["message"] == (f"exchange-side stop on Lighter: sell {entry['quantity']} SOL if price reaches "
                                         "97.71 (reduce-only)"), placed
            await asyncio.sleep(1.5)  # a position check runs and agrees with the stand-in exchange
            snapshot = await run.snapshot()
            lighter = next(a for a in snapshot["accounts"] if a["venue"] == "Lighter")
            assert lighter["positions"], lighter
            # The real balance at the start, for the run page's realized and total PnL.
            assert Decimal(lighter["startBalance"]) > 0, lighter
            await run.prices(("100.19", "100.25"))  # market take-profit at +1.2 % (100.188)
            await run.wait(lambda: run.fills("exit"), "take-profit")
            await run.wait(lambda: run.messages("removed from Lighter"), "exchange-side stop removed")
            snapshot = await run.snapshot()
            lighter = next(a for a in snapshot["accounts"] if a["venue"] == "Lighter")
            assert not lighter["positions"] and lighter["pendingOrders"] == 0, lighter
            assert not run.messages("LIVE position check"), run.events
            await live_stop(run, "live follow done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live take-profit closes the position PASS", flush=True)


async def two_exchanges_halt_one_at_a_time():
    """One Live run on Lighter and Hyperliquid (owner decision 2026-10-19): a fault of one exchange halts
    only that one and closes its position while the other trades on; when the last one halts, the run
    stops. The same market on both exchanges keeps its own counters and position check."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-two", venues=("lighter", "hyperliquid"))
        try:
            await enter(run, count=2)
            assert run.messages("LIVE run on Lighter mainnet: account clean"), run.events
            assert run.messages("LIVE run on Hyperliquid mainnet: account clean"), run.events
            assert run.messages("exchange-side stop on Hyperliquid"), run.events
            snapshot = await run.snapshot()
            accounts = {a["venue"]: a for a in snapshot["accounts"]}
            assert accounts["Lighter"]["positions"] and accounts["Hyperliquid"]["positions"], accounts
            assert Decimal(accounts["Hyperliquid"]["startBalance"]) > 0, accounts
            stored = json.loads((folder / "live-daily.json").read_text())
            assert set(stored["accounts"]) == {"sandbox", "sandbox-hyperliquid"}, stored  # one day reference each

            # Hyperliquid reports a different position twice: Hyperliquid halts and closes, Lighter trades on.
            await run.send({"cmd": "live_exchange_position", "venue": "hyperliquid", "market": "SOL", "quantity": "0"})
            await run.wait(lambda: run.messages("LIVE halt on Hyperliquid"), "Hyperliquid halted")
            await run.wait(lambda: run.messages("every position of this run is closed on Hyperliquid"), "Hyperliquid closed")
            snapshot = await run.snapshot()
            accounts = {a["venue"]: a for a in snapshot["accounts"]}
            assert not accounts["Hyperliquid"]["positions"] and "position differs" in accounts["Hyperliquid"]["halted"], accounts
            assert accounts["Lighter"]["positions"] and "halted" not in accounts["Lighter"], accounts
            assert not stopped_reason(run) and snapshot.get("stage") != "stopping", snapshot.get("stage")

            # Lighter's position differs too: the last trading exchange halts and the run stops.
            await run.send({"cmd": "live_exchange_position", "venue": "lighter", "market": "SOL", "quantity": "0"})
            await run.finish()
            [reason] = stopped_reason(run)
            assert reason.startswith("LIVE halt: Lighter: SOL: position differs") or reason.startswith(
                "LIVE halt: Hyperliquid: SOL: position differs"), reason
            assert "Hyperliquid: SOL: position differs" in reason and "Lighter: SOL: position differs" in reason, reason
            assert "LIVE: every position of this run is closed" in reason, reason
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live two exchanges halt one at a time PASS", flush=True)


async def canceled_exit_retries_after_a_pause():
    """An exit Lighter cancels without a fill is not re-sent at once: it waits, then closes the position."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-exit-miss")
        try:
            entry = await enter(run)
            await asyncio.sleep(0.2)
            # Take-profit at +1.2 %: a crumb at the bid fills, the rest finds nothing on the same book.
            await run.send({"cmd": "frame", "venue": "lighter", "market": "SOL",
                            "bids": [["100.19", "0.010"]], "asks": [["100.25", "1000.000"]]})
            await run.wait(lambda: run.messages("without a fill; next try in 1 s"), "paused exit")
            assert not run.fills("exit")[1:], run.fills("exit")  # nothing re-sent at once
            # A live venue keeps streaming prices: feed fresh books until the paused exit has closed it all.
            closed = lambda: sum(Decimal(f["quantity"]) for f in run.fills("exit")) == Decimal(entry["quantity"])
            for _ in range(50):
                if closed():
                    break
                await run.prices(("100.19", "100.25"))
                await asyncio.sleep(0.3)
            assert closed(), run.fills("exit")
            assert not run.messages("exit orders in a row"), run.events
            await live_stop(run, "live exit miss done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live canceled exit retries after a pause PASS", flush=True)


async def late_fill_after_cancel_is_booked_and_closed():
    """On Lighter an order's fill can arrive after its cancel: it is booked and the extra is closed."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-late-fill")
        try:
            await run.start()
            now = time.time_ns() // 1_000_000
            await run.send({"cmd": "bars", "venue": "lighter", "market": "SOL", "bars": bars(3, now - 1000)})
            await run.wait(lambda: run.messages("warmed up on 3 bars"), "warm-up")
            await run.send({"cmd": "live_test_hold_fill", "market": "SOL"})
            # The entry (10.101 SOL) meets 5 SOL: 5 fill, the rest is canceled, and the fill comes last.
            await run.send({"cmd": "frame", "venue": "lighter", "market": "SOL",
                            "bids": [["98.90", "1000.000"]], "asks": [["99.00", "5.000"]]})
            await run.wait(lambda: run.messages("LIVE: late fill of order"), "late fill")
            [late] = run.messages("LIVE: late fill of order")
            assert "buy 5.000 SOL at 99.00; 5.000 owned by no trade closes at market" in late["message"], late
            await run.wait(lambda: run.fills("exit"), "extra closed")
            [extra] = run.fills("exit")
            assert Decimal(extra["quantity"]) == Decimal("5") and Decimal(extra["price"]) == Decimal("98.90"), extra
            await run.prices(("99.40", "99.50"))  # above the entry level: no new entry
            await asyncio.sleep(1.5)  # a position check agrees with the stand-in exchange
            snapshot = await run.snapshot()
            assert not next(a for a in snapshot["accounts"] if a["venue"] == "Lighter")["positions"], snapshot
            assert not run.messages("LIVE position check") and not run.failures(), run.events
            await live_stop(run, "live late fill done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live late fill after cancel is booked and closed PASS", flush=True)


async def api_gone_still_closes_every_position():
    """The controlling API dies (its pipes close): the engine still closes every market's position."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-api-gone", markets=("SOL", "BTC"))
        try:
            entries = await enter(run, count=2)
            # The API process is gone: nobody reads the events and stdin ends.
            run.reader.cancel()
            run.reader = None
            run.proc._transport.get_pipe_transport(1).close()
            run.proc.stdin.close()
            await asyncio.wait_for(run.proc.wait(), timeout=60)
            outbox = [json.loads(line) for line in Path(run.config["eventOutboxPath"]).read_text().splitlines()]
            exits = {e["market"]: Decimal(e["quantity"]) for e in outbox if e["type"] == "fill" and e["kind"] == "exit"}
            assert exits == {e["market"]: Decimal(e["quantity"]) for e in entries}, (exits, entries)
            [stopped] = [e for e in outbox if e["type"] == "stopped"]
            assert "controlling API" in stopped["reason"] and "still open" not in stopped["reason"], stopped
            assert (folder / "nautilus-detached.log").exists() or any(folder.rglob("nautilus-detached.log"))
        except Exception:
            print((folder / "stderr.log").read_text(errors="replace")[-4000:], file=sys.stderr)
            raise
        finally:
            await run.close()
        print("live API gone still closes every position PASS", flush=True)


async def engine_stop_executes_at_once():
    """Live has no modeled trigger delay: the stop's market order leaves on the crossing price."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-stop-now")
        try:
            entry = await enter(run)
            await asyncio.sleep(0.2)
            sent = time.monotonic()
            await run.prices(("97.90", "97.95"))  # below the strategy stop 98.01, above the exchange-side stop 97.71
            await run.wait(lambda: run.fills("exit"), "engine stop")
            elapsed_ms = (time.monotonic() - sent) * 1000
            [exit_fill] = run.fills("exit")
            assert Decimal(exit_fill["price"]) == Decimal("97.90") and exit_fill["quantity"] == entry["quantity"], exit_fill
            assert run.messages("loss triggered; executing now") and not run.messages("executes in"), run.events
            await run.wait(lambda: run.messages("removed from Lighter"), "exchange-side stop removed")
            assert run.messages("LIVE latency SOL: sent→filled"), run.events
            await live_stop(run, "live stop-now done")
            print(f"  engine stop: price update to exit fill {elapsed_ms:.0f} ms (test harness, offline)", flush=True)
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live engine stop executes at once PASS", flush=True)


async def stop_resends_the_close_for_the_rest():
    """A stop's close meets a thin book: the rest is closed again after the answer, until flat."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-close-retry")
        try:
            entry = await enter(run)
            await asyncio.sleep(0.2)
            # The bid holds only 3 of the 10.101 SOL to close when the owner stops the run.
            await run.send({"cmd": "frame", "venue": "lighter", "market": "SOL",
                            "bids": [["98.40", "3.000"]], "asks": [["98.45", "1000.000"]]})
            await asyncio.sleep(0.2)
            await run.send({"cmd": "stop", "reason": "owner stop"})
            await run.wait(lambda: run.messages("canceled by Lighter; filled 3.000 of"), "partial close", timeout=10)
            await run.prices(("98.40", "98.45"))  # the venue's book refills
            await run.finish()
            [reason] = stopped_reason(run)
            assert reason == "owner stop" + CLOSED, reason
            exits = run.fills("exit")
            assert sum(Decimal(f["quantity"]) for f in exits) == Decimal(entry["quantity"]), exits
            assert run.messages("(reduce-only, attempt 2)"), run.events
            assert run.messages("removed from Lighter"), run.events  # flat: its exchange-side stop is removed
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live stop re-sends the close for the rest PASS", flush=True)


async def long_data_gap_closes_that_position():
    """No verified data for a while with a position open: that position is closed, the run goes on."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-gap-close")
        try:
            entry = await enter(run)
            await asyncio.sleep(0.2)
            await run.socket("lighter", "DISCONNECTED")  # offline: closes after 3 s (Lighter: 60 s)
            await run.wait(lambda: run.messages("no verified SOL data for 3 s"), "gap close", timeout=10)
            await run.wait(lambda: run.fills("exit"), "position closed in the gap")
            assert sum(Decimal(f["quantity"]) for f in run.fills("exit")) == Decimal(entry["quantity"]), run.fills("exit")
            await run.wait(lambda: run.messages("removed from Lighter"), "exchange-side stop removed")
            assert not stopped_reason(run), run.events  # the run itself goes on
            await run.socket("lighter", "CONNECTED")
            for _ in range(20):
                if run.messages("Public data gap recovered"):
                    break
                await run.prices(("99.40", "99.50"))
                await asyncio.sleep(0.3)
            assert run.messages("Public data gap recovered"), run.events
            await asyncio.sleep(1.2)
            assert not run.messages("LIVE position check") and not run.failures(), run.events
            await live_stop(run, "live gap close done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live long data gap closes that position PASS", flush=True)


async def daily_loss_counts_lighter_pnl_in_a_gap():
    """During a data gap the market's open loss comes from Lighter's account for the daily limit."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-gap-loss", dailyLossLimitPercent="1")
        try:
            await enter(run)
            await run.send({"cmd": "live_exchange_pnl", "market": "SOL", "pnl": "-150"})
            await run.socket("lighter", "DISCONNECTED")
            await run.finish()
            [reason] = stopped_reason(run)
            # 10 000 USDC at the start; 0.50 entry fee and Lighter's −150 open PnL: 1.505 % below.
            assert "daily loss limit reached: equity 9849.50 USDC is 1.50% below 10000.00 USDC" in reason, reason
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live daily loss counts Lighter's open PnL in a gap PASS", flush=True)


async def exchange_stop_from_the_entry_price():
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-stop-entry", exchangeStopPercent="2", exchangeStopFrom="entry_price")
        try:
            entry = await enter(run)
            [placed] = run.messages("exchange-side stop on Lighter")
            # 2 % below the 99.00 entry, whatever the strategy's own stop.
            assert f"sell {entry['quantity']} SOL if price reaches 97.02 " in placed["message"], placed
            assert run.messages("exchange-side stop 2% from the entry price, max slippage 3%"), run.events
            await live_stop(run, "live stop from entry done")
            assert run.messages("removed from Lighter"), run.events  # the stop removes it after the close
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live exchange-side stop from the entry price PASS", flush=True)


async def exchange_stop_executes_and_halts():
    """The exchange-side stop executes on its own: booked, the strategy follows, the run halts."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        # 0.5 % from the entry (98.50) sits above the strategy's own stop (98.01): only Lighter's fires.
        run = live_run(folder, "live-stop-fires", exchangeStopPercent="0.5", exchangeStopFrom="entry_price")
        try:
            entry = await enter(run)
            await asyncio.sleep(0.2)
            await run.prices(("98.40", "98.45"))
            await run.finish()
            [reason] = stopped_reason(run)
            assert "the exchange-side stop executed on Lighter" in reason, reason
            exits = run.fills("exit")
            assert sum(Decimal(f["quantity"]) for f in exits) == Decimal(entry["quantity"]), exits
            snapshot = [e for e in run.events if e["type"] == "snapshot"][-1]
            assert not next(a for a in snapshot["accounts"] if a["venue"] == "Lighter")["positions"], snapshot
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live exchange-side stop executes and halts PASS", flush=True)


async def exchange_stop_removed_by_lighter_is_not_looped():
    """Lighter removes the exchange-side stop on its own: placed again once; a second time halts."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-stop-lost")
        try:
            entry = await enter(run)
            await asyncio.sleep(0.3)
            await run.send({"cmd": "live_test_drop_safety", "market": "SOL"})
            await run.wait(lambda: len(run.messages("exchange-side stop on Lighter")) == 2, "stop placed again")
            await asyncio.sleep(0.3)
            await run.send({"cmd": "live_test_drop_safety", "market": "SOL"})
            await run.finish()
            [reason] = stopped_reason(run)
            assert "Lighter canceled the exchange-side stop twice within a minute" in reason and CLOSED in reason, reason
            assert len(run.messages("exchange-side stop on Lighter")) == 2, run.events  # no loop
            assert sum(Decimal(f["quantity"]) for f in run.fills("exit")) == Decimal(entry["quantity"]), run.fills("exit")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live exchange-side stop removed by Lighter is not looped PASS", flush=True)


async def stop_removed_just_before_the_closing_fill():
    """As on Lighter (2026-10-16): the stop's cancel arrives just before the exit's fill. Not a lost stop."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-stop-race")
        try:
            entry = await enter(run)
            await asyncio.sleep(0.3)
            await run.send({"cmd": "live_test_drop_safety", "market": "SOL"})
            await run.prices(("100.19", "100.25"))  # the take-profit closes the position right after
            await run.wait(lambda: run.fills("exit"), "take-profit")
            await asyncio.sleep(2.5)  # past the grace for a stop Lighter removed
            assert len(run.messages("exchange-side stop on Lighter")) == 1, run.events  # nothing placed again
            assert not stopped_reason(run) and not run.failures(), run.events
            assert sum(Decimal(f["quantity"]) for f in run.fills("exit")) == Decimal(entry["quantity"]), run.fills("exit")
            await live_stop(run, "live stop race done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live stop removed just before the closing fill PASS", flush=True)


async def daily_loss_limit_closes_everything():
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-loss", markets=("SOL", "BTC"), dailyLossLimitPercent="1")
        run.config["orderSizePercent"] = "100"
        try:
            entries = await enter(run, count=2)
            assert run.messages("new day from 06:00 UTC: starting equity 10000.00 USDC"), run.events
            await asyncio.sleep(0.2)
            # About −122 USDC open loss on ~202 SOL+BTC (above both strategy stops): over 1 % of 10 000.
            await run.prices(("98.40", "98.45"))
            await run.finish()
            [reason] = stopped_reason(run)
            assert "daily loss limit reached: equity" in reason and "limit 1%" in reason, reason
            exits = {f["market"]: f["quantity"] for f in run.fills("exit")}
            assert exits == {e["market"]: e["quantity"] for e in entries}, (exits, entries)
            stored = json.loads((folder / "live-daily.json").read_text())
            assert Decimal(stored["accounts"]["sandbox"]["equity"]) == Decimal("10000"), stored
            assert stored["accounts"]["sandbox"]["period"].endswith("06:00:00+00:00"), stored
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live daily loss limit PASS", flush=True)


async def daily_loss_limit_carries_over_the_day():
    """The day's starting equity is kept on the server: a later run of the same day continues from it."""
    import runtime
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        period = runtime.RuntimeController.live_period_start().isoformat(timespec="seconds")
        state = folder / "live-daily.json"
        # An earlier run today started from 10 200 USDC; the account now holds 10 000: 1.96 % down.
        state.write_text(json.dumps({"account": "sandbox", "period": period, "equity": "10200"}))
        run = live_run(folder, "live-day-used", dailyLossLimitPercent="1")
        try:
            await run.launch()  # refused as the strategies start, before any market data
            await run.wait(lambda: run.failures(), "refusal at start")
            [failure] = run.failures()
            assert "daily loss limit of 1% is already used up" in failure["message"], failure
            assert "LIVE can start again after 06:00 UTC" in failure["message"], failure
            await run.finish()
            assert not run.fills(), run.events
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        # Yesterday's starting equity does not count: a new day starts from the current equity.
        yesterday = (runtime.RuntimeController.live_period_start() - runtime.timedelta(days=1)).isoformat(timespec="seconds")
        state.write_text(json.dumps({"account": "sandbox", "period": yesterday, "equity": "10200"}))
        second = folder / "second"  # a later run: its own folder, the same day file on the server
        second.mkdir()
        run = live_run(second, "live-new-day", dailyLossLimitPercent="1", stateFile=str(state))
        try:
            await run.start()
            await run.wait(lambda: run.messages("new day from 06:00 UTC: starting equity 10000.00 USDC"), "new day")
            assert json.loads(state.read_text())["accounts"]["sandbox"]["period"] == period
            await live_stop(run, "live new day done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live daily loss limit carries over the day PASS", flush=True)


async def positions_may_exceed_the_balance_up_to_the_leverage():
    """Live is bound by the account leverage, not by the balance: two 100 % entries at 1.5x."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-beyond-cash", markets=("SOL", "BTC"), maxLeverage="1.5")
        run.config["orderSizePercent"] = "100"
        try:
            entries = await enter(run, count=2)
            total = sum(Decimal(e["quantity"]) for e in entries) * Decimal("98.95")
            assert total > Decimal("10000"), entries  # more than the 10 000 USDC balance
            assert total <= Decimal("15000"), entries
            assert run.messages("by the account leverage limit of 1.5x"), run.events
            assert not run.messages("shared capital"), run.events
            await live_stop(run, "live beyond cash done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live positions beyond the balance up to the leverage PASS", flush=True)


async def max_position_shrinks_the_entry():
    """Max position (USDC) caps one market's position: a larger Order size entry shrinks to fit."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-cap", maxPositionUsdc="300")
        try:
            entry = await enter(run)
            assert Decimal(entry["quantity"]) == Decimal("3.030"), entry  # floor(300 / 99.00, 0.001)
            assert run.messages("by the Max position of 300 USDC"), run.events
            assert run.messages("max position 300 USDC"), run.events
            await live_stop(run, "live cap done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live max position shrinks the entry PASS", flush=True)


async def minimum_order_size_entry():
    """Minimum order size: the market's smallest order (10 USDC here) plus 15 %, not Order size."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-min", minimumOrderSize=True)
        try:
            entry = await enter(run)
            assert Decimal(entry["quantity"]) == Decimal("0.117"), entry  # ceil(10 * 1.15 / 99.00, 0.001)
            assert run.messages("entries at the market minimum order"), run.events
            await live_stop(run, "live min done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live minimum order size entry PASS", flush=True)


async def account_leverage_limits_all_positions():
    """Two markets on one 10 000 USDC account at 0.15x: together at most 1 500 USDC of positions."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-leverage", markets=("SOL", "BTC"), maxLeverage="0.15")
        try:
            entries = await enter(run, count=2)
            # Open positions are valued at the current mid (98.95), as the engine does.
            total = sum(Decimal(e["quantity"]) for e in entries) * Decimal("98.95")
            assert total <= Decimal("1500"), entries
            assert total > Decimal("1490"), entries  # the second entry used the room that was left
            [reduced] = run.messages("by the account leverage limit of 0.15x")
            # Equity counts the first entry's fee (0.50) and its open loss (−0.51), not open gains.
            assert "(1499.85 USDC on 9998.99 USDC equity)" in reduced["message"], reduced
            assert run.messages("account leverage 0.15x"), run.events
            await live_stop(run, "live leverage done")
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live account leverage PASS", flush=True)


async def stop_closes_the_open_position():
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-stop")
        try:
            entry = await enter(run)
            await run.send({"cmd": "stop", "reason": "owner stop"})
            await run.finish()
            assert stopped_reason(run) == ["owner stop" + CLOSED], stopped_reason(run)
            [exit_fill] = run.fills("exit")
            assert exit_fill["quantity"] == entry["quantity"], exit_fill
            assert run.messages("closing") and not run.failures(), run.events
            snapshot = [e for e in run.events if e["type"] == "snapshot"][-1]
            lighter = next(a for a in snapshot["accounts"] if a["venue"] == "Lighter")
            assert not lighter["positions"], snapshot
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live stop closes the position PASS", flush=True)


async def position_check_halts_on_a_difference():
    """Lighter shows more than the run counts (a fill missed during a disconnect): the run halts."""
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)
        run = live_run(folder, "live-check")
        try:
            entry = await enter(run)
            await asyncio.sleep(2.5)  # checks once a second offline; they agree with the stand-in exchange
            assert not run.messages("LIVE position check"), run.events
            held = Decimal(entry["quantity"])
            await run.send({"cmd": "live_exchange_position", "market": "SOL", "quantity": str(held + 1)})
            await run.finish()
            [reason] = stopped_reason(run)
            assert (f"SOL: position differs from Lighter (the run counts {held} SOL, Lighter shows {held + 1})"
                    in reason), reason
            assert run.messages("checking again"), run.events
            [exit_fill] = run.fills("exit")
            assert exit_fill["quantity"] == entry["quantity"], exit_fill
        except Exception:
            report(run, folder)
            raise
        finally:
            await run.close()
        print("live position check PASS", flush=True)


def refusals_follow_the_lighter_table():
    """Lighter's error codes decide: pause and count, pause entries, wait for confirmation or halt."""
    import runtime
    classify = runtime.classify_live_refusal
    assert classify("LIGHTER_21739: not enough margin to create the order") == "refused"
    assert classify("Lighter sequencer rejected acknowledged create transaction 0x1: reduce only increases position") == "refused"
    assert classify("Lighter submit_order dispatch failed: Transport(Closed)") == "refused"  # never sent
    assert classify("REDUCE_ONLY would increase position", denied=True) == "refused"  # refused before sending
    assert classify("LIGHTER_23000: Too Many Requests!") == "rate_limit"
    assert classify("LIGHTER_29501: process timeout") == "unknown_outcome"
    assert classify("LIGHTER_21104: invalid nonce") == "nonce"
    assert classify("LIGHTER_21120: invalid signature") == "key"
    for halt in ("LIGHTER_21112: account is in liquidation", "LIGHTER_52002: only reducing", "LIGHTER_21702: invalid price"):
        assert classify(halt) == "halt", halt
    assert classify("LIGHTER_99999: something new") == "unknown"
    assert runtime.lighter_error_code("Lighter sequencer rejected acknowledged create transaction 0x2: "
                                      "SL/TP order price is too far from the trigger price") == 21735
    assert classify("an unexpected text") == "unknown"

    policy = runtime.LiveRefusalPolicy()
    margin = "LIGHTER_21739: not enough margin to create the order"
    for _ in range(4):
        assert policy.refused("SOL", margin, 1_000) == ("refused", None)
    group, halt = policy.refused("SOL", margin, 1_000)
    assert "5 orders in a row on SOL" in halt, halt
    policy = runtime.LiveRefusalPolicy()
    for index in range(9):  # spread over markets, a fill between them: not in a row
        market = ("SOL", "BTC", "ETH")[index % 3]
        assert policy.refused(market, margin, index * 1_000)[1] is None
        policy.filled(market)
    assert "10 orders within 10 minutes" in policy.refused("SOL", margin, 9_000)[1]
    policy = runtime.LiveRefusalPolicy()
    assert policy.refused("SOL", margin, 0)[1] is None
    assert policy.refused("SOL", margin, 700_000)[1] is None  # the first one left the 10-minute window
    assert len(policy.recent) == 1
    group, halt = policy.refused("SOL", "LIGHTER_23000: Too Many Requests!", 5_000)
    assert group == "rate_limit" and halt is None and policy.entries_paused_until_ms == 35_000
    policy = runtime.LiveRefusalPolicy()
    nonce = "LIGHTER_21104: invalid nonce"
    assert policy.refused("SOL", nonce, 0)[1] is None and policy.refused("BTC", nonce, 1)[1] is None
    assert "3 orders in a row for the order number" in policy.refused("ETH", nonce, 2)[1]
    assert policy.refused("SOL", "LIGHTER_29501: process timeout", 0) == ("unknown_outcome", None)
    assert "check the positions in the Lighter app" in policy.refused("SOL", "LIGHTER_21120: invalid signature", 0)[1]
    assert "Lighter refused an order on SOL" in policy.refused("SOL", "LIGHTER_99999: new", 0)[1]
    # The same market on two exchanges is counted apart (track keys); messages name the market.
    policy = runtime.LiveRefusalPolicy()
    for _ in range(4):
        assert policy.refused("lighter:SOL", margin, 0, label="SOL")[1] is None
    assert policy.refused("hyperliquid:SOL", margin, 0, label="SOL")[1] is None
    assert "5 orders in a row on SOL" in policy.refused("lighter:SOL", margin, 0, label="SOL")[1]
    policy = runtime.LiveRefusalPolicy()
    for _ in range(4):
        assert policy.exit_missed("lighter:SOL", "SOL")[1] is None
    assert policy.exit_missed("hyperliquid:SOL", "SOL")[1] is None
    assert "5 exit orders in a row on SOL" in policy.exit_missed("lighter:SOL", "SOL")[1]

    # Exits canceled without a fill retry after 1, 2, 4 and 8 s; the fifth in a row halts; a fill resets.
    policy = runtime.LiveRefusalPolicy()
    assert [policy.exit_missed("SOL") for _ in range(4)] == [(1_000, None), (2_000, None), (4_000, None), (8_000, None)]
    assert policy.exit_missed("BTC") == (1_000, None)  # per market
    delay, halt = policy.exit_missed("SOL")
    assert delay is None and "5 exit orders in a row on SOL without a fill" in halt, halt
    policy.filled("SOL")
    assert policy.exit_missed("SOL") == (1_000, None)
    print("live refusals follow the Lighter table PASS", flush=True)


def hyperliquid_refusals_and_account():
    """Hyperliquid's refusal texts map to the same groups as Lighter's codes; its account (equity, cash,
    positions) is read over the main dex and xyz from the info API (docs/HYPERLIQUID_LIVE_PLAN.md)."""
    import live_venues
    venue = live_venues.HyperliquidVenue()
    classify = venue.classify
    assert classify("Order could not immediately match against any resting orders. asset=5") == "miss"
    assert classify("No liquidity available for market order") == "miss"
    assert classify("Insufficient margin to place order. asset=5") == "refused"
    assert classify("Order must have minimum value of $10. asset=5") == "refused"
    assert classify("Reduce only order would increase position. asset=5") == "refused"
    assert classify("Too many cumulative requests sent") == "rate_limit"
    assert classify("User or API Wallet 0xabc does not exist.") == "key"
    assert classify("Invalid nonce: duplicate nonce") == "nonce"
    assert classify("Price must be divisible by tick size. asset=5") == "halt"
    assert classify("anything new") == "halt"
    assert classify("whatever", denied=True) == "refused"
    sandbox = live_venues.SandboxVenue(venue)
    assert sandbox.classify("Order could not immediately match against any resting orders.") == "miss"
    assert (sandbox.display, sandbox.state_account, live_venues.SandboxVenue(live_venues.LighterVenue()).state_account) == (
        "Hyperliquid", "sandbox-hyperliquid", "sandbox")

    answers = {
        "": {"marginSummary": {"accountValue": "120.5"}, "assetPositions": [
            {"position": {"coin": "SOL", "szi": "-0.5", "unrealizedPnl": "1.25"}},
            {"position": {"coin": "BTC", "szi": "0.0", "unrealizedPnl": "0"}}]},
        "xyz": {"marginSummary": {"accountValue": "30"}, "assetPositions": [
            {"position": {"coin": "xyz:NVDA", "szi": "0.2", "unrealizedPnl": "-0.75"}}]},
    }
    answers["mode"] = "default"
    answers["spot"] = {"balances": [{"coin": "USDC", "total": "99.5"}, {"coin": "USDE", "total": "0.0"}]}

    def info(body, timeout=5):
        asked.append(body)
        kind = {"userAbstraction": "mode", "spotClearinghouseState": "spot"}.get(body["type"])
        return answers[kind or body.get("dex", "")]

    asked = []
    original = live_venues.hyperliquid_info
    live_venues.hyperliquid_info = info
    try:
        venue.address = "0x" + "ab" * 20
        account = venue.read_account()
    finally:
        live_venues.hyperliquid_info = original
    assert [body.get("dex") for body in asked if body["type"] == "clearinghouseState"] == [None, "xyz"]
    assert asked[0] == {"type": "userAbstraction", "user": venue.address}
    assert account["equity"] == Decimal("150.5") and account["cash"] == Decimal("150.0"), account
    assert account["positions"] == {"hyperliquid:SOL": (Decimal("-0.5"), Decimal("1.25")),
                                    "hyperliquid:xyz:NVDA": (Decimal("0.2"), Decimal("-0.75"))}, account
    assert venue.cash() == Decimal("150.0")  # the read stays in use for HYPERLIQUID_ACCOUNT_MAX_AGE_S
    assert venue.state_account == "hyperliquid-" + venue.address
    # A unified account keeps its USDC in the spot balance for every dex; the perp states show none.
    unified = live_venues.HyperliquidVenue()
    unified.address = venue.address
    answers["mode"] = "unifiedAccount"
    answers[""]["marginSummary"]["accountValue"] = answers["xyz"]["marginSummary"]["accountValue"] = "0.0"
    live_venues.hyperliquid_info = info
    try:
        account = unified.read_account()
        unified.read_account()
    finally:
        live_venues.hyperliquid_info = original
    # Its spot USDC already includes the open PnL (+1.25 SOL, -0.75 NVDA): equity 99.5, cash 99.0.
    assert account["equity"] == Decimal("99.5") and account["cash"] == Decimal("99.0"), account
    assert len(account["positions"]) == 2, account
    assert sum(body["type"] == "userAbstraction" for body in asked) == 2  # once per venue, not per read
    print("hyperliquid refusals and account PASS", flush=True)


def expired_orders_are_handled_as_canceled():
    """Lighter's "canceled-expired" arrives as OrderExpired: it takes the cancel path (miss, paced exit retry)."""
    from types import SimpleNamespace
    import paper_core
    seen = []
    track = SimpleNamespace(_guard=lambda label, action, allow_during_stop: action(),
                            _on_canceled=lambda event: seen.append(event))
    paper_core.TrackStrategy.on_order_expired(track, "expired-event")
    assert seen == ["expired-event"], seen
    print("live expired orders are handled as canceled PASS", flush=True)


def settings_are_refused():
    from types import SimpleNamespace
    import runtime
    with tempfile.TemporaryDirectory(prefix="psr-live-") as tmp:
        folder = Path(tmp)

        def config(tracks=(("lighter", "SOL"),), **changes):
            raw = pine_config(folder, "refuse", list(tracks))
            raw["live"] = {"exchange": "lighter", "dailyLossLimitPercent": "5", "maxLeverage": "3",
                           "exchangeStopPercent": "0.5", "exchangeStopFrom": "strategy_stop",
                           "stateFile": str(folder / "live-daily.json")}
            for key, value in changes.items():
                if key.startswith("live_"):
                    raw["live"][key[5:]] = value
                else:
                    raw[key] = value
            return raw

        def refused(raw, text):
            try:
                runtime.validate_config(raw)
            except ValueError as exc:
                assert text in str(exc), (text, str(exc))
                return
            raise AssertionError(f"accepted: {text}")

        os.environ.pop("PSR_LIVE_ENABLED", None)
        refused(config(mode="public"), "not enabled on this engine")
        refused(config(), "needs public market data")  # offline data with a real exchange
        refused(config(live_exchange="sandbox", mode="public"), "offline tests only")
        refused(config(live_exchange="lighter-testnet"), "live.exchange must be real or sandbox")
        both = runtime.validate_config(config(tracks=(("lighter", "SOL"), ("hyperliquid", "SOL"), ("hyperliquid", "xyz:NVDA")),
                                              live_exchange="sandbox"))
        assert {spec.venue_key for spec in runtime.make_specs(both["tracks"], require_both=False).values()} == {
            "lighter", "hyperliquid"}
        refused(config(live_exchange="sandbox", live_dailyLossLimitPercent="0.5"), "live.dailyLossLimitPercent must be 1..99")
        refused(config(live_exchange="sandbox", live_dailyLossLimitPercent="100"), "live.dailyLossLimitPercent must be 1..99")
        refused(config(live_exchange="sandbox", live_dailyLossLimitUsdc="5"), "live must contain only")
        refused(config(live_exchange="sandbox", live_stateFile=None), "live.stateFile")
        refused(config(live_exchange="sandbox", live_stateFile="live-daily.json"), "live.stateFile")
        refused(config(live_exchange="sandbox", live_maxPositionUsdc="0"), "live.maxPositionUsdc")
        refused(config(live_exchange="sandbox", live_minimumOrderSize="yes"), "live.minimumOrderSize")
        refused(config(live_exchange="sandbox", live_unknown=1), "live must contain only")
        refused(config(live_exchange="sandbox", live_safetyStopBufferPercent="0.3"), "live must contain only")
        refused(config(live_exchange="sandbox", live_network="testnet"), "live must contain only")
        refused(config(live_exchange="sandbox", live_exchangeStopPercent=None), "live.exchangeStopPercent is required")
        refused(config(live_exchange="sandbox", live_exchangeStopPercent="0"), "live.exchangeStopPercent")
        refused(config(live_exchange="sandbox", live_exchangeStopPercent="51"), "at most 50")
        refused(config(live_exchange="sandbox", live_exchangeStopFrom="mark"), "live.exchangeStopFrom")
        refused(config(live_exchange="sandbox", live_maxSlippagePercent="0.01"), "live.maxSlippagePercent must be 0.05..50")
        refused(config(live_exchange="sandbox", live_maxSlippagePercent="60"), "live.maxSlippagePercent must be 0.05..50")
        refused(config(live_exchange="sandbox", live_maxLeverage="0"), "live.maxLeverage")
        refused(config(live_exchange="sandbox", live_maxLeverage="51"), "live.maxLeverage must be at most 50")
        refused(config(nativeStrategy="built_in_v1"), "Pine and Python strategies only")  # any built-in strategy
        os.environ["PSR_LIVE_ENABLED"] = "1"
        try:
            accepted = runtime.validate_config(config(mode="public"))
            assert set(accepted["live"]) == {"exchange", "dailyLossLimitPercent", "maxLeverage", "exchangeStopPercent",
                                             "exchangeStopFrom", "maxSlippagePercent", "stateFile"}, accepted["live"]
            assert accepted["live"]["maxSlippagePercent"] == "3", accepted["live"]  # the default
            assert "maxPositionUsdc" not in accepted["live"], accepted["live"]  # absent: no cap
            capped = runtime.validate_config(config(mode="public", live_maxPositionUsdc="13"))
            assert capped["live"]["maxPositionUsdc"] == "13", capped["live"]
            assert "minimumOrderSize" not in runtime.validate_config(config(mode="public", live_minimumOrderSize=False))["live"]
            # A small sell gets just the allowance that keeps it at Lighter's minimum (first DOGE run, 2026-10-16).
            ten = SimpleNamespace(_instrument=lambda: SimpleNamespace(min_notional=SimpleNamespace(as_decimal=lambda: Decimal("10"))))
            sell_bps = runtime.PineTrackStrategy.live_sell_bps
            assert sell_bps(ten, Decimal("123"), Decimal("0.081418"), 300) == 13  # 10.01 USDC: 0.13 %, not 3 %
            assert Decimal("123") * Decimal("0.081418") * (1 - Decimal("0.0013")) >= 10
            assert sell_bps(ten, Decimal("200"), Decimal("0.081418"), 300) == 300  # enough room: Max slippage
            assert sell_bps(ten, Decimal("100"), Decimal("0.08"), 300) == 1  # worth less than the minimum
            # With the 15 % reserve a minimum long's exchange stop (strategy stop 1 %, 2 % beyond) keeps Max slippage.
            qty = Decimal("142")  # ceil(11.5 / 0.081428)
            assert sell_bps(ten, qty, Decimal("0.081428") * Decimal("0.99") * Decimal("0.98"), 300) == 300
            # Refused closes in a row: 1, 2, 4, 8 s, then every 10 s (live run 04f7d933, 1300 tries in 12 minutes).
            assert [runtime.flatten_retry_s(n) for n in range(0, 7)] == [1.0, 1.0, 2.0, 4.0, 8.0, 10.0, 10.0]
            slippage = runtime.RuntimeController.live_slippage
            assert slippage(SimpleNamespace(live={"maxSlippagePercent": "0.05"})) == {"market_order_slippage_bps": 5}
            assert slippage(SimpleNamespace(live={"maxSlippagePercent": "3"})) == {"market_order_slippage_bps": 300}
            off = runtime.validate_config(config(mode="public", live_dailyLossLimitPercent=None))
            assert "dailyLossLimitPercent" not in off["live"], off["live"]  # empty: no daily limit
        finally:
            os.environ.pop("PSR_LIVE_ENABLED", None)
    print("live settings refused PASS", flush=True)



def live_accounts_read_their_own_keys():
    """Several Live runs at once (owner, 2026-10-20): each names its accounts and their key files; the
    shared daily-limit file keeps every account's entry when runs write it together."""
    import threading
    from decimal import Decimal
    import live_venues
    import runtime
    with tempfile.TemporaryDirectory(prefix="psr-live-accounts-") as tmp:
        folder = Path(tmp)
        lighter_file, hyperliquid_file = folder / "a.env", folder / "b.env"
        lighter_file.write_text("LIGHTER_ACCOUNT_INDEX=7\nLIGHTER_API_KEY_INDEX=5\nLIGHTER_API_SECRET=abc\n", encoding="utf-8")
        hyperliquid_file.write_text("HYPERLIQUID_ACCOUNT_ADDRESS=0x" + "cd" * 20 + "\nHYPERLIQUID_PK=0x" + "1" * 64 + "\n",
                                    encoding="utf-8")
        lighter = {"id": "acc-lighter-1", "name": "Sub 7", "file": str(lighter_file)}
        assert live_venues.live_credentials(lighter) == (7, 5, "abc")
        path, values = live_venues.secrets_file("hyperliquid-mainnet.env", {"id": "acc-hl-01", "name": "HL", "file": str(hyperliquid_file)})
        assert path == hyperliquid_file and values["HYPERLIQUID_ACCOUNT_ADDRESS"] == "0x" + "cd" * 20
        assert live_venues.LighterVenue(lighter).account_note == ' (account "Sub 7")'
        assert live_venues.SandboxVenue(live_venues.LighterVenue(lighter)).account_note == ' (account "Sub 7")'
        assert live_venues.HyperliquidVenue().account_note == ""

        raw = pine_config(folder, "accounts", [("lighter", "SOL")])
        raw["mode"] = "offline"
        raw["live"] = {"exchange": "sandbox", "maxLeverage": "3", "exchangeStopPercent": "0.5",
                       "exchangeStopFrom": "strategy_stop", "stateFile": str(folder / "daily.json"),
                       "accounts": {"lighter": lighter}}
        assert runtime.validate_config(raw)["live"]["accounts"]["lighter"]["name"] == "Sub 7"
        for bad in ({"binance": lighter}, {"lighter": {**lighter, "file": "a.env"}}, {"lighter": {"id": "x", "name": "y"}},
                    {"lighter": {**lighter, "name": "n" * 41}}, ["lighter"]):
            try:
                runtime.validate_config({**raw, "live": {**raw["live"], "accounts": bad}})
            except ValueError as exc:
                assert "live.accounts" in str(exc), exc
            else:
                raise AssertionError(f"accepted accounts {bad}")

        # Two runs writing the day's starting equity at once: no account's entry is lost.
        state = folder / "shared-daily.json"
        period = "2026-10-20T06:00:00+00:00"
        threads = [threading.Thread(target=runtime.live_reference_entry, args=(state, f"lighter-{index}", period, Decimal(100 + index)))
                   for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        stored = json.loads(state.read_text(encoding="utf-8"))["accounts"]
        assert sorted(stored) == sorted(f"lighter-{index}" for index in range(20)), stored
        reference, note = runtime.live_reference_entry(state, "lighter-3", period, Decimal(1))
        assert reference == Decimal(103) and note.startswith("continues the day"), (reference, note)
    print("live accounts read their own keys PASS", flush=True)


if __name__ == "__main__":
    settings_are_refused()
    live_accounts_read_their_own_keys()
    refusals_follow_the_lighter_table()
    hyperliquid_refusals_and_account()
    expired_orders_are_handled_as_canceled()
    asyncio.run(take_profit_closes_the_position())
    asyncio.run(two_exchanges_halt_one_at_a_time())
    asyncio.run(positions_may_exceed_the_balance_up_to_the_leverage())
    asyncio.run(max_position_shrinks_the_entry())
    asyncio.run(minimum_order_size_entry())
    asyncio.run(account_leverage_limits_all_positions())
    asyncio.run(stop_closes_the_open_position())
    asyncio.run(engine_stop_executes_at_once())
    asyncio.run(canceled_exit_retries_after_a_pause())
    asyncio.run(late_fill_after_cancel_is_booked_and_closed())
    asyncio.run(api_gone_still_closes_every_position())
    asyncio.run(exchange_stop_removed_by_lighter_is_not_looped())
    asyncio.run(stop_removed_just_before_the_closing_fill())
    asyncio.run(daily_loss_limit_closes_everything())
    asyncio.run(daily_loss_limit_carries_over_the_day())
    asyncio.run(stop_resends_the_close_for_the_rest())
    asyncio.run(long_data_gap_closes_that_position())
    asyncio.run(daily_loss_counts_lighter_pnl_in_a_gap())
    asyncio.run(exchange_stop_from_the_entry_price())
    asyncio.run(exchange_stop_executes_and_halts())
    asyncio.run(position_check_halts_on_a_difference())
