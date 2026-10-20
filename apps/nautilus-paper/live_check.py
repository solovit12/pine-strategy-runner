"""Read-only connection check of a live Lighter or Hyperliquid account.

Connects with the API key from the environment, lets Nautilus load the account and reconcile
open orders and positions, prints one PSR_LIVE_CHECK= line of JSON (balance, open positions,
open orders) and stops. It never submits, modifies or cancels an order: the probe below has no
order calls at all.

Environment (the app passes the key saved from the setup page; never from project files):
  mainnet: LIGHTER_ACCOUNT_INDEX, LIGHTER_API_KEY_INDEX, LIGHTER_API_SECRET
  testnet: LIGHTER_TESTNET_ACCOUNT_INDEX, LIGHTER_TESTNET_API_KEY_INDEX, LIGHTER_TESTNET_API_SECRET
  Hyperliquid (--exchange hyperliquid): HYPERLIQUID_PK (API wallet key), HYPERLIQUID_ACCOUNT_ADDRESS
  (the main account the API wallet trades for); testnet: HYPERLIQUID_TESTNET_PK.
"""

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request

from nautilus_trader.adapters.hyperliquid import (
    HyperliquidDataClientConfig, HyperliquidDataClientFactory, HyperliquidEnvironment,
    HyperliquidExecutionClientConfig, HyperliquidExecutionClientFactory,
)
from nautilus_trader.adapters.lighter import (
    LighterDataClientConfig, LighterDataClientFactory, LighterDeployment, LighterEnvironment,
    LighterExecutionClientConfig, LighterExecutionClientFactory,
)
from nautilus_trader.common import Environment
from nautilus_trader.config import StrategyConfig
from nautilus_trader.live import LiveNode
from nautilus_trader.model import AccountId, StrategyId, TraderId, Venue
from nautilus_trader.trading import Strategy

VENUE = Venue("LIGHTER")
HYPERLIQUID_INFO = {"mainnet": "https://api.hyperliquid.xyz/info", "testnet": "https://api.hyperliquid-testnet.xyz/info"}
# Perp dexes the app trades on Hyperliquid: the main dex and the HIP-3 dexes Paper offers.
HYPERLIQUID_DEXES = ("", "xyz")
# Hyperliquid's clients load every market and the account before they count as connected; a busy
# server needs more than Nautilus's usual 30 s for that.
CONNECT_TIMEOUT_SECS = 90


def credentials(network):
    prefix = "LIGHTER_TESTNET_" if network == "testnet" else "LIGHTER_"
    missing = [name for name in ("ACCOUNT_INDEX", "API_KEY_INDEX", "API_SECRET") if not os.environ.get(prefix + name)]
    if missing:
        raise SystemExit(f"missing {', '.join(prefix + name for name in missing)} in the environment")
    return int(os.environ[prefix + "ACCOUNT_INDEX"]), int(os.environ[prefix + "API_KEY_INDEX"]), os.environ[prefix + "API_SECRET"]


def hyperliquid_credentials(network):
    name = "HYPERLIQUID_TESTNET_PK" if network == "testnet" else "HYPERLIQUID_PK"
    key, address = os.environ.get(name), os.environ.get("HYPERLIQUID_ACCOUNT_ADDRESS")
    if not key or not address:
        raise SystemExit(f"missing {name} or HYPERLIQUID_ACCOUNT_ADDRESS in the environment")
    return key, address


