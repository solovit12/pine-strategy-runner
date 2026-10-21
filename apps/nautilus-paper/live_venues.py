"""Exchanges a Live run trades on (docs/HYPERLIQUID_LIVE_PLAN.md).

Each exchange knows its credentials file, its execution client, how to read its account's positions
for the position check, and how to read an order refusal. The engine keeps one of these per exchange
of a run; the offline tests use `SandboxVenue`, which fills on the Nautilus Sandbox but reads refusals
the way the real exchange would.
"""

import json
import os
import re
import threading
import time
import urllib.request
from decimal import Decimal
from pathlib import Path

from nautilus_trader.adapters.hyperliquid import (
    HyperliquidEnvironment, HyperliquidExecutionClientConfig, HyperliquidExecutionClientFactory,
)
from nautilus_trader.adapters.lighter import (
    LighterDeployment, LighterEnvironment, LighterExecutionClientConfig, LighterExecutionClientFactory,
)
from nautilus_trader.model import AccountId

from data_bridge import track_key

LIGHTER_REST = "https://mainnet.zklighter.elliot.ai"

# Exchange refusals in Live, by Lighter error code (apidocs.lighter.xyz, "Data Structures, Constants
# and Errors"; owner decision 2026-10-15, see docs/LIVE_TRADING_DESIGN.md "Exchange refusals").
LIGHTER_ERROR_GROUPS = {
    # Trading refusals, nothing opened: the market pauses, the refusal is counted.
    **dict.fromkeys((21739, 21301, 21507, 21508, 21732, 21738, 21733, 21734, 21601), "refused"),
    # Rate limits, nothing opened: no new entries in the whole run for a while; counted.
    **dict.fromkeys((23000, 21506, 30009, 30010), "rate_limit"),
    # The order may have executed: the market sends nothing until the position check confirms.
    **dict.fromkeys((29500, 29501), "unknown_outcome"),
    # Nonce out of step, nothing opened: the Lighter client refreshes it; counted.
    **dict.fromkeys((21104, 21105), "nonce"),
    # The API key or its signature is not accepted: nothing can be traded, closing may fail too.
    **dict.fromkeys((21108, 21109, 21110, 21120, 20013), "key"),
    # Liquidation, an account restriction, a bad order of ours or a closed market: halt.
    **dict.fromkeys((21111, 21112, 52002, 23100, 52001, 21701, 21702, 21704, 21705, 21706, 21727, 21728,
                     21602, 21605, 21618, 20008), "halt"),
}
# A sequencer refusal of an acknowledged order carries Lighter's message without its code.
LIGHTER_ERROR_MESSAGES = {
    "not enough margin to create the order": 21739, "not enough collateral": 21301,
    "below maintenance margin": 21507, "below initial margin": 21508, "reduce only increases position": 21732,
    "invalid reduce only direction": 21738, "accidental price": 21733, "too far from the mark price": 21734,
    "order book is full": 21601, "too many pending txs": 21506, "too many request": 23000,
    "batch transaction nonce is not increasing": 21105, "invalid nonce": 21104, "invalid signature": 21120,
    "api key not found": 21109, "invalid api key index": 21110, "pre-liquidation": 21111,
    "account is in liquidation": 21112, "invalid base amount": 21701, "invalid price": 21702,
    "invalid order base or quote amount": 21706, "client order index already exists": 21728,
    "invalid market index": 21602, "invalid market status": 21605, "order book does not exist": 20008,
    "process timeout": 29501, "internal server error": 29500,
    "too far from the trigger price": 21735,
}
# Lighter limits how far a stop's worst price may sit from its trigger (error 21735; the limit is
# not published): a refused exchange-side stop is placed again with 1 %, then 0.5 % before the run halts.
LIGHTER_STOP_FALLBACK_BPS = (100, 50)


def lighter_error_code(reason):
    """Lighter's error code in an order refusal ("LIGHTER_21739: ..." or its known message), or None."""
    match = re.search(r"LIGHTER_(\d+)", reason)
    if match:
        return int(match.group(1))
    text = reason.lower()
    return next((code for message, code in LIGHTER_ERROR_MESSAGES.items() if message in text), None)


def secrets_file(name, account=None):
    """The credentials file: the run's Live account's own file (Accounts page) when the run names one;
    otherwise (runs from before accounts) the app's own folder, then a server-managed closed folder.
    No message here ever contains a secret."""
    if account is not None:
        path = Path(account["file"])
    else:
        folders = [Path(folder) for folder in (os.environ.get("PSR_LIVE_SECRETS_DIR"), "/etc/psr-secrets") if folder]
        path = next((folder / name for folder in folders if (folder / name).is_file()), folders[0] / name)
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return path, values


def live_credentials(account=None):
    """Lighter: account index, API key index and API secret from the credentials file on this machine."""
    path, values = secrets_file("lighter-mainnet.env", account)
    prefix = "LIGHTER_"
    try:
        account_index, key_index = int(values[prefix + "ACCOUNT_INDEX"]), int(values[prefix + "API_KEY_INDEX"])
        secret = values[prefix + "API_SECRET"]
    except (KeyError, ValueError):
        raise ValueError(f"Live credentials are incomplete in {path}") from None
    if not secret:
        raise ValueError(f"Live API secret is empty in {path}")
    return account_index, key_index, secret


def lighter_positions(account_index):
    """Signed position and open PnL per market from Lighter's public account snapshot (no API key)."""
    url = f"{LIGHTER_REST}/api/v1/account?by=index&value={int(account_index)}&active_only=true"
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        body = json.loads(response.read())
    accounts = body.get("accounts") or []
    if body.get("code") != 200 or len(accounts) != 1:
        raise ValueError(f"unexpected Lighter account answer (code {body.get('code')})")
    positions = {}
    for row in accounts[0].get("positions") or []:
        size = Decimal(str(row["position"]))
        if size:
            pnl = row.get("unrealized_pnl")
            positions[str(row["symbol"])] = (-size if int(row["sign"]) < 0 else size,
                                             Decimal(str(pnl)) if pnl not in (None, "") else None)
    return positions


class LiveVenue:
    """One exchange of a Live run."""

    key = None  # the venue key of data_bridge.SPECS
    display = None  # the exchange as messages name it
    sandbox = False
    stop_fallback_bps = ()  # narrower exchange-side stop caps tried when the exchange refuses the cap
    live_account = None  # the run's Live account on this exchange: {"id", "name", "file"} (None: before accounts)

    @property
    def account_note(self):
        """The run's account on this exchange as the start message names it ("" before accounts)."""
        return f' (account "{self.live_account["name"]}")' if self.live_account else ""

    def classify(self, reason, denied=False):
        """What a refusal is: refused, rate_limit, unknown_outcome, nonce, key, halt or unknown."""
        if denied:
            return "refused"  # refused by the engine itself before sending: nothing reached the exchange
        return self._classify(reason)

    def _classify(self, reason):
        raise NotImplementedError

    def stop_cap_refused(self, reason):
        """The exchange refused the exchange-side stop only for its price cap (a narrower one may pass)."""
        return False

    def cash(self):
        """The account's cash when the exchange reports it outside Nautilus; None: Nautilus's balance."""
        return None


class LighterVenue(LiveVenue):
    key = "lighter"
    display = "Lighter"
    stop_fallback_bps = LIGHTER_STOP_FALLBACK_BPS

    def __init__(self, account=None):
        self.live_account = account
        self.account_index = None

    @property
    def state_account(self):
        """The account the daily loss limit's state belongs to."""
        return f"lighter-{self.account_index}"

    def add_exec_client(self, builder, source_venue):
        account_index, key_index, secret = live_credentials(self.live_account)
        self.account_index = account_index
        builder = builder.add_exec_client(
            str(source_venue), LighterExecutionClientFactory(),
            LighterExecutionClientConfig(
                account_id=AccountId(f"LIGHTER-{account_index}"), account_index=account_index,
                api_key_index=key_index, private_key=secret,
                environment=LighterEnvironment.MAINNET,
                deployment=LighterDeployment.LIGHTER,
            ))
        del secret
        return builder

    def fetch_positions(self):
        """(signed position, open PnL or None) per track key, from the public account snapshot."""
        return {track_key("lighter", market): row for market, row in lighter_positions(self.account_index).items()}

    def _classify(self, reason):
        code = lighter_error_code(reason)
        if code is None:
            # The Lighter client could not send the order at all (an unknown outcome never arrives as a refusal).
            return "refused" if "dispatch failed" in reason else "unknown"
        return LIGHTER_ERROR_GROUPS.get(code, "unknown")

    def stop_cap_refused(self, reason):
        return lighter_error_code(reason) == 21735


HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info"
# Perp dexes a Live run trades on Hyperliquid: the main dex and the HIP-3 dexes Paper offers (USDC collateral).
HYPERLIQUID_DEXES = ("", "xyz")
# The account read from the info API is reused for this long by the leverage and daily limits between
# position checks; an older one is read again first.
HYPERLIQUID_ACCOUNT_MAX_AGE_S = 30
# Account modes whose USDC is the spot balance (the info API's userAbstraction); others keep it per perp dex.
HYPERLIQUID_SPOT_COLLATERAL_MODES = ("unifiedAccount", "portfolioMargin")
# Refusals Hyperliquid sends as text (Nautilus rc7, docs/HYPERLIQUID_LIVE_PLAN.md), lowercase substrings,
# first match wins. "miss": an IOC that met no resting order — not a refusal, it ends like a canceled IOC.
HYPERLIQUID_REFUSALS = (
    ("could not immediately match", "miss"), ("no liquidity available for market order", "miss"),
    ("too many", "rate_limit"), ("rate limit", "rate_limit"),
    ("nonce", "nonce"),
    ("user or api wallet", "key"), ("does not exist.", "key"), ("invalid signature", "key"), ("auth error", "key"),
    ("insufficient margin", "refused"), ("minimum value of $10", "refused"),
    ("reduce only order would increase", "refused"), ("open interest", "refused"), ("openinterest", "refused"),
    ("max position", "refused"), ("oracle", "refused"), ("away from the reference price", "refused"),
    ("shutting down", "refused"),
)