def hyperliquid_info(network, body):
    request = urllib.request.Request(HYPERLIQUID_INFO[network], data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def hyperliquid_dex_balances(network, address):
    """The account's collateral from the public info API (no key): a unified account keeps its USDC in
    the spot balance for every perp dex, other accounts keep it per dex."""
    try:
        mode = hyperliquid_info(network, {"type": "userAbstraction", "user": address})
        if mode in ("unifiedAccount", "portfolioMargin"):
            spot = hyperliquid_info(network, {"type": "spotClearinghouseState", "user": address})
            usdc = next((row["total"] for row in spot.get("balances") or [] if row.get("coin") == "USDC"), "0")
            return {"unified account USDC (all dexes)": str(usdc)}
    except Exception as exc:  # a missing balance is reported, never guessed
        return {"account": f"unavailable: {type(exc).__name__}"}
    balances = {}
    for dex in HYPERLIQUID_DEXES:
        try:
            state = hyperliquid_info(network, {"type": "clearinghouseState", "user": address, **({"dex": dex} if dex else {})})
            balances[dex or "main"] = str(state["marginSummary"]["accountValue"])
        except Exception as exc:
            balances[dex or "main"] = f"unavailable: {type(exc).__name__}"
    return balances


def text(value):
    return None if value is None else str(value)


class AccountProbe(Strategy):
    """Reads the account after reconciliation; has no order calls."""

    def __init__(self, context):
        # This Strategy takes a single constructor argument, as the Paper strategies do.
        wait_secs, result, venue = context
        super().__init__(StrategyConfig(strategy_id=StrategyId("PSR-LIVECHECK-001")))
        self.wait_secs = wait_secs
        self.venue = venue
        self.result = result

    def on_start(self):
        self.clock.set_time_alert_ns("psr-live-check", time.time_ns() + int(self.wait_secs * 1e9),
                                     callback=self._read, allow_past=True)

    def _read(self, _event):
        account = self.cache.account_for_venue(self.venue)
        balances = []
        if account is not None:
            for balance in account.balances().values():
                balances.append({"currency": str(balance.currency), "total": text(balance.total),
                                 "locked": text(balance.locked), "free": text(balance.free)})
        positions = [{"instrument": str(p.instrument_id), "side": str(p.side), "quantity": text(p.quantity),
                      "avgEntry": text(p.avg_px_open)} for p in self.cache.positions_open(venue=self.venue)]
        orders = [{"instrument": str(o.instrument_id), "side": str(o.side), "type": str(o.order_type),
                   "quantity": text(o.quantity), "price": text(getattr(o, "price", None)),
                   "triggerPrice": text(getattr(o, "trigger_price", None)), "status": str(o.status)}
                  for o in self.cache.orders_open(venue=self.venue)]
        self.result.update({"accountFound": account is not None, "balances": balances,
                            "openPositions": positions, "openOrders": orders})


async def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--network", choices=("mainnet", "testnet"), required=True)
    parser.add_argument("--exchange", choices=("lighter", "hyperliquid"), default="lighter")
    parser.add_argument("--wait-secs", type=float, default=20.0)
    # Startup reconciliation asks the venue for every order, position and recent fill ("mass
    # status"); Lighter can take longer than the engine's default to answer.
    parser.add_argument("--reconcile-timeout", type=int, default=120)
    parser.add_argument("--lookback-mins", type=int, default=60)
    parser.add_argument("--no-reconcile", action="store_true",
                        help="skip startup reconciliation and read the account state the venue streams")
    args = parser.parse_args()
    builder = (LiveNode.builder("PSR-LIVECHECK", TraderId("PSR-LIVECHECK-001"), Environment.LIVE)
               .with_reconciliation(not args.no_reconcile).with_timeout_connection(CONNECT_TIMEOUT_SECS)
               .with_timeout_reconciliation(args.reconcile_timeout)
               .with_reconciliation_lookback_mins(args.lookback_mins).with_delay_post_stop_secs(0))
    summary = {}
    if args.exchange == "hyperliquid":
        venue = Venue("HYPERLIQUID")
        key, address = hyperliquid_credentials(args.network)
        environment = HyperliquidEnvironment.TESTNET if args.network == "testnet" else HyperliquidEnvironment.MAINNET
        builder = builder.add_data_client(
            "HYPERLIQUID", HyperliquidDataClientFactory(), HyperliquidDataClientConfig(environment=environment))
        builder = builder.add_exec_client(
            "HYPERLIQUID", HyperliquidExecutionClientFactory(),
            HyperliquidExecutionClientConfig(
                account_id=AccountId("HYPERLIQUID-001"), private_key=key, account_address=address,
                environment=environment, include_builder_attribution=False))
        del key
        summary = {"accountAddress": address, "dexBalances": hyperliquid_dex_balances(args.network, address)}
    else:
        venue = VENUE
        account_index, api_key_index, secret = credentials(args.network)
        environment = LighterEnvironment.TESTNET if args.network == "testnet" else LighterEnvironment.MAINNET
        builder = builder.add_data_client(
            "LIGHTER", LighterDataClientFactory(),
            LighterDataClientConfig(environment=environment, deployment=LighterDeployment.LIGHTER))
        builder = builder.add_exec_client(
            "LIGHTER", LighterExecutionClientFactory(),
            LighterExecutionClientConfig(
                account_id=AccountId(f"LIGHTER-{account_index}"), account_index=account_index,
                api_key_index=api_key_index, private_key=secret, environment=environment,
                deployment=LighterDeployment.LIGHTER))
        del secret
        summary = {"accountIndex": account_index, "apiKeyIndex": api_key_index}
    node = builder.build()
    result = {}
    node.add_strategy(AccountProbe((args.wait_secs, result, venue)))

    task = asyncio.create_task(node.run_async())
    deadline = time.monotonic() + args.wait_secs + args.reconcile_timeout + 60
    while not result and not task.done() and time.monotonic() < deadline:
        await asyncio.sleep(0.5)
    try:
        node.stop()
    except RuntimeError:
        pass  # the node already stopped on its own, e.g. after a failed connection
    # A stop request may wait for the run loop; cancelling the run shuts the node down gracefully at once.
    await asyncio.wait({task}, timeout=5)
    if not task.done():
        task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception as exc:  # report, never hide, why the node stopped
        result.setdefault("error", str(exc) or type(exc).__name__)
    result.update({"network": args.network, "exchange": args.exchange, **summary,
                   "reconciliation": not args.no_reconcile,
                   "completed": "accountFound" in result})
    print("PSR_LIVE_CHECK=" + json.dumps(result), flush=True)
    return 0 if result.get("accountFound") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