def hyperliquid_info(body, timeout=5):
    request = urllib.request.Request(HYPERLIQUID_INFO, data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


class HyperliquidVenue(LiveVenue):
    """Hyperliquid: an API (agent) wallet trades for the main account. The account's value comes from
    the info API, not from Nautilus's balance (which moves with an open position's notional): the spot
    USDC of a unified account, otherwise the collateral each perp dex holds."""

    key = "hyperliquid"
    display = "Hyperliquid"

    def __init__(self, account=None):
        self.live_account = account
        self.address = None
        self._account = None  # (monotonic time, {"equity", "cash", "positions"})
        self._spot_collateral = None
        self._lock = threading.Lock()

    @property
    def state_account(self):
        return f"hyperliquid-{self.address}"

    def add_exec_client(self, builder, source_venue):
        path, values = secrets_file("hyperliquid-mainnet.env", self.live_account)
        key, address = values.get("HYPERLIQUID_PK", ""), values.get("HYPERLIQUID_ACCOUNT_ADDRESS", "")
        if not key or not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
            raise ValueError(f"Hyperliquid Live credentials are incomplete in {path}")
        self.address = address.lower()
        builder = builder.add_exec_client(
            str(source_venue), HyperliquidExecutionClientFactory(),
            HyperliquidExecutionClientConfig(
                account_id=AccountId("HYPERLIQUID-001"), private_key=key, account_address=self.address,
                environment=HyperliquidEnvironment.MAINNET,
                # Attribution needs a separate builder-fee approval of the main wallet; orders go without it.
                include_builder_attribution=False,
            ))
        del key
        return builder

    def spot_collateral(self):
        """True for a unified or portfolio-margin account: its USDC sits in the spot balance and backs
        every perp dex, while the per-dex perp states show no collateral. Read once per run."""
        if self._spot_collateral is None:
            mode = hyperliquid_info({"type": "userAbstraction", "user": self.address})
            self._spot_collateral = mode in HYPERLIQUID_SPOT_COLLATERAL_MODES
        return self._spot_collateral

    def read_account(self):
        """Equity, cash (equity without open PnL) and positions over the dexes this run trades on."""
        equity, upnl, positions = Decimal("0"), Decimal("0"), {}
        if self.spot_collateral():
            spot = hyperliquid_info({"type": "spotClearinghouseState", "user": self.address})
            equity = next((Decimal(str(row["total"])) for row in spot.get("balances") or []
                           if row.get("coin") == "USDC"), Decimal("0"))
        for dex in HYPERLIQUID_DEXES:
            state = hyperliquid_info({"type": "clearinghouseState", "user": self.address, **({"dex": dex} if dex else {})})
            if not self.spot_collateral():
                equity += Decimal(str(state["marginSummary"]["accountValue"]))
            for row in state.get("assetPositions") or []:
                position = row.get("position") or {}
                size = Decimal(str(position.get("szi") or "0"))
                if size:
                    pnl = Decimal(str(position.get("unrealizedPnl") or "0"))
                    upnl += pnl
                    positions[track_key("hyperliquid", str(position["coin"]))] = (size, pnl)
        # A unified account's spot USDC already moves with the open positions' PnL (live 2026-10-20: spot
        # 100.3997 = 100.2824 after closed trades and fees + 0.1174 open on ZEC and ZRO): it is the equity.
        account = {"equity": equity, "cash": equity - upnl, "positions": positions}
        with self._lock:
            self._account = (time.monotonic(), account)
        return account

    def fetch_positions(self):
        return self.read_account()["positions"]

    def account(self):
        """The last account read, read again when older than HYPERLIQUID_ACCOUNT_MAX_AGE_S."""
        with self._lock:
            cached = self._account
        if cached is None or time.monotonic() - cached[0] > HYPERLIQUID_ACCOUNT_MAX_AGE_S:
            return self.read_account()
        return cached[1]

    def cash(self):
        return self.account()["cash"]

    def _classify(self, reason):
        text = reason.lower()
        return next((group for needle, group in HYPERLIQUID_REFUSALS if needle in text), "halt")


class SandboxVenue(LiveVenue):
    """Offline tests: the Nautilus Sandbox stands in for an exchange and fills its orders, while refusals
    are read the way that exchange would read them."""

    sandbox = True
    state_account = "sandbox"

    def __init__(self, real):
        self.real = real
        self.key = real.key
        self.display = real.display
        self.live_account = real.live_account
        self.stop_fallback_bps = real.stop_fallback_bps
        # Two exchanges in one offline run keep their daily limits apart; Lighter keeps the old name.
        self.state_account = "sandbox" if real.key == "lighter" else f"sandbox-{real.key}"

    def _classify(self, reason):
        return self.real._classify(reason)

    def stop_cap_refused(self, reason):
        return self.real.stop_cap_refused(reason)


REAL_VENUES = {"lighter": LighterVenue, "hyperliquid": HyperliquidVenue}


def classify_live_refusal(reason, denied=False):
    """Lighter's reading of a refusal (kept for callers that predate the per-exchange venues)."""
    return LighterVenue().classify(reason, denied)
