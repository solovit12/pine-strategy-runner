"""Multi-market Nautilus Sandbox sidecar with one shared account per venue.

Only official public venue DataClients and simulated Sandbox execution clients
are registered. Venue credentials are removed before client construction. The
child exits on stdin EOF or parent death; an interrupted child is never resumed.
"""

import argparse
import asyncio
from collections import deque
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_UP
import errno
import json
import os
from pathlib import Path
import re
import signal as os_signal
import sys
import time
import urllib.request

import nautilus_trader
import nautilus_trader.adapters.hyperliquid as hyperliquid_adapter
from nautilus_trader.adapters.hyperliquid import (
    HyperliquidDataClientConfig, HyperliquidDataClientFactory, HyperliquidEnvironment,
)
from nautilus_trader.adapters.lighter import (
    LighterDataClientConfig, LighterDataClientFactory, LighterDeployment, LighterEnvironment,
    LighterExecutionClientConfig, LighterExecutionClientFactory,
)
from nautilus_trader.adapters.sandbox import SandboxExecutionClientConfig, SandboxExecutionClientFactory
from nautilus_trader.common import Environment
from nautilus_trader.config import DataClientConfig
from nautilus_trader.execution import MakerTakerFeeModel
from nautilus_trader.live import LiveNode, RoutingConfig
from nautilus_trader.model import (
    AccountId, AccountType, BookType, ClientId, ClientOrderId, Money, OmsType, OrderSide, Quantity, TimeInForce,
    TraderId,
)

from data_bridge import (
    OfflineSourceFactory, PaperFeedFactory, PublicBridge, SPECS, USDC, make_specs, track_key,
)
from pine_orders import PineOrderManager, outward_price
from psr_sdk import Instrument, resolve_params
from psr_sdk.packs import load_strategy
from psr_sdk.runner import StrategyRunner
from paper_core import (
    ACTIVE_ORDER_STATES, ENTRY_BOOK_WINDOW_MS, ENTRY_MAX_WAIT_MS, SOURCE_CLOCK_SKEW_NS, TrackStrategy, decimal_string,
    now_ms, positive, validate_common,
)
from diagnostics import DecisionDiagnostics


PINNED_NAUTILUS = "2.0.0rc7"
PINNED_FAST_NAUTILUS = "2.0.0rc7+hlfast5.1"
RECOVERY_PROGRESS_MS = 30_000
# A reconnected market without a fresh book is revived on its own: resubscribe its book
# (the venue answers with a full snapshot) after these waits, the last one repeating.
# The venue socket is never reconnected for one market: that would pause the healthy ones.
REVIVE_DELAYS_MS = (10_000, 30_000, 60_000, 300_000)
# Runs now continue across UTC days; bound per-run journal growth instead.
OUTBOX_CAP_BYTES = 512 * 1024 * 1024
SNAPSHOT_IDLE_MS = 15_000


def require_fast_book_support():
    # The stock pinned adapter silently ignores unknown subscription params.
    # This marker is exported by the patched native module, not a config file.
    if (nautilus_trader.__version__ != PINNED_FAST_NAUTILUS
            or getattr(hyperliquid_adapter, "HYPERLIQUID_FAST_BOOK_SUPPORTED", False) is not True):
        raise ValueError("Hyperliquid fast book requires the separately qualified native fast-book build")


def utc_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class EventEmitter:
    def __init__(self, run_id: str, output_fd: int, outbox_path: Path):
        self.run_id = run_id
        self.output_fd = output_fd
        self.seq = 0
        self.bytes_written = 0
        self.outbox_fd = os.open(str(outbox_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        self.on_failure = None
        # The controlling API reads output_fd; when it is gone the outbox file keeps every event.
        self.on_output_closed = None
        self.output_closed = False
        # Live: every line is still written at once, but forced to disk (fsync) by the watchdog
        # and at close instead of per line, so no order waits for the disk.
        self.defer_fsync = False
        self.unsynced = False

    def sync(self):
        if self.unsynced:
            os.fsync(self.outbox_fd)
            self.unsynced = False

    def close(self):
        try:
            self.sync()
        finally:
            os.close(self.outbox_fd)

    @staticmethod
    def _write_full(fd, content):
        view = memoryview(content)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("event stream write made no progress")
            view = view[written:]

    def emit(self, event_type: str, **fields):
        self.seq += 1
        item = {"v": 1, "seq": self.seq, "at": utc_iso(), "type": event_type,
                "runId": self.run_id, **fields}
        if item.get("venue", "__absent__") is None:
            item.pop("venue")
        payload = (json.dumps(item, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        if self.bytes_written + len(payload) > OUTBOX_CAP_BYTES:
            error = OSError("Paper event outbox reached 512 MiB cap")
            if self.on_failure:
                self.on_failure(error)
            raise error
        try:
            self._write_full(self.outbox_fd, payload)
            if self.defer_fsync:
                self.unsynced = True
            else:
                os.fsync(self.outbox_fd)
            self.bytes_written += len(payload)
        except OSError as exc:
            if self.on_failure:
                self.on_failure(exc)
            raise
        if self.output_closed:
            return
        try:
            self._write_full(self.output_fd, b"PSR_EVENT=" + payload)
        except OSError as exc:
            # The controlling API is gone (broken pipe): not an engine failure. The run stops, and a
            # Live run still closes every position; the outbox file above keeps the record.
            self.output_closed = True
            if self.on_output_closed:
                self.on_output_closed(exc)


def write_child_identity(run_id: str, parent_pid: int, directory: Path):
    path = directory / "nautilus-child.json"
    content = (json.dumps({"experimentId": run_id, "childPid": os.getpid(),
                           "parentPid": parent_pid}, separators=(",", ":")) + "\n").encode()
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        EventEmitter._write_full(fd, content)
        os.fsync(fd)
    finally:
        os.close(fd)
    dir_fd = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


PINE_STRATEGY = "pine_orders_v1"
PINE_TIMEFRAMES_MS = (60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000, 604_800_000)


def validate_pine_config(raw: dict):
    """Generic Pine strategy: orders arrive from the API after every closed bar."""
    validate_common(raw)
    specs = make_specs(raw.get("tracks"), require_both=False)
    if raw.get("timeframeMs") not in PINE_TIMEFRAMES_MS:
        raise ValueError("timeframeMs must be a supported Pine timeframe")
    percent = positive(raw.get("orderSizePercent"), "orderSizePercent")
    if percent > Decimal("100"):
        raise ValueError("orderSizePercent must be 0..100")
    raw["orderSizePercent"] = decimal_string(percent)
    ticks = raw.get("minticks")
    if not isinstance(ticks, dict) or set(ticks) != set(specs):
        raise ValueError("minticks must cover exactly the selected tracks")
    for key, value in ticks.items():
        tick = positive(value, f"{key} mintick")
        ticks[key] = decimal_string(tick)
    validate_live(raw)
    return raw


PYTHON_STRATEGY = "python_strategy_v1"

# ----- Live trading (real orders on Lighter; see docs/LIVE_TRADING_DESIGN.md) ---------------

# Live trades Lighter mainnet only (owner decision 2026-10-15: no testnet).
LIVE_KEYS = {"dailyLossLimitPercent", "maxLeverage", "exchangeStopPercent", "exchangeStopFrom", "maxSlippagePercent",
             "maxPositionUsdc", "minimumOrderSize", "stateFile", "exchange"}
# Daily loss limit (owner decision 2026-10-16): the account equity (balance plus the open PnL of the
# run's positions, gains included) against the equity captured at the first start of the day. The
# day starts at 06:00 UTC. The reference is kept in live.stateFile on the server, so a new run, a
# restart or an update the same day continues from it. Absent: no daily limit.
LIVE_DAY_START_HOUR_UTC = 6
LIVE_DAILY_LOSS_PERCENT_RANGE = (Decimal("1"), Decimal("99"))
# The exchange-side stop: N % beyond the strategy's stop (or the average entry), set at launch.
LIVE_EXCHANGE_STOP_FROM = ("strategy_stop", "entry_price")
LIVE_MAX_EXCHANGE_STOP_PERCENT = Decimal("50")
# Highest account leverage a Live run may be given (Lighter's own per-market maximum is higher).
LIVE_MAX_LEVERAGE = Decimal("50")
# Seconds a Live stop waits for its market closes to fill before reporting what stayed open.
LIVE_FLATTEN_WAIT_S = 30
# A stop re-sends a close for what is still open after each cancel, refusal or partial fill of the
# previous one (owner decision 2026-10-15), this long after its answer, per market. A close without
# any answer this long is treated as lost (reduce-only: a second one can never close too much).
LIVE_FLATTEN_RETRY_S = 1.0
LIVE_FLATTEN_SILENT_S = 5.0
# Closes refused in a row (not sent by the Lighter module, e.g. "nonce refresh is in progress" for
# 12 minutes after a reconnect, live run 04f7d933, 2026-10-18) are re-sent after 1, 2, 4, 8 s, then
# every 10 s, instead of every second.
LIVE_FLATTEN_RETRY_MAX_S = 10.0


def flatten_retry_s(refusals):
    """Pause before the next close after `refusals` refusals in a row."""
    return min(LIVE_FLATTEN_RETRY_MAX_S, LIVE_FLATTEN_RETRY_S * 2 ** max(0, refusals - 1))
# A market without verified data cannot run its engine-held exits: after this long with a position
# open its position is closed at market (Lighter matches without our prices); the other markets go
# on trading (owner decision 2026-10-15). Its open loss meanwhile comes from Lighter's account.
LIVE_GAP_CLOSE_S = 60
LIVE_EXCHANGE_PNL_MAX_AGE_S = 30
# Max slippage (owner decision 2026-10-16): Lighter needs a worst price on every market-style order,
# and the Lighter client derives it from the quote (or a stop's trigger) and 0.5 % unless told. A
# gap or a fast move past it cancels the order ("too much slippage"). Every market order of a Live
# run (the strategy's market exits and entries, the exchange-side stop, the closes on stop, halt or
# a data gap) allows live.maxSlippagePercent, 3 % unless set (0.05 to 50). Limit orders keep their price.
LIVE_DEFAULT_SLIPPAGE_PERCENT = Decimal("3")
LIVE_SLIPPAGE_PERCENT_RANGE = (Decimal("0.05"), Decimal("50"))
# Lighter limits how far a stop's worst price may sit from its trigger (error 21735; the limit is
# not published): a refused exchange-side stop is placed again with 1 %, then 0.5 % before the run halts.
LIVE_SAFETY_FALLBACK_BPS = (100, 50)
# Minimum order size (owner decision 2026-10-16, after the first DOGE run): 15 % above Lighter's minimum
# notional. The Lighter module refuses every order below the minimum at its worst price, closes and the
# exchange-side stop included; a long's stop and market close sell below the entry, so an entry at
# exactly the minimum could be neither protected nor closed.
LIVE_MINIMUM_RESERVE = Decimal("1.15")
# The exchange-side stop removed by Lighter itself: when the price has crossed it (it triggered and
# was canceled) or it happens again this soon, the engine closes the position and halts instead of
# placing it again and again.
LIVE_SAFETY_LOST_REPEAT_S = 60
# Lighter also removes a reduce-only stop itself when its position closes, and that cancel can arrive
# a few milliseconds before the closing fill (seen on the first Live run, 2026-10-16): a stop removed
# by Lighter is judged only after this grace, once the fill had time to arrive.
LIVE_SAFETY_LOST_GRACE_S = 2.0
# Position check: Lighter's advice is to trust the account snapshot after a reconnect. Every few
# seconds each idle market's position is compared with the account's; two differences in a row,
# or an order the exchange has not answered, halt the run. The public account endpoint needs no key.
LIVE_POSITION_CHECK_S = 10
LIVE_POSITION_MISMATCHES_TO_HALT = 2
LIVE_ORDER_NO_ANSWER_S = 30
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
LIVE_REFUSAL_PAUSE_MS = 1_000
LIVE_RATE_LIMIT_PAUSE_MS = 30_000
LIVE_MAX_REFUSALS_IN_ROW = 5  # per market
LIVE_MAX_REFUSALS_WINDOW = 10  # per run within LIVE_REFUSAL_WINDOW_MS
LIVE_REFUSAL_WINDOW_MS = 600_000
LIVE_MAX_NONCE_ERRORS_IN_ROW = 3
LIVE_UNCONFIRMED_MAX_MS = 30_000
# An exit Lighter canceled without a fill (a refusal arrives as a cancel without its reason) retries
# after a growing pause instead of at once; five in a row on a market halt the run.
LIVE_EXIT_RETRY_DELAYS_MS = (1_000, 2_000, 4_000, 8_000, 10_000)
LIVE_MAX_EXIT_MISSES = 5


def lighter_error_code(reason):
    """Lighter's error code in an order refusal ("LIGHTER_21739: ..." or its known message), or None."""
    match = re.search(r"LIGHTER_(\d+)", reason)
    if match:
        return int(match.group(1))
    text = reason.lower()
    return next((code for message, code in LIGHTER_ERROR_MESSAGES.items() if message in text), None)


def classify_live_refusal(reason, denied=False):
    """What a Live refusal is: refused, rate_limit, unknown_outcome, nonce, key, halt or unknown."""
    if denied:
        return "refused"  # refused by the engine itself before sending: nothing reached the exchange
    code = lighter_error_code(reason)
    if code is None:
        # The Lighter client could not send the order at all (an unknown outcome never arrives as a refusal).
        return "refused" if "dispatch failed" in reason else "unknown"
    return LIGHTER_ERROR_GROUPS.get(code, "unknown")


class LiveRefusalPolicy:
    """Counts Live refusals and says when the run must halt (docs/LIVE_TRADING_DESIGN.md)."""

    def __init__(self):
        self.in_row = {}
        self.recent = deque()
        self.nonce_in_row = 0
        self.entries_paused_until_ms = 0
        self.exit_misses = {}

    def filled(self, market):
        self.in_row[market] = 0
        self.exit_misses[market] = 0
        self.nonce_in_row = 0

    def exit_missed(self, market):
        """An exit canceled without a fill: the pause before its next try, or why the run must halt."""
        misses = self.exit_misses[market] = self.exit_misses.get(market, 0) + 1
        if misses >= LIVE_MAX_EXIT_MISSES:
            return None, f"Lighter canceled {misses} exit orders in a row on {market} without a fill"
        return LIVE_EXIT_RETRY_DELAYS_MS[min(misses, len(LIVE_EXIT_RETRY_DELAYS_MS)) - 1], None

    def refused(self, market, reason, at_ms, denied=False):
        """The refusal's group and, when the run must halt, why."""
        group = classify_live_refusal(reason, denied)
        if group == "unknown_outcome":
            return group, None
        if group == "key":
            return group, (f"Lighter does not accept the API key or its signature ({reason}); closing may fail too, "
                           "check the positions in the Lighter app")
        if group in ("halt", "unknown"):
            return group, f"Lighter refused an order on {market} ({reason})"
        if group == "rate_limit":
            self.entries_paused_until_ms = at_ms + LIVE_RATE_LIMIT_PAUSE_MS
        self.nonce_in_row = self.nonce_in_row + 1 if group == "nonce" else 0
        self.in_row[market] = self.in_row.get(market, 0) + 1
        self.recent.append(at_ms)
        while self.recent and self.recent[0] <= at_ms - LIVE_REFUSAL_WINDOW_MS:
            self.recent.popleft()
        if self.nonce_in_row >= LIVE_MAX_NONCE_ERRORS_IN_ROW:
            return group, f"Lighter refused {self.nonce_in_row} orders in a row for the order number (nonce)"
        if self.in_row[market] >= LIVE_MAX_REFUSALS_IN_ROW:
            return group, f"Lighter refused {self.in_row[market]} orders in a row on {market} (last: {reason})"
        if len(self.recent) >= LIVE_MAX_REFUSALS_WINDOW:
            return group, f"Lighter refused {len(self.recent)} orders within 10 minutes (last: {reason})"
        return group, None


def validate_live(raw: dict):
    """Live settings of a run, or nothing for Paper.

    `exchange` is "lighter" (real orders, real money) or "sandbox": the same Live code path
    against a simulator registered on the LIGHTER venue, for offline tests only.
    """
    live = raw.get("live")
    if live is None:
        return
    if not isinstance(live, dict) or set(live) - LIVE_KEYS:
        raise ValueError(f"live must contain only {', '.join(sorted(LIVE_KEYS))}")
    exchange = live.setdefault("exchange", "lighter")
    if exchange == "sandbox":
        if raw.get("mode") != "offline":
            raise ValueError("the sandbox Live exchange is for offline tests only")
    elif exchange == "lighter":
        if raw.get("mode", "public") != "public":
            raise ValueError("Live trading needs public market data")
        if os.environ.get("PSR_LIVE_ENABLED") != "1":
            raise ValueError("Live trading is not enabled on this engine (PSR_LIVE_ENABLED)")
    else:
        raise ValueError("live.exchange must be lighter or sandbox")
    if any(spec.venue_key != "lighter" for spec in make_specs(raw.get("tracks"), require_both=False).values()):
        raise ValueError("Live trading supports Lighter markets only")
    if live.get("dailyLossLimitPercent") is None:
        live.pop("dailyLossLimitPercent", None)  # off
    else:
        try:
            loss = Decimal(str(live["dailyLossLimitPercent"]))
        except ArithmeticError:
            loss = Decimal("NaN")
        low, high = LIVE_DAILY_LOSS_PERCENT_RANGE
        if not loss.is_finite() or not low <= loss <= high:
            raise ValueError(f"live.dailyLossLimitPercent must be {low}..{high} percent, or absent for no limit")
        live["dailyLossLimitPercent"] = decimal_string(loss)
    try:
        slippage = Decimal(str(live.get("maxSlippagePercent", LIVE_DEFAULT_SLIPPAGE_PERCENT)))
    except ArithmeticError:
        slippage = Decimal("NaN")
    low, high = LIVE_SLIPPAGE_PERCENT_RANGE
    if not slippage.is_finite() or not low <= slippage <= high:
        raise ValueError(f"live.maxSlippagePercent must be {low}..{high} percent")
    live["maxSlippagePercent"] = decimal_string(slippage)
    # Max position (owner decision 2026-10-16): optional per-market cap in USDC; an entry shrinks to fit.
    if live.get("maxPositionUsdc") is None:
        live.pop("maxPositionUsdc", None)
    else:
        cap = positive(live["maxPositionUsdc"], "live.maxPositionUsdc")
        if cap > Decimal("1000000000"):
            raise ValueError("live.maxPositionUsdc is too large")
        live["maxPositionUsdc"] = decimal_string(cap)
    # Minimum order size (owner decision 2026-10-16): every entry is the market's smallest order.
    if live.get("minimumOrderSize") not in (None, True, False):
        raise ValueError("live.minimumOrderSize must be true or false")
    if not live.get("minimumOrderSize"):
        live.pop("minimumOrderSize", None)
    state_file = live.get("stateFile")
    if not isinstance(state_file, str) or not Path(state_file).is_absolute():
        raise ValueError("live.stateFile must be an absolute path")
    if live.get("exchangeStopPercent") is None:
        raise ValueError("live.exchangeStopPercent is required")
    stop = positive(live["exchangeStopPercent"], "live.exchangeStopPercent")
    if stop > LIVE_MAX_EXCHANGE_STOP_PERCENT:
        raise ValueError(f"live.exchangeStopPercent must be at most {LIVE_MAX_EXCHANGE_STOP_PERCENT}")
    live["exchangeStopPercent"] = decimal_string(stop)
    if live.get("exchangeStopFrom") not in LIVE_EXCHANGE_STOP_FROM:
        raise ValueError("live.exchangeStopFrom must be strategy_stop or entry_price")
    leverage = positive(live.get("maxLeverage"), "live.maxLeverage")
    if leverage > LIVE_MAX_LEVERAGE:
        raise ValueError(f"live.maxLeverage must be at most {LIVE_MAX_LEVERAGE}")
    live["maxLeverage"] = decimal_string(leverage)


def _usdc(value):
    return decimal_string(Decimal(value).quantize(Decimal("0.01")))


def live_credentials():
    """Account index, API key index and API secret from the credentials file on this machine.

    The file is written by the app from the setup page (folder 0700, file 0600) or placed by the
    server's operator in a closed folder; no message here ever contains the secret.
    """
    # The app's own folder (key saved from the setup page), then a server-managed closed folder.
    folders = [Path(folder) for folder in (os.environ.get("PSR_LIVE_SECRETS_DIR"), "/etc/psr-secrets") if folder]
    path = next((folder / "lighter-mainnet.env" for folder in folders if (folder / "lighter-mainnet.env").is_file()),
                folders[0] / "lighter-mainnet.env")
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            values[name.strip()] = value.strip()
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


def validate_python_config(raw: dict):
    """A Python SDK strategy from a strategy pack; bars arrive from the API."""
    strategy = raw.get("strategy")
    if not isinstance(strategy, dict) or set(strategy) - {"ref", "packPaths", "params", "packSha256"}:
        raise ValueError("strategy must contain ref, packPaths, params and packSha256")
    paths = strategy.get("packPaths") or []
    if not isinstance(paths, list) or any(not isinstance(path, str) or not Path(path).is_absolute() for path in paths):
        raise ValueError("strategy.packPaths must be absolute directories")
    cls, digest = load_strategy(strategy.get("ref"), paths)
    if strategy.get("packSha256") not in (None, digest):
        raise ValueError("strategy pack changed after launch was prepared")
    strategy["packSha256"] = digest
    strategy["params"] = resolve_params(cls, strategy.get("params") or {})
    raw["strategyClass"] = cls
    return validate_pine_config({**raw, "nativeStrategy": PINE_STRATEGY}) | {"nativeStrategy": PYTHON_STRATEGY}


def native_module():
    """The private native strategy module; absent from the public edition."""
    try:
        import native_strategy
    except ImportError as exc:
        raise ValueError("this edition runs Pine and Python strategies only") from exc
    return native_strategy


def validate_config(raw: dict):
    if raw.get("live") is not None and raw.get("nativeStrategy") not in (PYTHON_STRATEGY, PINE_STRATEGY):
        raise ValueError("Live trading runs Pine and Python strategies only")
    if raw.get("nativeStrategy") == PYTHON_STRATEGY:
        return validate_python_config(raw)
    if raw.get("nativeStrategy") == PINE_STRATEGY:
        return validate_pine_config(raw)
    return native_module().validate_native_config(raw)


class PineTrackStrategy(TrackStrategy):
    """One market track of an arbitrary Pine strategy.

    Inputs (quotes, books, freshness, reconnect recovery) come from the shared
    TrackStrategy core. Decisions come from Pine order sets (PineOrderManager);
    every execution is a Sandbox IOC order against the current book.
    """

    def __init__(self, context):
        super().__init__(context)
        live = self.run_config.get("live") is not None
        # Log lines from deciding wait until the resulting orders have been sent (writing a line is
        # disk I/O); Live drops Paper's modeled arrival and trigger delays.
        self.pending_logs = []
        self.manager = PineOrderManager(self.spec.key, self.run_config["minticks"][self.spec.key], self._log_later,
                                        **({"arrival_ms": 0, "trigger_delay_ms": 0, "entry_retry_window_ms": 0}
                                           if live else {}))
        self.queue = []
        self.inflight = None
        self.next_alert_ms = None
        self.avg_open = Decimal("0")
        self.position = Decimal("0")  # signed real position of this track
        self.open_fee = Decimal("0")  # entry fees of the open position not yet charged to an exit
        self.reported = 0
        # Live only: the exchange-side reduce-only stop of the open position (it protects the position
        # if the server or the engine dies), stops being replaced or removed, the market orders that
        # close the position when a Live run stops, and how many position checks in a row found the
        # exchange's position different.
        self.safety = None
        self.safety_replaced = set()
        self.safety_lost_at = -LIVE_SAFETY_LOST_REPEAT_S  # monotonic time Lighter last removed it itself
        self.safety_cap_step = 0  # index in safety_slippage_bps(): narrower after Lighter's 21735
        self.safety_lost_pending = None  # {"lost", "at"}: removed by Lighter, judged after the grace
        self.flatten_ids = set()
        self.flatten_open = {}  # close order id -> {"qty", "filled", "sent"} while it has no final answer
        self.flatten_answered_at = 0.0
        self.flatten_refusals = 0  # closes refused in a row
        self.flatten_attempts = 0
        self.flatten_gave_up = False
        self.gap_closing = False  # closing this market's position after a long data gap
        self.position_mismatches = 0
        # Live: monotonic send time per order, for sent→accepted and sent→filled latency lines.
        self.sent_ns = {}
        # Live: after the exchange refuses an order this market waits a moment before the next one;
        # after an order of unknown outcome it sends nothing until the position check confirms.
        self.reject_until_ms = 0
        self.unconfirmed_since_ms = None
        # Offline Live tests only: hold the in-flight order's fill until after its cancel.
        self.test_hold_fill = False
        self.test_held_fills = []

    # ----- Pine order sets and decisions -------------------------------------

    def bar_boundary(self, boundary_ms):
        self.manager.boundary(boundary_ms)

    def apply_orders(self, item):
        self.manager.apply_set(item, now_ms())
        self.controller.event(self.spec.key, f"Pine order set for bar closing {item['barCloseMs']}: "
                              f"{len(item.get('orders') or [])} order(s), {len(item.get('trades') or [])} open Pine trade(s)")
        if not self.controller.track_recovering(self.spec.key) and not self.controller.stopping and self.fresh():
            self._try_orders(now_ms())
        self._flush_reports()

    def _decide(self, quote, at_ms):
        self.manager.input_source_ns = quote.ts_event
        self.manager.on_quote(quote.bid_price, quote.ask_price, at_ms)

    def _try_orders(self, at_ms):
        if self.controller.track_recovering(self.spec.key) or self.controller.stopping:
            return
        if self.last_quote is not None:
            self.manager.input_source_ns = self.last_quote_event_ns
            self.manager.evaluate(at_ms)
        self.queue.extend(self.manager.take_requests())
        self._pump(at_ms)
        self._flush_reports()
        self._schedule()

    def _on_due(self):
        self.next_alert_ms = None
        if self.controller.track_recovering(self.spec.key) or self.controller.stopping:
            return
        at_ms = now_ms()
        if self.input_diagnostics(at_ms)[0]:
            self._schedule()
            return
        self._try_orders(at_ms)

    def _schedule(self):
        at_ms = now_ms()
        wake = self.manager.next_wakeup_ms(at_ms)
        deadlines = [request.created_ms + ENTRY_MAX_WAIT_MS for request in self.queue
                     if request.ioc and request.created_ms + ENTRY_MAX_WAIT_MS > at_ms]
        if deadlines:
            wake = min([wake, *deadlines]) if wake is not None else min(deadlines)
        if wake is None:
            return
        if self.next_alert_ms is not None and at_ms < self.next_alert_ms <= wake:
            return  # an earlier alert is already armed
        self.next_alert_ms = wake
        self._alert("pine", wake)

    def _log_later(self, message):
        self.pending_logs.append(message)

    def flush_logs(self):
        logs, self.pending_logs = self.pending_logs, []
        for message in logs:
            self.controller.event(self.spec.key, message)

    def _flush_reports(self):
        self.flush_logs()
        for report in self.manager.take_reports():
            fields = {name: report[name] for name in ("orderId", "category", "price", "time", "leg", "qty", "tradeKey")
                      if name in report}
            self.controller.emitter.emit("pine_fill", venue=self.spec.display, market=self.spec.market,
                                         reportSeq=report["seq"], **fields)
            self.reported += 1

    # ----- Sandbox execution -------------------------------------------------

    # Engine outcome -> bounded diagnostic reason.
    DIAGNOSTIC_REASON = {"no_liquidity": "no_liquidity_at_limit", "position_limit": "shared_capital_exhausted",
                         "fillable_below_minimum": "notional_below_minimum", "leverage_cap": "live_leverage_cap",
                         "position_cap": "live_position_cap",
                         "exchange_rejected": "live_exchange_rejected", "rate_limited": "live_rate_limited"}

    def _pump(self, at_ms):
        progressed = True
        live = self.controller.live is not None
        if live and at_ms < self.reject_until_ms:
            self._alert("pine", self.reject_until_ms)
            return
        if live and self.unconfirmed_since_ms is not None:
            return  # resumed by the position check
        while progressed and self.queue and self.inflight is None:
            progressed = False
            if not live and self.book_revision <= self.last_order_book_revision:
                return  # Paper: each IOC needs a book it has not already consumed
            for request in list(self.queue):
                verdict = self._gate(request, at_ms)
                if verdict == "wait":
                    continue  # a later request may go first
                self.queue.remove(request)
                progressed = True
                if verdict == "go":
                    self._submit(request, at_ms)
                else:
                    self._not_sent(request, at_ms, verdict)
                break

    def _gate(self, request, at_ms):
        """Whether a request can meet the current book now ("go"), later ("wait"), or never (a reason)."""
        if self.controller.live is not None:
            # Live sends at once; the exchange matches against its own book. Only an IOC whose limit
            # the newest price has already left is skipped, without waiting for anything.
            if request.kind == "entry" and at_ms < self.controller.live_refusals.entries_paused_until_ms:
                return "rate_limited"  # Lighter's rate limit: no new entries for a while
            quote = self.last_quote
            if request.ioc and quote is not None and not (
                    Decimal(str(quote.ask_price)) <= Decimal(str(request.limit)) if request.side == "buy"
                    else Decimal(str(quote.bid_price)) >= Decimal(str(request.limit))):
                return "price_left_limit"
            return "go"
        if not request.ioc:
            # A triggered order must meet a book at least as new as the price
            # that triggered it (a BBO can be newer than the periodic book).
            return "wait" if request.source_ns and self.last_book_event_ns < request.source_ns else "go"
        # Immediate-or-cancel limit entry, evaluated at its modeled arrival.
        side = OrderSide.BUY if request.side == "buy" else OrderSide.SELL
        limit = Decimal(str(request.limit))
        quote = self.last_quote
        if quote is not None and self.last_quote_event_ns > self.last_book_event_ns and not (
                Decimal(str(quote.ask_price)) <= limit if side == OrderSide.BUY else Decimal(str(quote.bid_price)) >= limit):
            return "price_left_limit"  # the newest price already left the limit: nothing to meet
        depth = self._visible_depth(side, limit)
        if depth <= 0 and self.last_book_event_ns < request.source_ns:
            if at_ms >= request.created_ms + ENTRY_MAX_WAIT_MS:
                return "entry_wait_expired"
            request.waited = True
            return "wait"  # the book has not caught up with the price that prompted the order
        if request.waited and self.last_book_event_ns > request.source_ns + ENTRY_BOOK_WINDOW_MS * 1_000_000:
            return "entry_wait_expired"  # only a book from after the arrival is left
        return "go" if depth > 0 else "no_liquidity"

    def _not_sent(self, request, at_ms, reason):
        self.skip("exit" if request.kind == "exit" else "entry", [self.DIAGNOSTIC_REASON.get(reason, reason)])
        self.controller.event(self.spec.key, f"{request.kind} {request.side} not sent: {reason.replace('_', ' ')}")
        self.manager.exec_result(request.id, filled=0, average=0, opened=0, now_ms=at_ms, reason=reason)
        self.queue.extend(self.manager.take_requests())

    def _step(self, value, rounding=ROUND_DOWN):
        step = Decimal(str(self._instrument().size_increment))
        return (Decimal(value) / step).to_integral_value(rounding=rounding) * step

    def _venue_used_notional(self):
        used = Decimal("0")
        for strategy in self.controller.strategies.values():
            if strategy.spec.venue_key == self.spec.venue_key and isinstance(strategy, PineTrackStrategy):
                used += abs(strategy.position) * strategy.avg_open
        return used

    def _submit(self, request, at_ms):
        instrument = self._instrument()
        side = OrderSide.BUY if request.side == "buy" else OrderSide.SELL
        held = Decimal("0")
        if (self.position > 0 and side == OrderSide.SELL) or (self.position < 0 and side == OrderSide.BUY):
            held = abs(self.position)
        close_qty = min(request.close_qty, held)
        if held - close_qty < Decimal(str(instrument.size_increment)):
            close_qty = held  # rounding dust of a full close
        close_qty = self._step(close_qty)
        reason = None
        open_qty = Decimal("0")
        price_ref = Decimal(str(request.limit)) if request.limit is not None else (
            Decimal(str(self.last_quote.ask_price)) if side == OrderSide.BUY else Decimal(str(self.last_quote.bid_price)))
        limit_positions = getattr(self.run_config.get("strategyClass"), "max_positions_per_venue", None)
        if request.open_side is not None and limit_positions and self.position == 0 and sum(
                1 for strategy in self.controller.strategies.values()
                if strategy is not self and strategy.spec.venue_key == self.spec.venue_key
                and isinstance(strategy, PineTrackStrategy)
                and (strategy.position != 0 or (strategy.inflight and strategy.inflight["request"].open_side))
        ) >= limit_positions:
            reason = "position_limit"
        elif request.open_side is not None and self.controller.live and self.controller.live.get("minimumOrderSize"):
            # Minimum order size: the smallest entry Lighter accepts, whatever the balance and Order size;
            # Max position and the account leverage limit still apply.
            open_qty = self._live_minimum(price_ref, instrument)
            open_qty, reason = self._live_caps(open_qty, close_qty, side, price_ref, instrument, reason)
        elif request.open_side is not None:
            cash = self.controller.venue_cash(self)
            target = cash * Decimal(self.run_config["orderSizePercent"]) / Decimal("100") * request.size_scale
            if self.controller.live is None:
                # Paper: positions together never exceed the virtual balance. Live is bound by the
                # account leverage limit instead (_live_caps) and the exchange's own margin.
                fee_rate = self.controller.entry_fee_rate(self.spec.venue_key, self.spec.key)
                available = cash - (self._venue_used_notional() - close_qty * self.avg_open)
                target = min(target, available / (1 + fee_rate))
            open_qty = self._step(max(target, Decimal("0")) / price_ref) if price_ref > 0 else Decimal("0")
            if open_qty <= 0 and target <= 0:
                reason = "shared_capital_exhausted"
            elif (open_qty <= 0 or (instrument.min_quantity and open_qty < Decimal(str(instrument.min_quantity)))
                  or (instrument.min_notional and open_qty * price_ref < instrument.min_notional.as_decimal())):
                open_qty, reason = Decimal("0"), "notional_below_minimum"
            if open_qty > 0 and self.controller.live:
                open_qty, reason = self._live_caps(open_qty, close_qty, side, price_ref, instrument, reason)
        total = close_qty + open_qty
        if self.controller.live is not None:
            pass  # no trimming by our local copy of the book
        elif request.limit is None:
            visible = self._step(self._visible_depth(side))
            if visible < total:
                total = visible
                reason = reason or "no_liquidity"
        elif request.ioc and open_qty > 0:
            # What can execute at the limit must itself be a closable position.
            fillable = min(total, self._step(self._visible_depth(side, Decimal(str(request.limit)))))
            if ((instrument.min_quantity and fillable < Decimal(str(instrument.min_quantity)))
                    or (instrument.min_notional and fillable * price_ref < instrument.min_notional.as_decimal())
                    or fillable <= 0):
                total, reason = Decimal("0"), "fillable_below_minimum"
        if total <= 0:
            reason = reason or "no_liquidity"
            self.skip("exit" if request.kind == "exit" else "entry",
                      ["insufficient_exit_depth" if request.kind == "exit" and reason == "no_liquidity"
                       else self.DIAGNOSTIC_REASON.get(reason, reason)])
            self.manager.exec_result(request.id, filled=0, average=0, opened=0, now_ms=at_ms, reason=reason)
            self.queue.extend(self.manager.take_requests())
            return
        qty = Quantity.from_str(f"{total:.{instrument.size_precision}f}")
        reduce_only = request.reduce_only or open_qty <= 0
        if request.limit is not None:
            price = instrument.make_price(float(outward_price(request.limit, instrument.price_increment, request.side)))
            order = self.order_factory.limit(self.exec_id, side, qty, price, time_in_force=TimeInForce.IOC,
                                             reduce_only=reduce_only)
        else:
            order = self.order_factory.market(self.exec_id, side, qty, time_in_force=TimeInForce.IOC,
                                              reduce_only=reduce_only)
        self.inflight = {"id": order.client_order_id, "request": request, "requested": Decimal(str(qty)),
                         "close": min(close_qty, Decimal(str(qty))), "filled": Decimal("0"),
                         "quote": Decimal("0"), "reason": reason, "sent_ns": time.perf_counter_ns()}
        self.last_order_book_revision = self.book_revision
        self.pending_order_ids.add(str(order.client_order_id))
        self.intents += 1
        self.broker_revision += 1
        if self.controller.live is not None and request.limit is None:
            self.submit_order(order, params=self.live_market_params(side, Decimal(str(qty))))  # Max slippage
        else:
            self.submit_order(order)
        self._mark_sent(order)
        what = (f"{request.kind} {request.side} {qty} {self.spec.market}"
                + (f" IOC limit {price}" if request.limit is not None else " IOC market"))
        self._log_later(f"Pine {what} submitted (leg {request.leg_key})")

    def _on_fill(self, event):
        order_id = str(event.client_order_id)
        state = self.inflight
        if self.test_hold_fill and state is not None and event.client_order_id == state["id"]:
            self.test_held_fills.append(event)
            return
        if order_id in self.sent_ns:
            self._order_latency("filled", event)
        if self._is_safety(order_id):
            self._safety_fill(event)
            return
        if order_id in self.flatten_ids:
            qty, buy = Decimal(str(event.last_qty)), event.order_side == OrderSide.BUY
            before = self.position
            closing = min(qty, abs(before)) if before != 0 and (before < 0) == buy else Decimal("0")
            self._book_fill(event)
            if not self.controller.stopping:
                # A data-gap close: the strategy's trades shrink as for a late fill.
                self.manager.late_fill("buy" if buy else "sell", closing, qty - closing)
                self._sync_safety_stop()
            close = self.flatten_open.get(order_id)
            if close is not None:
                self.flatten_refusals = 0
                close["filled"] += Decimal(str(event.last_qty))
                if close["filled"] >= close["qty"]:
                    self._close_answered(order_id)
            return
        if state is None or event.client_order_id != state["id"]:
            if self.controller.live is not None:
                self._late_fill(event)  # Lighter's fill can follow the cancel that ended its order
                return
            raise ValueError(f"unowned fill {event.client_order_id}")
        qty = Decimal(str(event.last_qty))
        price = Decimal(str(event.last_px))
        if self.controller.live is not None and state["filled"] + qty > state["requested"]:
            # More than the order asked for: booked, so the stop closes it too, and the run halts.
            self._book_fill(event)
            state["quote"] += (state["requested"] - state["filled"]) * price
            state["filled"] = state["requested"]
            self.controller.live_halt(f"{self.spec.market}: Lighter filled order {order_id} beyond its size "
                                      f"({decimal_string(state['requested'])}); the run stops and closes everything")
            self._complete_inflight()
            return
        state["filled"] += qty
        state["quote"] += qty * price
        if state["filled"] > state["requested"]:
            raise ValueError("Pine order overfill")
        if self.controller.live is not None:
            self.controller.live_refusals.filled(self.spec.market)
        self._book_fill(event)
        if state["filled"] == state["requested"]:
            self._complete_inflight()

    def _late_fill(self, event):
        """Live: a fill of this market's order that had already ended. Booked at once; what it opened
        belongs to no strategy trade and is closed at market, what it closed shrinks the trades."""
        qty, buy = Decimal(str(event.last_qty)), event.order_side == OrderSide.BUY
        before = self.position
        closing = min(qty, abs(before)) if before != 0 and (before < 0) == buy else Decimal("0")
        self._book_fill(event)
        self.controller.live_refusals.filled(self.spec.market)
        self.manager.late_fill("buy" if buy else "sell", closing, qty - closing)
        if not self.controller.stopping:
            self._sync_safety_stop()
        self.controller.event(self.spec.key, f"LIVE: late fill of order {event.client_order_id}: "
                              f"{'buy' if buy else 'sell'} {decimal_string(qty)} {self.spec.market} at {event.last_px}"
                              + (f"; {decimal_string(qty - closing)} owned by no trade closes at market"
                                 if qty > closing else ""))
        if not self.controller.stopping:
            self._try_orders(now_ms())

    def _safety_fill(self, event):
        """The exchange-side stop executed while the engine runs: its own stop did not close first.
        Booked, the strategy's position follows, and the run halts (owner decision 2026-10-15)."""
        qty, buy = Decimal(str(event.last_qty)), event.order_side == OrderSide.BUY
        before = self.position
        closing = min(qty, abs(before)) if before != 0 and (before < 0) == buy else Decimal("0")
        self._book_fill(event)
        self.manager.late_fill("buy" if buy else "sell", closing, qty - closing)
        self.controller.live_halt(f"{self.spec.market}: the exchange-side stop executed on Lighter at {event.last_px}; "
                                  "the run stops and closes everything")

    def _book_fill(self, event):
        """Position, average price, fees and the fill events of one execution."""
        qty = Decimal(str(event.last_qty))
        price = Decimal(str(event.last_px))
        fee = event.commission.as_decimal() if event.commission else Decimal("0")
        self.fills += 1
        self.broker_revision += 1
        buy = event.order_side == OrderSide.BUY
        sign = Decimal("1") if buy else Decimal("-1")
        closing = min(qty, abs(self.position)) if (self.position < 0) == buy and self.position != 0 else Decimal("0")
        opening = qty - closing
        base_id = (f"{self.spec.key}:{event.trade_id}" if getattr(event, "trade_id", None)
                   else f"{self.spec.key}:{event.client_order_id}:{event.ts_event}")
        parts = []
        if closing > 0:
            gross = (price - self.avg_open) * closing * (Decimal("1") if self.position > 0 else Decimal("-1"))
            share = (fee * closing / qty).quantize(Decimal("0.00000001"))
            remaining = abs(self.position) - closing
            # Realized PnL is net of the exit fee and of the closed part's entry fees.
            entry_share = self.open_fee if remaining == 0 else self.open_fee * closing / abs(self.position)
            self.open_fee -= entry_share
            parts.append(("exit", closing, "long" if self.position > 0 else "short", share,
                          (gross - share - entry_share).quantize(Decimal("0.00000001"))))
            self.position = (remaining if self.position > 0 else -remaining)
            if remaining == 0:
                self.avg_open = Decimal("0")
                self.open_fee = Decimal("0")
        if opening > 0:
            total = abs(self.position) + opening
            self.avg_open = (self.avg_open * abs(self.position) + price * opening) / total
            self.position += sign * opening
            entry_fee = (fee * opening / qty).quantize(Decimal("0.00000001"))
            self.open_fee += entry_fee
            parts.append(("entry", opening, "long" if buy else "short", entry_fee, None))
        for index, (kind, part_qty, position_side, part_fee, realized) in enumerate(parts):
            self.controller.emitter.emit(
                "fill", venue=self.spec.display, market=self.spec.market, kind=kind,
                side="buy" if buy else "sell", positionSide=position_side, quantity=decimal_string(part_qty),
                quote=decimal_string(part_qty * price), price=decimal_string(price), fee=decimal_string(part_fee),
                realizedPnl=decimal_string(realized) if realized is not None else None,
                id=base_id if len(parts) == 1 else f"{base_id}:{index}",
            )
        if self.controller.live:
            self.controller.check_live_limits()

    def _complete_inflight(self, reason=None):
        state = self.inflight
        self.inflight = None
        self.pending_order_ids.discard(str(state["id"]))
        filled = state["filled"]
        average = state["quote"] / filled if filled > 0 else Decimal("0")
        opened = max(Decimal("0"), filled - state["close"])
        self.manager.exec_result(state["request"].id, filled=filled, average=average, opened=opened,
                                 now_ms=now_ms(), reason=reason or state["reason"])
        if self.controller.live and not self.controller.stopping:
            self._sync_safety_stop()
        self.controller.snapshot()
        if not self.controller.stopping and not self.controller.track_recovering(self.spec.key):
            self._try_orders(now_ms())
        else:
            self._flush_reports()

    def _on_canceled(self, event):
        order_id = str(event.client_order_id)
        if order_id in self.sent_ns:
            self._order_latency("canceled", event)
        if self._is_safety(order_id):
            removed_by_us = order_id in self.safety_replaced
            self.safety_replaced.discard(order_id)
            lost = self.safety if self.safety is not None and order_id == self.safety["id"] else None
            if lost is not None:
                self.safety = None
            self.controller.event(self.spec.key, f"exchange-side stop {order_id} removed from Lighter")
            if not removed_by_us and not self.controller.stopping and self.position != 0:
                # Lighter removes it when the position closes too, and that cancel can come just before
                # the closing fill: decided after LIVE_SAFETY_LOST_GRACE_S (RuntimeController.check_live_orders).
                self.safety_lost_pending = {"lost": lost, "at": time.monotonic()}
            return
        if order_id in self.flatten_ids:
            close = self.flatten_open.get(order_id)
            if close is not None:
                self.controller.safe_event(self.spec.key, f"LIVE close {order_id} canceled by Lighter; filled "
                                           f"{decimal_string(close['filled'])} of {decimal_string(close['qty'])} "
                                           f"{self.spec.market}")
                self._close_answered(order_id)
            return
        state = self.inflight
        self.pending_order_ids.discard(order_id)
        self.broker_revision += 1
        if state is None or event.client_order_id != state["id"]:
            self.controller.event(self.spec.key, f"order {event.client_order_id} canceled")
            return
        if state["filled"] < state["requested"]:
            self.controller.event(self.spec.key, f"IOC {event.client_order_id} remainder canceled; filled "
                                  f"{decimal_string(state['filled'])} of {decimal_string(state['requested'])} {self.spec.market}")
        if self.controller.live is not None and state["filled"] <= 0 and state["request"].kind == "exit":
            # A canceled entry is an ordinary miss and is not retried; an exit is, after a pause.
            delay, halt = self.controller.live_refusals.exit_missed(self.spec.market)
            if halt:
                self.controller.live_halt(f"{halt}; the run stops and closes everything")
            else:
                self.reject_until_ms = max(self.reject_until_ms, now_ms() + delay)
                self.controller.event(self.spec.key, f"LIVE: Lighter canceled exit {order_id} without a fill; "
                                      f"next try in {delay // 1000} s")
        self._complete_inflight("no_liquidity" if state["filled"] <= 0 else None)
        held, self.test_held_fills = self.test_held_fills, []
        if held:  # offline test: the held fill arrives after its order's cancel, as on Lighter
            self.test_hold_fill = False
            for item in held:
                self._on_fill(item)

    # ----- Live: position and leverage caps, closing on stop ---------------------------

    def on_start(self):
        super().on_start()
        if self.controller.live:
            self.controller.live_clean_start(self)

    def _mark_sent(self, order):
        if self.controller.live is not None:
            self.sent_ns[str(order.client_order_id)] = time.perf_counter_ns()

    def _order_latency(self, stage, event, stamp=None, **fields):
        """Live: one line per order with the exchange's real response times."""
        order_id = str(event.client_order_id)
        sent = self.sent_ns.get(order_id)
        if sent is None or stage not in ("accepted", "filled", "rejected", "denied", "canceled"):
            return
        elapsed = (time.perf_counter_ns() - sent) / 1_000_000
        safety = self._is_safety(order_id)
        if safety and stage == "accepted" and self.safety is not None and order_id == self.safety["id"]:
            self.safety["accepted"] = True
        if stage != "accepted" or safety:
            # A resting stop's later fill or cancel says nothing about speed.
            self.sent_ns.pop(order_id, None)
            if safety and stage != "accepted":
                return
        self._log_later(f"LIVE latency {self.spec.market}: sent→{stage} {elapsed:.1f} ms ({event.client_order_id})")

    def _live_minimum(self, price_ref, instrument):
        """The market's smallest order with room to close it: its minimum size, and its minimum
        notional plus the reserve, at the order's price."""
        qty = self._step(Decimal(str(instrument.min_quantity or instrument.size_increment)), ROUND_UP)
        if instrument.min_notional and price_ref > 0:
            qty = max(qty, self._step(instrument.min_notional.as_decimal() * LIVE_MINIMUM_RESERVE / price_ref, ROUND_UP))
        return qty

    def live_sell_bps(self, qty, price, bps):
        """Price allowance of a sell: at most `bps`, but small enough that its amount at the worst price
        stays at Lighter's minimum (the module refuses it otherwise, a close included)."""
        instrument = self._instrument()
        if not instrument.min_notional or price is None or price <= 0 or qty <= 0:
            return bps
        minimum = instrument.min_notional.as_decimal()
        if qty * price * (1 - Decimal(bps) / 10000) >= minimum:
            return bps
        # One basis point less than the exact fit: the module rounds the worst price down to a tick.
        fit = int(((1 - minimum / (qty * price)) * 10000).to_integral_value(rounding=ROUND_DOWN)) - 1
        return max(1, min(bps, fit))

    def live_market_params(self, side, qty):
        """Order params of a Live market order: Max slippage, narrowed for a small sell."""
        bps = self.controller.live_slippage()["market_order_slippage_bps"]
        if side == OrderSide.SELL and self.last_quote is not None:
            bps = self.live_sell_bps(Decimal(qty), Decimal(str(self.last_quote.bid_price)), bps)
        return {"market_order_slippage_bps": bps}

    def safety_resting(self):
        """The exchange-side stop is accepted by Lighter and still waiting there."""
        if self.safety is None:
            return False
        order = self.cache.order(ClientOrderId.from_str(self.safety["id"]))
        return order is not None and str(order.status) in ("ACCEPTED", "TRIGGERED", "PARTIALLY_FILLED")

    def _live_caps(self, open_qty, close_qty, side, price_ref, instrument, reason):
        """Shrink a Live entry to the account's total leverage limit and the market's Max position."""
        same_side = (self.position > 0 and side == OrderSide.BUY) or (self.position < 0 and side == OrderSide.SELL)
        held_after = abs(self.position) if same_side else max(abs(self.position) - close_qty, Decimal("0"))
        if price_ref <= 0:
            return Decimal("0"), "leverage_cap"
        leverage = Decimal(self.controller.live["maxLeverage"])
        equity = self.controller.live_equity(self)
        exposure = held_after * price_ref + self.controller.live_exposure(exclude=self)
        rooms = [((leverage * equity - exposure) / price_ref, "leverage_cap",
                  f"the account leverage limit of {leverage}x ({decimal_string((leverage * equity).quantize(Decimal('0.01')))} "
                  f"USDC on {decimal_string(equity.quantize(Decimal('0.01')))} USDC equity)")]
        cap = self.controller.live.get("maxPositionUsdc")
        if cap is not None:
            rooms.append(((Decimal(cap) - held_after * price_ref) / price_ref, "position_cap",
                          f"the Max position of {cap} USDC"))
        room, cap_reason, label = min(rooms, key=lambda item: item[0])
        capped = self._step(max(room, Decimal("0")))
        if capped >= open_qty:
            return open_qty, reason
        if (capped <= 0 or (instrument.min_quantity and capped < Decimal(str(instrument.min_quantity)))
                or (instrument.min_notional and capped * price_ref < instrument.min_notional.as_decimal())):
            self._log_later(f"entry not sent: it would exceed {label}")
            return Decimal("0"), cap_reason
        self._log_later(f"entry reduced from {open_qty} to {capped} {self.spec.market} by {label}")
        return capped, reason

    def live_mark(self):
        """Price an open position is valued at: the quote mid, else its average entry."""
        quote = self.last_quote
        if quote is not None:
            return (Decimal(str(quote.bid_price)) + Decimal(str(quote.ask_price))) / 2
        return self.avg_open

    def live_inflight_notional(self):
        """Notional an entry still on its way to the exchange may open."""
        state = self.inflight
        if state is None or state["request"].open_side is None:
            return Decimal("0")
        return max(state["requested"] - state["close"] - state["filled"], Decimal("0")) * self.live_mark()

    def _is_safety(self, order_id):
        return (self.safety is not None and order_id == self.safety["id"]) or order_id in self.safety_replaced

    def _safety_trigger(self):
        """Trigger price of the exchange-side stop: N % beyond the strategy's farthest stop (or the
        average entry when chosen, or when the strategy has no stop)."""
        live = self.controller.live
        long = self.position > 0
        level = None
        if live["exchangeStopFrom"] == "strategy_stop":
            losses = [loss for leg in self.manager.legs.values() if leg.trade_key in self.manager.trades
                      for loss in [self.manager._bracket_levels(leg)[1]] if loss is not None and loss > 0]
            if losses:
                level = min(losses) if long else max(losses)
        if level is None:
            level = self.avg_open
        buffer = Decimal(live["exchangeStopPercent"])
        return level * (1 - buffer / 100) if long else level * (1 + buffer / 100)

    def _sync_safety_stop(self):
        """Keep one reduce-only STOP_MARKET on Lighter for the whole open position. It is placed again
        only when the position's size changes (it does not follow a trailing stop)."""
        instrument = self._instrument()
        qty = self._step(abs(self.position))
        current = self.safety
        if current is not None and current["qty"] == qty:
            return
        if qty <= 0:
            self._cancel_safety()
            return
        # Rounded away from the market: a sell stop down, a buy stop up.
        trigger = outward_price(self._safety_trigger(), instrument.price_increment, "buy" if self.position > 0 else "sell")
        side = OrderSide.SELL if self.position > 0 else OrderSide.BUY
        order = self.order_factory.stop_market(
            self.exec_id, side, Quantity.from_str(f"{qty:.{instrument.size_precision}f}"),
            instrument.make_price(float(trigger)), time_in_force=TimeInForce.GTC, reduce_only=True)
        self.safety = {"id": str(order.client_order_id), "qty": qty, "trigger": trigger,
                       "sent_ns": time.perf_counter_ns(), "accepted": False}
        bps = self.safety_slippage_bps()[self.safety_cap_step]
        if side == OrderSide.SELL:
            bps = self.live_sell_bps(qty, trigger, bps)
        self.submit_order(order, params={"market_order_slippage_bps": bps})
        self._mark_sent(order)
        if current is not None:
            # The new stop is placed before the old one is removed: the position is never unprotected.
            # Both are reduce-only, so together they can never close more than the position.
            self._cancel_safety_order(current)
        self.controller.event(self.spec.key, f"exchange-side stop on Lighter: {side.name.lower()} {qty} {self.spec.market} "
                              f"if price reaches {trigger} (reduce-only)")

    def safety_slippage_bps(self):
        """The exchange-side stop's caps: Max slippage, then narrower ones if Lighter refuses it (21735)."""
        bps = self.controller.live_slippage()["market_order_slippage_bps"]
        return (bps, *(step for step in LIVE_SAFETY_FALLBACK_BPS if step < bps))

    def judge_lost_safety(self, at):
        """After the grace: a stop Lighter removed matters only if the position is still open unprotected."""
        pending = self.safety_lost_pending
        if pending is None or at - pending["at"] < LIVE_SAFETY_LOST_GRACE_S:
            return
        self.safety_lost_pending = None
        if self.position == 0 or self.safety is not None or self.controller.stopping:
            return  # the position closed (the cancel came first) or it already has a new stop
        self._safety_lost(pending["lost"])

    def _order_transition(self, name, event):
        super()._order_transition(name, event)
        if name == "accepted" and str(event.client_order_id) in self.safety_replaced:
            # A stop replaced or removed before Lighter accepted it (Lighter can cancel only an accepted
            # order): cancel it now.
            self.cancel_order(event.client_order_id)

    def _safety_lost(self, lost):
        """Lighter removed the exchange-side stop itself while the position is open."""
        quote = self.last_quote
        crossed = quote is None or lost is None or (
            Decimal(str(quote.bid_price)) <= lost["trigger"] if self.position > 0
            else Decimal(str(quote.ask_price)) >= lost["trigger"])
        at = time.monotonic()
        repeated = at - self.safety_lost_at < LIVE_SAFETY_LOST_REPEAT_S
        self.safety_lost_at = at
        if crossed or repeated:
            # It triggered and was canceled (a gap past its price cap), or keeps disappearing: the
            # engine closes the position at market and stops instead of placing it again and again.
            self.controller.live_halt(f"{self.spec.market}: Lighter canceled the exchange-side stop "
                                      + ("after the price reached it" if crossed else "twice within a minute")
                                      + "; the run closes the position at market and stops")
            return
        self._sync_safety_stop()  # e.g. its lifetime ended: the open position gets a new one

    def _cancel_safety(self):
        current, self.safety = self.safety, None
        if current is not None:
            self._cancel_safety_order(current)

    def _cancel_safety_order(self, current):
        order = self.cache.order(ClientOrderId.from_str(current["id"]))
        if order is not None and str(order.status) in ACTIVE_ORDER_STATES | {"TRIGGERED"}:
            self.safety_replaced.add(current["id"])
            if str(order.status) not in ("INITIALIZED", "SUBMITTED"):
                self.cancel_order(order.client_order_id)
            # else: not accepted by Lighter yet; canceled when its acceptance arrives (_order_transition)

    # The exchange's verdicts in Live: a refused order is a fact of trading, not an engine error.
    def on_order_rejected(self, event):
        if self.controller.live is None:
            return super().on_order_rejected(event)
        self._guard("order rejected", lambda: self._live_refused(event, "rejected"), allow_during_stop=True)

    def on_order_denied(self, event):
        if self.controller.live is None:
            return super().on_order_denied(event)
        self._guard("order denied", lambda: self._live_refused(event, "denied"), allow_during_stop=True)

    def _live_refused(self, event, stage):
        self._order_latency(stage, event)
        order_id, reason = str(event.client_order_id), str(event.reason)
        if self._is_safety(order_id):
            self.safety_replaced.discard(order_id)
            if self.safety is not None and order_id == self.safety["id"]:
                # The position would stay without its exchange-side protection (owner decision 2026-10-15).
                self.safety = None
                if (lighter_error_code(reason) == 21735 and self.safety_cap_step + 1 < len(self.safety_slippage_bps())
                        and not self.controller.stopping):
                    self.safety_cap_step += 1
                    self.controller.event(self.spec.key, "LIVE: Lighter finds the exchange-side stop's price cap too far "
                                          f"from its trigger; placing it with {self.safety_slippage_bps()[self.safety_cap_step] / 100}%")
                    self._sync_safety_stop()
                    return
                self.controller.live_halt(f"{self.spec.market}: Lighter refused the exchange-side stop ({reason}); "
                                          "the run stops and closes everything")
            return
        if order_id in self.flatten_ids:
            self.flatten_refusals += 1
            self.controller.safe_event(self.spec.key, f"LIVE close {order_id} refused by Lighter: {reason}; next try in "
                                       f"{flatten_retry_s(self.flatten_refusals):g} s")
            self._close_answered(order_id)
            return
        state = self.inflight
        self.controller.event(self.spec.key, f"Lighter refused order {order_id}: {reason}")
        if state is None or event.client_order_id != state["id"]:
            return
        self.pending_order_ids.discard(order_id)
        at_ms = now_ms()
        group, halt = self.controller.live_refusals.refused(self.spec.market, reason, at_ms, denied=stage == "denied")
        if group == "unknown_outcome":
            self.unconfirmed_since_ms = at_ms
            self.controller.event(self.spec.key, f"LIVE: the outcome of order {order_id} is unknown; {self.spec.market} "
                                  "sends nothing until the position check confirms Lighter's position")
        elif group == "rate_limit":
            self.controller.event(self.spec.key, f"LIVE: Lighter rate limit; no new entries for "
                                  f"{LIVE_RATE_LIMIT_PAUSE_MS // 1000} s")
        self.reject_until_ms = at_ms + LIVE_REFUSAL_PAUSE_MS
        if halt:
            self.controller.live_halt(f"{halt}; the run stops and closes everything")
        self._complete_inflight("exchange_rejected")

    def on_order_cancel_rejected(self, event):
        if self.controller.live is None:
            return super().on_order_cancel_rejected(event)
        # A cancel of an order that already ended (filled or canceled) is refused on a real exchange;
        # the order's own final answer, or the no-answer rule, decides what happens next.
        self._guard("order cancel rejected", lambda: self.controller.event(
            self.spec.key, f"Lighter did not cancel order {event.client_order_id}: {event.reason}"), allow_during_stop=True)

    def live_flatten(self):
        """Stop: close the open position at market (reduce-only). Returns whether one was sent."""
        qty = self._step(abs(self.position))
        if qty <= 0:
            return False
        instrument = self._instrument()
        if instrument.min_quantity and qty < Decimal(str(instrument.min_quantity)):
            # Below Lighter's smallest order: no close can be sent for it.
            self.flatten_gave_up = True
            self.controller.safe_event(self.spec.key, f"LIVE: {qty} {self.spec.market} left is below Lighter's "
                                       "minimum order and cannot be closed by an order")
            return False
        side = OrderSide.SELL if self.position > 0 else OrderSide.BUY
        order = self.order_factory.market(self.exec_id, side, Quantity.from_str(f"{qty:.{instrument.size_precision}f}"),
                                          time_in_force=TimeInForce.IOC, reduce_only=True)
        order_id = str(order.client_order_id)
        self.flatten_ids.add(order_id)
        self.flatten_open[order_id] = {"qty": qty, "filled": Decimal("0"), "sent": time.monotonic()}
        self.flatten_attempts += 1
        self.submit_order(order, params=self.live_market_params(side, qty))
        self._mark_sent(order)
        self.controller.safe_event(self.spec.key, f"closing {qty} {self.spec.market} at market on stop (reduce-only, "
                                   f"attempt {self.flatten_attempts})")
        return True

    def _close_answered(self, order_id):
        self.flatten_open.pop(order_id, None)
        self.flatten_answered_at = time.monotonic()

    def live_close_step(self, at):
        """Stop: send a close for what is still open once the previous one has its final answer (or
        went silent), a moment after that answer."""
        if self.position == 0 or self.flatten_gave_up:
            return
        if any(at - close["sent"] < LIVE_FLATTEN_SILENT_S for close in self.flatten_open.values()):
            return  # a close is on its way
        if at - self.flatten_answered_at < flatten_retry_s(self.flatten_refusals):
            return
        self.live_flatten()

    def live_cleanup(self):
        """After the closes: remove the exchange-side stop and any other open order of this run."""
        self._cancel_safety()
        for order in self.cache.orders_open(instrument_id=self.exec_id):
            if str(order.status) in ACTIVE_ORDER_STATES | {"TRIGGERED"}:
                self.cancel_order(order.client_order_id)

    # ----- lifecycle, recovery and reporting -----------------------------------

    def observe_diagnostics(self):
        at_ms = now_ms()
        reasons, ages = self.input_diagnostics(at_ms)
        if self.controller.stopping:
            reasons = []
        elif self.controller.track_recovering(self.spec.key):
            reasons = ["recovery"]
        else:
            if self.manager.entries_gated and any(leg.order.get("category") == "entry" for leg in self.manager.legs.values()):
                reasons.append("entry_delay")  # waiting for the order set of the latest bar
            if any(leg.state == "triggered" for leg in self.manager.legs.values()):
                reasons.append("exit_delay")
            if self.queue and self.book_revision <= self.last_order_book_revision:
                reasons.append("book_not_advanced")
        self.controller.diagnostics[self.spec.key].waits(sorted(set(reasons)), ages)

    def stop_new_orders(self):
        if not (self.controller.track_recovering(self.spec.key) and not self.controller.stopping):
            self.manager.stop()
            self.queue = []
        for order_id in list(self.pending_order_ids):
            order = self.cache.order(ClientOrderId.from_str(order_id))
            if order is not None and str(order.status) in ACTIVE_ORDER_STATES:
                self.cancel_order(order.client_order_id)

    def pause_for_recovery(self, floor_ns):
        self.recovery_cash = self.account_snapshot()["cashBalance"]
        self.recovery_fills = self.controller.venue_fills(self.spec.venue_key)
        self.stop_new_orders()
        self.invalidate_inputs(floor_ns)

    def recovery_audit_ready(self):
        self.recovery_audit_blocker = None
        if self.pending_order_ids or self.inflight or self.flatten_open:
            self.recovery_audit_blocker = "orders_pending"
            return False
        book = self._book()
        bids, asks = book.bids(depth=1), book.asks(depth=1)
        if not bids or not asks or Decimal(str(bids[0].price)) >= Decimal(str(asks[0].price)):
            self.recovery_audit_blocker = "book_invalid"
            self.controller.record_invalid_book(self)
            return False
        own = self.safety_replaced | ({self.safety["id"]} if self.safety else set())
        if any(str(order.client_order_id) not in own for order in self.cache.orders_open(instrument_id=self.exec_id)):
            if self.controller.live is not None:
                self.recovery_audit_blocker = "foreign_order"
                self.controller.live_halt(f"{self.spec.market}: after the data gap an order this run did not place is "
                                          "open on Lighter (placed in the Lighter app?); the run stops and closes everything")
                return False
            raise ValueError("unowned open order during recovery")
        quote = self.last_quote
        if quote is None or Decimal(str(quote.ask_price)) <= Decimal(str(quote.bid_price)):
            self.recovery_audit_blocker = "quote_invalid"
            return False
        positions = self.cache.positions_open(instrument_id=self.exec_id)
        sandbox = Decimal("0")
        for position in positions:
            qty = Decimal(str(position.quantity))
            sandbox += qty if str(position.side).upper().endswith("LONG") else -qty
        if sandbox != self.position or self.position != self.manager.real_position():
            if self.controller.live is not None:
                self.recovery_audit_blocker = "position_differs"
                self.controller.live_halt(
                    f"{self.spec.market}: after the data gap the run counts {decimal_string(self.position)}, Lighter's "
                    f"fills give {decimal_string(sandbox)} and the strategy holds {decimal_string(self.manager.real_position())}; "
                    "the run stops and closes everything")
                return False
            raise ValueError(f"Sandbox ({sandbox}), track ({self.position}) and Pine mirror "
                             f"({self.manager.real_position()}) positions disagree during recovery")
        balance = self.cache.account_for_venue(self.exec_venue).balance(USDC)
        if balance is None or not balance.total.as_decimal().is_finite():
            if self.controller.live is not None:
                self.recovery_audit_blocker = "balance_unavailable"  # wait for Lighter's account stream
                return False
            raise ValueError("USDC balance unavailable during recovery")
        if (not self.controller.live and self.controller.venue_fills(self.spec.venue_key) == self.recovery_fills
                and balance.total.as_decimal() != Decimal(self.recovery_cash)):
            raise ValueError("virtual balance changed without a recorded fill during recovery")
        return True

    def resume_after_recovery(self):
        self.last_order_book_revision = self.book_revision
        self.recovery_cash = None

    def account_snapshot(self):
        row = super().account_snapshot()
        row["pendingOrders"] = self.manager.pending_count() + (1 if self.inflight else 0)
        row["signals"] = self.manager.signals
        return row


class SdkTrackStrategy(PineTrackStrategy):
    """A Python SDK strategy on one market track.

    The strategy runs inside this callback thread: every accepted quote and
    every fill reaches it synchronously, and its orders go to the same order
    engine and Sandbox IOC path as Pine orders.
    """

    def __init__(self, context):
        super().__init__(context)
        strategy = self.run_config["strategy"]
        self.runner = StrategyRunner(self.run_config["strategyClass"], params=strategy["params"],
                                     venue=self.spec.venue_key, market=self.spec.market,
                                     mintick=self.run_config["minticks"][self.spec.key],
                                     log=self._log_later, manager=self.manager)

    def bar_boundary(self, boundary_ms):
        pass  # Python strategies decide on their own bars and quotes; entries are never gated

    def on_public_trade(self, tick):
        if self.runner.started and not self.controller.stopping:
            self._guard("trade", lambda: self.runner.on_trade(tick.price, tick.size, tick.ts_event // 1_000_000))

    def apply_orders(self, item):
        raise ValueError("Pine order sets are not accepted by a Python strategy run")

    def receive_bars(self, bars, live):
        if not isinstance(bars, list) or not bars or len(bars) > 10_000:
            raise ValueError("bars must be a non-empty list")
        at_ms = now_ms()
        if not self.runner.started:
            if live:
                raise ValueError("live bar before warm-up")
            self.runner.warm_up(bars)
            self.runner.start(at_ms)
            self.controller.event(self.spec.key, f"{self.runner.strategy_cls.name}: warmed up on {len(bars)} bars, started")
        else:
            for bar in bars:
                self.runner.on_bar(bar, at_ms)
        if not self.controller.track_recovering(self.spec.key) and not self.controller.stopping and self.fresh():
            self._try_orders(at_ms)

    def _decide(self, quote, at_ms):
        self.manager.input_source_ns = quote.ts_event
        if self.runner.instrument is None:
            instrument = self._instrument()
            self.runner.instrument = Instrument(
                Decimal(str(instrument.price_increment)), Decimal(str(instrument.size_increment)),
                Decimal(str(instrument.min_quantity)) if instrument.min_quantity else None,
                instrument.min_notional.as_decimal() if instrument.min_notional else None)
        if self.runner.started:
            self.runner.on_quote(quote.bid_price, quote.ask_price, at_ms)
        else:
            self.manager.on_quote(quote.bid_price, quote.ask_price, at_ms)

    def _flush_reports(self):
        if not self.runner.started:
            return
        at_ms = now_ms()
        self.runner.drain(at_ms)
        # Orders placed from on_fill join the same queue at once.
        self.queue.extend(self.manager.take_requests())
        self._pump(at_ms)
        self.flush_logs()

    def account_snapshot(self):
        row = super().account_snapshot()
        row["signals"] = self.manager.signals
        row["rejectedSignals"] = self.runner.rejected
        return row


class RuntimeController:
    def __init__(self, config, emitter):
        self.config = config
        self.python = config.get("nativeStrategy") == PYTHON_STRATEGY
        self.pine = config.get("nativeStrategy") == PINE_STRATEGY or self.python
        self.specs = make_specs(config.get("tracks"), require_both=not self.pine)
        self.last_boundary_ms = None
        self.emitter = emitter
        self.emitter.on_failure = self._outbox_failure
        self.emitter.on_output_closed = lambda error: self.parent_gone(f"controlling API disconnected ({error})")
        self.output_detached = False
        self.stop_event = asyncio.Event()
        self.stopping = False
        self.failed = False
        self.stop_reason = None
        self.stage = "waiting_for_data"
        self.strategies = {}
        # Source-side bridges per market; revival resubscribes a market's book through it.
        self.bridges = {}
        self.public_frames = {key: 0 for key in self.specs}
        self.last_public_ms = {key: None for key in self.specs}
        self.instrument_ready_keys = set()
        self.socket_status = {}
        self.connected_endpoints = set()
        self.started_ms = now_ms()
        self.recovery_started_ns = None
        self.recovery_gaps = {}
        self.recovery_count = 0
        self.last_recovery_progress_ns = None
        self.recovery_first_market_ready_ns = None
        self.recovery_rejection_examples = set()
        self.recovery_rejected_books = {}
        self.recovery_book_samples = {}
        # Presence blocks decisions; None awaits an eligible source batch,
        # otherwise the tuple identifies the replacement awaiting delivery.
        self.book_sync_required = {}
        self.accepted_source_ns = {(key, kind): 0 for key in self.specs for kind in ("quote", "book")}
        # Latest accepted PAPER input per venue socket (any selected market).
        self.venue_stream = {venue: {"delivery_ms": 0, "source_ns": 0} for venue in SPECS}
        self.diagnostics = {key: DecisionDiagnostics(lambda message, key=key: self.event(key, message))
                            for key in self.specs}
        # Live: real orders on Lighter (None for Paper). Realized PnL per UTC day for the daily loss limit.
        self.live = config.get("live")
        self.run_word = "LIVE" if self.live is not None else "Paper"  # in messages
        if self.live is not None:
            emitter.defer_fsync = True
        self.live_reference = None  # {"period", "equity"}: the daily loss limit's starting equity
        self.live_clean_checked = False
        self.live_start_balance = None  # Live: the real balance at the start
        self.live_account_index = None
        self.live_refusals = LiveRefusalPolicy()
        self.live_test_positions = {}  # offline tests: positions the stand-in exchange reports on top
        self.live_test_pnl = {}  # offline tests: open PnL the stand-in exchange reports
        self.live_exchange_pnl = {}  # market -> Lighter's open PnL at the last position check
        self.live_exchange_pnl_at = 0.0

    # ----- Live limits ---------------------------------------------------------------

    def live_clean_start(self, strategy):
        """A Live run starts only on an account without open positions or orders."""
        if self.live_clean_checked:
            return
        self.live_clean_checked = True
        positions = strategy.cache.positions_open(venue=strategy.exec_venue)
        orders = strategy.cache.orders_open(venue=strategy.exec_venue)
        if positions or orders:
            self.fail(f"The Lighter account already has {len(positions)} open position(s) and {len(orders)} open "
                      "order(s) not opened by this run. Close them on Lighter, then start again.")
            return
        loss = self.live.get("dailyLossLimitPercent")
        self.live_start_balance = self.venue_cash(strategy)
        self.emitter.emit("event", venue=strategy.spec.display,
                          message=f"LIVE run on Lighter mainnet: account clean; "
                                  f"{'entries at the market minimum order plus 15%, ' if self.live.get('minimumOrderSize') else ''}"
                                  f"account leverage {self.live['maxLeverage']}x, exchange-side stop "
                                  f"{self.live['exchangeStopPercent']}% from the "
                                  f"{self.live['exchangeStopFrom'].replace('_', ' ')}, "
                                  f"max slippage {self.live['maxSlippagePercent']}%, "
                                  f"max position {self.live.get('maxPositionUsdc', 'off')}"
                                  f"{' USDC' if self.live.get('maxPositionUsdc') else ''}, "
                                  f"daily loss limit {f'{loss}%' if loss else 'off'}")
        equity = self.live_account_equity()
        reference = self.live_reference_equity(equity)
        if loss and equity <= reference * (1 - Decimal(loss) / 100):
            self.fail(f"The daily loss limit of {loss}% is already used up for the day from "
                      f"{self.live_reference['period'][11:16]} UTC: equity {_usdc(equity)} USDC against {_usdc(reference)} USDC. "
                      f"LIVE can start again after {LIVE_DAY_START_HOUR_UTC:02d}:00 UTC.")

    def live_equity(self, strategy):
        """Account equity for the leverage limit: the balance plus open losses (open gains are not counted)."""
        unrealized = sum(((other.live_mark() - other.avg_open) * other.position
                          for other in self.strategies.values()
                          if other.spec.venue_key == strategy.spec.venue_key and other.position != 0), Decimal("0"))
        return self.venue_cash(strategy) + min(unrealized, Decimal("0"))

    def live_exposure(self, exclude):
        """Notional of every other market's open position and in-flight entry on the same account."""
        return sum((abs(other.position) * other.live_mark() + other.live_inflight_notional()
                    for other in self.strategies.values()
                    if other is not exclude and other.spec.venue_key == exclude.spec.venue_key), Decimal("0"))

    def live_slippage(self):
        """Order params: the run's Max slippage for a market-style order, in basis points."""
        bps = (Decimal(self.live["maxSlippagePercent"]) * 100).to_integral_value()
        return {"market_order_slippage_bps": max(1, int(bps))}

    def live_account_equity(self):
        """The account's balance plus the open PnL of every position of this run (gains count too)."""
        equity = self.venue_cash(next(iter(self.strategies.values())))
        exchange_fresh = time.monotonic() - self.live_exchange_pnl_at <= LIVE_EXCHANGE_PNL_MAX_AGE_S
        for strategy in self.strategies.values():
            quote = strategy.last_quote
            if strategy.position == 0:
                continue
            if quote is None:
                # No verified price (a data gap): Lighter's own open PnL from the last position check.
                pnl = self.live_exchange_pnl.get(strategy.spec.market) if exchange_fresh else None
                if pnl is not None:
                    equity += pnl
                continue
            exit_price = Decimal(str(quote.bid_price if strategy.position > 0 else quote.ask_price))
            equity += (exit_price - strategy.avg_open) * strategy.position
        return equity

    @staticmethod
    def live_period_start(at=None):
        """Start of the daily loss limit's day: the last 06:00 UTC."""
        at = at or datetime.now(timezone.utc)
        start = at.replace(hour=LIVE_DAY_START_HOUR_UTC, minute=0, second=0, microsecond=0)
        return start if at >= start else start - timedelta(days=1)

    def live_reference_equity(self, equity):
        """Equity the daily loss limit measures from: captured at the first start of the day and kept in
        live.stateFile, so later runs of the same day continue from it; a new day captures it anew."""
        period = self.live_period_start().isoformat(timespec="seconds")
        if self.live_reference is not None and self.live_reference["period"] == period:
            return self.live_reference["equity"]
        account = f"lighter-{self.live_account_index}" if self.live["exchange"] == "lighter" else "sandbox"
        path = Path(self.live["stateFile"])
        stored = None
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        if isinstance(stored, dict) and stored.get("account") == account and stored.get("period") == period:
            reference = Decimal(str(stored["equity"]))
            note = f"continues the day from {period[11:16]} UTC: starting equity {_usdc(reference)} USDC"
        else:
            reference = equity
            temporary = path.with_name(path.name + ".tmp")
            temporary.write_text(json.dumps({"account": account, "period": period, "equity": decimal_string(equity),
                                             "capturedAt": utc_iso()}) + "\n", encoding="utf-8")
            os.replace(temporary, path)
            note = f"new day from {period[11:16]} UTC: starting equity {_usdc(reference)} USDC"
        self.live_reference = {"period": period, "equity": reference}
        first = next(iter(self.strategies.values()))
        self.emitter.emit("event", venue=first.spec.display, message=f"LIVE daily loss limit {note}")
        return reference

    def check_live_limits(self):
        """Halt when the account equity falls live.dailyLossLimitPercent below the day's starting equity."""
        if not self.live or self.stopping or not self.live_clean_checked:
            return
        try:
            equity = self.live_account_equity()
        except ValueError:
            return  # the account is not loaded yet
        reference = self.live_reference_equity(equity)
        loss = self.live.get("dailyLossLimitPercent")
        if not loss or reference <= 0 or equity > reference * (1 - Decimal(loss) / 100):
            return
        drop = (reference - equity) / reference * 100
        self.live_halt(f"daily loss limit reached: equity {_usdc(equity)} USDC is {_usdc(drop)}% below "
                       f"{_usdc(reference)} USDC at the start of the day ({self.live_reference['period'][11:16]} UTC; "
                       f"limit {loss}%); the run stops and closes everything")

    def live_halt(self, reason):
        """Stop a Live run on a safety condition; the stop closes every position at market."""
        self.request_stop(f"LIVE halt: {reason}")

    # ----- Live position check (Lighter: after a reconnect, trust the account snapshot) ----

    def live_position_view(self):
        """Position and order revision of each market that has no order on its way."""
        return {key: (strategy.position, strategy.broker_revision) for key, strategy in self.strategies.items()
                if strategy.inflight is None and not strategy.pending_order_ids}

    async def live_exchange_positions(self):
        """(signed position, open PnL or None) per market as the exchange reports it."""
        if self.live["exchange"] == "lighter":
            return await asyncio.to_thread(lighter_positions, self.live_account_index)
        positions = {}  # offline tests: the Sandbox standing in for Lighter
        for strategy in self.strategies.values():
            signed = Decimal("0")
            for position in strategy.cache.positions_open(instrument_id=strategy.exec_id):
                qty = Decimal(str(position.quantity))
                signed += qty if str(position.side).upper().endswith("LONG") else -qty
            market = strategy.spec.market
            positions[market] = (self.live_test_positions.get(market, signed), self.live_test_pnl.get(market))
        return positions

    def check_live_orders(self):
        """Halt when an order has had no final answer from the exchange for LIVE_ORDER_NO_ANSWER_S,
        or a market's position stayed unconfirmed after an order of unknown outcome."""
        if not self.live or self.stopping:
            return
        at_ns = time.perf_counter_ns()
        at_ms = now_ms()
        at = time.monotonic()
        for strategy in self.strategies.values():
            if hasattr(strategy, "judge_lost_safety"):
                strategy.judge_lost_safety(at)
                if self.stopping:
                    return
            safety = getattr(strategy, "safety", None)
            if safety and not safety["accepted"] and at_ns - safety["sent_ns"] > LIVE_ORDER_NO_ANSWER_S * 1_000_000_000:
                self.live_halt(f"{strategy.spec.market}: Lighter has not confirmed the exchange-side stop for "
                               f"{LIVE_ORDER_NO_ANSWER_S} s; the run stops and closes everything")
                return
            since = getattr(strategy, "unconfirmed_since_ms", None)
            if since is not None and at_ms - since > LIVE_UNCONFIRMED_MAX_MS:
                self.live_halt(f"{strategy.spec.market}: Lighter did not confirm the position after an order of unknown "
                               f"outcome within {LIVE_UNCONFIRMED_MAX_MS // 1000} s; the run stops and closes everything")
                return
            state = strategy.inflight
            if state is not None and at_ns - state["sent_ns"] > LIVE_ORDER_NO_ANSWER_S * 1_000_000_000:
                self.live_halt(f"{strategy.spec.market}: order {state['id']} has had no final answer from Lighter "
                               f"for {LIVE_ORDER_NO_ANSWER_S} s; the run stops and closes everything")
                return

    def check_live_gaps(self):
        """Close the position of a market whose data gap outlasted LIVE_GAP_CLOSE_S; the others trade on."""
        if not self.live or self.stopping:
            return
        limit_ms = (3 if self.live["exchange"] == "sandbox" else LIVE_GAP_CLOSE_S) * 1000
        at = time.monotonic()
        for key, strategy in self.strategies.items():
            gap = self.recovery_gaps.get(key)
            if gap is None:
                if strategy.gap_closing:
                    strategy.gap_closing = False
                    strategy.flatten_refusals = 0
                continue
            if strategy.position == 0 or now_ms() - gap["started_ms"] < limit_ms:
                continue
            if not strategy.gap_closing:
                strategy.gap_closing = True
                self.event(key, f"LIVE: no verified {strategy.spec.market} data for {limit_ms // 1000} s with a position "
                                "open; closing it at market (the other markets trade on)")
            strategy.live_close_step(at)

    def check_live_positions(self, before, exchange):
        """Halt when a market's position differs from the exchange's twice in a row."""
        if self.stopping:
            return
        for key, (position, revision) in before.items():
            strategy = self.strategies[key]
            if strategy.inflight is not None or strategy.pending_order_ids or (
                    strategy.position, strategy.broker_revision) != (position, revision):
                continue  # an order moved while the exchange was asked: compare next time
            venue = exchange.get(strategy.spec.market, (Decimal("0"), None))[0]
            if venue == position:
                strategy.position_mismatches = 0
                if strategy.unconfirmed_since_ms is not None:
                    strategy.unconfirmed_since_ms = None
                    self.event(key, f"LIVE: Lighter confirms {decimal_string(position)} {strategy.spec.market}; "
                                    "the market trades again")
                    strategy._try_orders(now_ms())
                continue
            strategy.position_mismatches += 1
            text = f"the run counts {decimal_string(position)} {strategy.spec.market}, Lighter shows {decimal_string(venue)}"
            if strategy.position_mismatches >= LIVE_POSITION_MISMATCHES_TO_HALT:
                self.live_halt(f"{strategy.spec.market}: position differs from Lighter ({text}); the run stops and "
                               "closes what it holds — check the Lighter app")
                return
            self.event(key, f"LIVE position check: {text}; checking again")

    @property
    def recovering(self):
        """Any market is recovering; each market pauses and resumes on its own."""
        return self.recovery_started_ns is not None

    def track_recovering(self, key):
        return key in self.recovery_gaps

    def _outbox_failure(self, error):
        self.failed = True
        self.stopping = True
        self.stop_reason = f"event outbox failure: {error}"
        self.stop_event.set()
        print(self.stop_reason, file=sys.stderr, flush=True)

    def parent_gone(self, reason):
        """The controlling API is gone: keep every log in the run folder, then stop. A Live stop still
        closes every position (see live_close_all); nothing is written to the dead pipes again."""
        if not self.output_detached:
            self.output_detached = True
            self.emitter.output_closed = True
            try:
                path = Path(self.config["eventOutboxPath"]).parent / "nautilus-detached.log"
                fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                os.dup2(fd, 1)  # Nautilus logs
                os.dup2(fd, 2)
                os.close(fd)
            except OSError:
                pass
        self.request_stop(reason)

    def safe_event(self, venue_key, message):
        """An event that must never interrupt a closing sequence."""
        try:
            self.event(venue_key, message)
        except Exception as exc:
            try:
                print(f"event not recorded ({type(exc).__name__}): {message}", file=sys.stderr, flush=True)
            except Exception:
                pass

    def event(self, venue_key, message):
        spec = self.specs[venue_key]
        extra = {"market": spec.market} if self.config.get("tracks") else {}
        self.emitter.emit("event", venue=spec.display, message=message, **extra)

    def note_venue_input(self, venue, source_ns, at_ms):
        stream = self.venue_stream[venue]
        stream["delivery_ms"] = max(stream["delivery_ms"], at_ms)
        stream["source_ns"] = max(stream["source_ns"], source_ns)

    def reset_venue_stream(self, venue):
        self.venue_stream[venue] = {"delivery_ms": 0, "source_ns": 0}

    def venue_fills(self, venue):
        return sum(strategy.fills for strategy in self.strategies.values()
                   if strategy.spec.venue_key == venue)

    def venue_cash(self, strategy):
        account = strategy.cache.account_for_venue(strategy.exec_venue)
        balance = account.balance(USDC) if account else None
        if balance is None:
            raise ValueError("USDC account unavailable")
        return balance.total.as_decimal()

    def entry_fee_rate(self, venue, key=None):
        fees = self.config.get("marketFees", {}).get(key) or self.config["fees"][venue]
        return max(Decimal(str(fees["makerPercent"])), Decimal(str(fees["takerPercent"]))) / Decimal("100")

    def flush_diagnostics(self, *, force=False, reason="periodic", close=False):
        for diagnostic in self.diagnostics.values():
            if close:
                diagnostic.waits([])
            diagnostic.flush(force=force, reason=reason)

    def close_diagnostics(self, reason):
        # A diagnostics failure must never strand Stop or suppress the final
        # account snapshot. The raw process log remains a fallback if disk fails.
        try:
            self.flush_diagnostics(force=True, reason=reason, close=True)
        except Exception as exc:
            message = f"{self.run_word} diagnostic flush failed: {type(exc).__name__}: {exc}"
            self.failed = True
            self.stop_reason = self.stop_reason or message
            print(message, file=sys.stderr, flush=True)
            try:
                self.emitter.emit("failure", message=message)
            except OSError:
                pass

    def public_frame(self, venue_key, kind):
        self.public_frames[venue_key] += 1
        self.last_public_ms[venue_key] = now_ms()

    def instrument_ready(self, venue_key):
        self.instrument_ready_keys.add(venue_key)
        self.event(venue_key, f"{self.specs[venue_key].market} instrument verified" if self.live is not None
                   else f"Paper {self.specs[venue_key].market} instrument verified and published")

    def socket_state(self, endpoint, state):
        if self.socket_status.get(endpoint) == state:
            return
        self.socket_status[endpoint] = state
        key = "hyperliquid" if "hyperliquid" in endpoint.lower() else "lighter" if "lighter" in endpoint.lower() else None
        self.emitter.emit("event", venue=SPECS[key].display if key else None,
                          message=f"public socket {endpoint}: {state}")
        connected = state in ("SocketState.CONNECTED", "CONNECTED")
        if connected:
            self.connected_endpoints.add(endpoint)
            after_ns = time.time_ns()
            for track_key, spec in self.specs.items():
                if spec.venue_key == key and track_key in self.recovery_gaps and not self.stopping:
                    gap = self.recovery_gaps[track_key]
                    gap.update(connected=True, after_ns=after_ns, book_ready=False, quote_ready=False,
                               next_revive_ns=time.monotonic_ns() + REVIVE_DELAYS_MS[0] * 1_000_000)
                    gap["attempt"] += 1
                    self.strategies[track_key].invalidate_inputs(gap["after_ns"])
                    self.reset_venue_stream(key)
                    self.recovery_diagnostic("socket_connected", venue=key, market=spec.market, attempt=gap["attempt"])
        elif key and endpoint in self.connected_endpoints and not self.stopping:
            for track_key, spec in self.specs.items():
                if spec.venue_key == key:
                    self.begin_recovery(track_key)

    def begin_recovery(self, key):
        floor_ns = time.time_ns()
        if not self.recovering:
            self.recovery_started_ns = time.monotonic_ns()
            self.recovery_first_market_ready_ns = None
            self.recovery_rejection_examples.clear()
            self.recovery_rejected_books.clear()
            self.recovery_book_samples.clear()
            self.recovery_count += 1
            self.last_recovery_progress_ns = None
            self.stage = "recovering"
            self.flush_diagnostics(force=True, reason="recovery", close=True)
            self.emitter.emit("phase", stage="recovering",
                              message="Public data interrupted; the affected markets wait for reconnection and fresh market data")
        if key not in self.recovery_gaps:
            self.recovery_gaps[key] = {
                "started_ns": time.monotonic_ns(), "started_ms": now_ms(), "discarded": 0, "attempt": 0, "revives": 0,
            }
            # Only this market pauses; other markets and the other venue keep trading.
            self.strategies[key].pause_for_recovery(floor_ns)
            self.event(key, f"Public data gap started: {self.specs[key].display}; gap {self.recovery_count}; waiting for verified recovery.")
        self.recovery_gaps[key].update(connected=False, after_ns=floor_ns, book_ready=False, quote_ready=False)
        self.strategies[key].invalidate_inputs(floor_ns)
        self.reset_venue_stream(self.specs[key].venue_key)
        self.snapshot()

    def recover_silent_feed(self, key):
        """Pause on silence too; ask the existing native client to reconnect once.

        Subsequent network retries belong to that client, not a second loop.
        Full post-CONNECTED snapshots and the ordinary account audit still apply.
        """
        spec = self.specs[key]
        for track, candidate in self.specs.items():
            if candidate.venue_key == spec.venue_key:
                self.begin_recovery(track)
        self.event(key, f"Public feed silent for 60 seconds: {spec.market}; reconnect requested.")
        if self.config["mode"] == "public":
            endpoints = [endpoint for endpoint in self.connected_endpoints
                         if spec.venue_key in endpoint.lower()]
            if not endpoints:
                raise ValueError("silent feed has no known public socket to reconnect")
            for endpoint in endpoints:
                self.strategies[key].reconnect_socket(ClientId(str(spec.source_venue)), endpoint)

    def recover_silent_market(self, key):
        """One market silent while its venue still delivers the others: pause and resubscribe it alone."""
        spec = self.specs[key]
        self.begin_recovery(key)
        gap = self.recovery_gaps[key]
        after_ns = time.time_ns()
        gap.update(connected=True, after_ns=after_ns, next_revive_ns=time.monotonic_ns())
        gap["attempt"] += 1
        self.strategies[key].invalidate_inputs(after_ns)
        self.event(key, f"Public feed silent for 60 seconds: {spec.market}; requesting its order book again.")
        self.revive_stalled_tracks()

    def allow_public_frame(self, key, kind, ts_event, ts_init, complete=False):
        if self.stopping:
            return False
        gap = self.recovery_gaps.get(key)
        # System socket callbacks can overtake queued data in Nautilus. Gate
        # before publishing to PAPER_*: Sandbox consumes books before strategy.
        strategy = self.strategies[key]
        # Quotes are ordered within the BBO stream only; a newer book top may
        # already define the effective quote without making this BBO stale.
        previous = max(self.accepted_source_ns[(key, kind)],
                       strategy.last_book_event_ns if kind == "book" else strategy.last_bbo_event_ns)
        source_floor_ns = strategy.input_floor_ns - SOURCE_CLOCK_SKEW_NS
        if ts_event < max(source_floor_ns, previous) or ts_init < strategy.input_floor_ns:
            if gap:
                gap["discarded"] += 1
            reason = ("source_before_reconnect" if ts_event < source_floor_ns else
                      "received_before_reconnect" if ts_init < strategy.input_floor_ns else "source_out_of_order")
            self.diagnostics[key].skip(f"bridge_{kind}", ["initialized_before_reconnect" if reason == "received_before_reconnect" else reason],
                {"eventSourceMs": now_ms() - ts_event // 1_000_000, "eventInitMs": now_ms() - ts_init // 1_000_000})
            self.recovery_rejection(key, kind, reason, ts_event, ts_init, complete)
            return False
        if gap is None:
            self.accepted_source_ns[(key, kind)] = ts_event
            return True
        allowed = (gap["connected"] and ts_init >= gap["after_ns"]
                   and ts_event >= gap["after_ns"] - SOURCE_CLOCK_SKEW_NS)
        if kind == "book" and not gap["book_ready"] and not complete:
            allowed = False
        if not allowed:
            gap["discarded"] += 1
            self.diagnostics[key].skip(f"bridge_{kind}", ["socket_disconnected" if not gap["connected"] else "snapshot_required"],
                {"eventSourceMs": now_ms() - ts_event // 1_000_000, "eventInitMs": now_ms() - ts_init // 1_000_000})
            self.recovery_rejection(key, kind, "socket_disconnected" if not gap["connected"] else "snapshot_required",
                                    ts_event, ts_init, complete)
            return False
        if kind == "book":
            first = not gap["book_ready"]
            gap["book_ready"] = True
        else:
            first = not gap["quote_ready"]
            gap["quote_ready"] = True
        self.accepted_source_ns[(key, kind)] = ts_event
        if first:
            at_ns = time.time_ns()
            self.recovery_diagnostic(f"{kind}_accepted", venue=key, attempt=gap["attempt"],
                sourceAgeMs=(at_ns - ts_event) // 1_000_000, receiveAgeMs=(at_ns - ts_init) // 1_000_000)
        return True

    def book_sync_diagnostic(self, stage, key, **fields):
        self.recovery_diagnostic(stage, track=key, recoveryActive=self.recovering,
            started_ns=self.recovery_started_ns or time.monotonic_ns(), **fields)

    def invalidate_book_projection(self, key):
        if key not in self.book_sync_required:
            self.book_sync_diagnostic("book_projection_invalidated", key)
        self.book_sync_required[key] = None

    def recovery_rejection(self, key, kind, reason, ts_event, ts_init, complete):
        if not self.recovering:
            return
        attempt = self.recovery_gaps.get(key, {}).get("attempt", 0)
        example = (key, kind, reason, attempt)
        if example in self.recovery_rejection_examples:
            return
        self.recovery_rejection_examples.add(example)
        at_ns = time.time_ns()
        self.recovery_diagnostic(f"{kind}_rejected", venue=key, attempt=attempt, reason=reason,
            sourceAgeMs=(at_ns - ts_event) // 1_000_000, receiveAgeMs=(at_ns - ts_init) // 1_000_000,
            complete=bool(complete))

    def record_invalid_book(self, strategy, *, final=False):
        from book_diagnostics import book_state, quote_state

        key = strategy.spec.key
        at_ns = time.monotonic_ns()
        previous = self.recovery_book_samples.get(key)
        if not final and previous is not None and at_ns - previous < 5_000_000_000:
            return
        self.recovery_book_samples[key] = at_ns
        # Separate bounded rows share one sample id. These are DataEngine's
        # source and PAPER caches, not direct inspection of Sandbox's private
        # matching-engine liquidity-consumption state.
        sample = f"{self.recovery_count}:{key}:{at_ns}"
        common = {"track": key, "sample": sample, "final": final}
        views = ((("source", strategy.spec.source_id),) if self.live is not None
                 else (("paper", strategy.spec.paper_id), ("source", strategy.spec.source_id)))
        for view, instrument in views:
            self.recovery_diagnostic("book_invalid_detail", **common, view=view,
                book=book_state(strategy.cache.order_book(instrument)))
        self.recovery_diagnostic("book_invalid_detail", **common, view="inputs",
            quote=quote_state(strategy.last_quote), bookRevision=strategy.book_revision,
            sourceFloorNs=strategy.input_floor_ns, lastBookSourceNs=strategy.last_book_event_ns,
            lastBookDeliveryMs=strategy.last_book_ms, ages=strategy.input_diagnostics()[1])

    def recovery_diagnostic(self, stage, *, started_ns=None, **fields):
        # Keep this inside the existing durable event envelope. UI projection
        # hides the technical rows before applying its recent-activity limit.
        origin = self.recovery_started_ns if started_ns is None else started_ns
        elapsed = (time.monotonic_ns() - origin) // 1_000_000
        payload = {"gap": self.recovery_count, "elapsedMs": elapsed, "stage": stage, **fields}
        def emit(body):
            message = "Recovery diagnostic: " + json.dumps(body, separators=(",", ":"))
            if len(message) > 2048:
                raise ValueError("recovery diagnostic exceeds bounded message size")
            self.emitter.emit("event", message=message)
        if len(json.dumps(payload)) < 1800:
            emit(payload)
        else:
            # Ten markets must not overflow the existing durable event contract.
            ages = payload.pop("ages", {})
            blockers = payload.pop("blockedBy", [])
            global_blockers = [reason for reason in blockers if "." not in reason]
            for key in self.specs:
                emit({**payload, "track": key, "ages": {key: ages.get(key, {})},
                      "blockedBy": global_blockers + [reason for reason in blockers if reason.startswith(key + ".")]})

    def recovery_input_state(self):
        blockers, ages = [], {}
        for key, gap in self.recovery_gaps.items():
            # A complete post-reconnect book snapshot also yields the first
            # quote (its top of book); a quiet market need not send a BBO.
            for flag, reason in (("connected", "socket_disconnected"), ("book_ready", "snapshot_missing")):
                if not gap[flag]:
                    blockers.append(f"{key}.{reason}")
        if not self.recovery_gaps:
            blockers.append("gap_missing")
        blockers.extend(self.recovery_input_blockers())
        at_ms = now_ms()
        for key, strategy in self.strategies.items():
            reasons, ages[key] = strategy.input_diagnostics(at_ms)
            blockers.extend(f"{key}.{reason}" for reason in reasons)
        return blockers, ages

    def split_recovery_blockers(self, blockers):
        """Blockers of each recovering market, and those that hold every market."""
        own = {key: [reason for reason in blockers if reason.startswith(f"{key}.")] for key in self.recovery_gaps}
        shared = [reason for reason in blockers if not any(reason.startswith(f"{key}.") for key in self.specs)]
        return own, shared

    def observe_recovery_inputs(self):
        # Evaluate on actual strategy delivery, after Sandbox processed the book.
        # A usable sub-500ms window must not be lost between watchdog polls.
        if self.stopping:
            return
        blockers, ages = self.recovery_input_state()
        own, shared = self.split_recovery_blockers(blockers)
        if not shared and any(not reasons for reasons in own.values()):
            if self.recovery_first_market_ready_ns is None:
                self.recovery_first_market_ready_ns = time.monotonic_ns()
                self.recovery_diagnostic("market_ready", blockedBy=[], ages=ages)
            self.check_recovery(log_wait=False)

    def check_recovery(self, *, log_wait=True):
        if not self.recovering or self.stopping:
            return
        # A network outage is a trading pause, not account/process expiry.
        # Keep checks frequent, but bound repetitive durable diagnostics during
        # an hours-long outage. Milestone/error events still log immediately.
        at_ns = time.monotonic_ns()
        log_wait = log_wait and (self.last_recovery_progress_ns is None
            or (at_ns - self.last_recovery_progress_ns) // 1_000_000 >= RECOVERY_PROGRESS_MS)
        if log_wait:
            self.last_recovery_progress_ns = at_ns
        blockers, ages = self.recovery_input_state()
        own, shared = self.split_recovery_blockers(blockers)
        waiting, resumed, audited = list(shared), [], False
        audit_started_ns = time.monotonic_ns()
        try:
            for key in list(self.recovery_gaps):
                if shared or own[key]:
                    waiting.extend(own[key])
                    continue
                # Each market resumes as soon as its own data and account audit are verified.
                strategy = self.strategies[key]
                audited = True
                if not strategy.recovery_audit_ready():
                    waiting.append(f"{key}.{strategy.recovery_audit_blocker}")
                    continue
                strategy.resume_after_recovery()
                resumed.append(key)
        except Exception as exc:
            self.fail(f"{self.run_word} recovery account audit failed: {type(exc).__name__}: {exc}")
            return
        audit_ms = (time.monotonic_ns() - audit_started_ns) / 1_000_000
        for key in resumed:
            gap = self.recovery_gaps.pop(key)
            duration = (time.monotonic_ns() - gap["started_ns"]) // 1_000_000
            self.event(key, f"Public data gap recovered: {self.specs[key].display}; gap {self.recovery_count}; duration {duration} ms; discarded {gap['discarded']} observations.")
        if self.recovery_gaps:
            if log_wait or resumed:
                self.recovery_diagnostic("check", blockedBy=waiting, ages=ages,
                                         audit="partial" if resumed else "waiting" if audited else "not_run", auditMs=audit_ms,
                                         resumed=resumed, waitingFor=sorted(self.recovery_gaps))
            if resumed:
                self.snapshot()
            return
        started_ns = self.recovery_started_ns
        first_ready_ms = ((self.recovery_first_market_ready_ns - started_ns) // 1_000_000
                          if self.recovery_first_market_ready_ns is not None else None)
        self.recovery_started_ns = None
        self.stage = "running"
        self.recovery_diagnostic("resumed", started_ns=started_ns, blockedBy=[], ages=ages,
            auditMs=audit_ms, firstMarketReadyMs=first_ready_ms)
        self.emitter.emit("phase", stage="running", message="Public data recovered"
                          + ("" if self.live is not None else "; Paper accounts preserved"))
        self.snapshot()

    def revive_stalled_tracks(self):
        """Reconnected markets still without a fresh book: ask the venue again, one market at a time.

        Both venues answer an unsubscribe + subscribe of one market's book on the same
        connection with a full snapshot.
        """
        if self.stopping or self.config["mode"] != "public":
            return
        at_ns = time.monotonic_ns()
        for key, gap in list(self.recovery_gaps.items()):
            if not gap.get("connected") or gap.get("book_ready") or at_ns < gap.get("next_revive_ns", at_ns + 1):
                continue
            gap["revives"] += 1
            attempt = gap["revives"]
            gap["next_revive_ns"] = at_ns + REVIVE_DELAYS_MS[min(attempt, len(REVIVE_DELAYS_MS) - 1)] * 1_000_000
            spec = self.specs[key]
            self.event(key, f"{spec.market}: no fresh order book since the reconnect; resubscribing (attempt {attempt}).")
            self.bridges[key].resubscribe_book()
            self.snapshot()

    # ----- strategy-kind hooks (the native strategy overrides them) -----------

    def strategy_class(self):
        return SdkTrackStrategy if self.python else PineTrackStrategy

    def on_tick(self, at_ms):
        """Watchdog tick: closed bars gate Pine entries until their order set arrives."""
        if self.pine:
            self.bar_boundary(at_ms)
        for strategy in self.strategies.values():
            flush = getattr(strategy, "flush_logs", None)
            if flush is not None:
                strategy._guard("log flush", flush)

    def extra_command(self, command, item):
        """A strategy-specific stdin command; False when unknown."""
        return False

    def recovery_input_blockers(self):
        """Extra inputs a strategy kind needs before recovery completes."""
        return []

    def fail(self, message, venue_key=None):
        if self.failed:
            return
        self.failed = True
        self.stopping = True
        self.stop_reason = message
        try:
            self.record_unresolved_gaps()
            extra = ({"market": self.specs[venue_key].market}
                     if venue_key and self.config.get("tracks") else {})
            self.emitter.emit("failure", venue=self.specs[venue_key].display if venue_key else None,
                              message=message, **extra)
            self.emitter.emit("phase", stage="stopping", message="LIVE run interrupted" if self.live is not None
                              else "Both virtual accounts interrupted")
        except OSError:
            pass
        finally:
            try:
                self.close_diagnostics("failure")
            finally:
                self.stage = "stopping"
                self.stop_event.set()

    def request_stop(self, reason):
        if self.stopping:
            return
        self.stopping = True
        self.stop_reason = reason
        self.stage = "stopping"
        try:
            self.record_unresolved_gaps()
            self.emitter.emit("phase", stage="stopping", message=(f"Stopping LIVE; closing every position on Lighter: {reason}"
                              if self.live is not None else f"Stopping both Paper accounts: {reason}"))
        except OSError:
            pass
        finally:
            try:
                self.close_diagnostics("stop")
            finally:
                self.stop_event.set()

    def record_unresolved_gaps(self):
        for key, gap in self.recovery_gaps.items():
            if gap.get("ended"):
                continue
            duration = (time.monotonic_ns() - gap["started_ns"]) // 1_000_000
            gap["ended"] = True
            self.event(key, f"Public data gap ended without recovery: {self.specs[key].display}; gap {self.recovery_count}; duration {duration} ms; discarded {gap['discarded']} observations.")

    def material_state(self):
        return (self.stage, tuple(
            (key, strategy.fills, strategy.manager.pending_count(), str(strategy.position), bool(strategy.fresh()))
            for key, strategy in self.strategies.items()))

    def has_open_positions(self):
        return any(strategy.cache.positions_open(instrument_id=strategy.exec_id)
                   for strategy in self.strategies.values())

    def snapshot(self):
        accounts, tracks = [], []
        counters = ("brokerRevision", "publicFrames", "pendingOrders", "signals", "intents", "fills",
                    "rejectedSignals", "stalePriceObservationsSkipped")
        for venue, venue_spec in SPECS.items():
            rows = []
            for key, spec in self.specs.items():
                if spec.venue_key != venue:
                    continue
                strategy = self.strategies.get(key)
                row = strategy.account_snapshot() if strategy else {
                    "venue": spec.display, "cashBalance": self.config["capitalPerVenue"],
                    **{name: 0 for name in counters}, "priceReady": False, "positions": [],
                }
                rows.append(row)
                gap = self.recovery_gaps.get(key)
                tracks.append({"venue": spec.display, "market": spec.market,
                    **{name: row[name] for name in counters if name != "brokerRevision"}, "priceReady": row["priceReady"],
                    # A market waiting for data after a gap; the page lists it with its age and retries.
                    **({"dataGap": {"sinceMs": gap["started_ms"], "connected": bool(gap.get("connected")),
                                    "resubscribes": gap["revives"]}} if gap else {})})
            if not rows:
                # A venue without selected markets keeps its untouched account.
                accounts.append({"venue": venue_spec.display, "cashBalance": self.config["capitalPerVenue"],
                    **{name: 0 for name in counters}, "priceReady": True, "positions": []})
                continue
            cash_values = {row["cashBalance"] for row in rows}
            if len(cash_values) != 1:
                raise ValueError("markets disagree on shared venue balance")
            accounts.append({"venue": venue_spec.display, "cashBalance": rows[0]["cashBalance"],
                **({"startBalance": rows[0]["startBalance"]} if "startBalance" in rows[0] else {}),
                **{name: sum(row[name] for row in rows) for name in counters},
                "priceReady": all(row["priceReady"] for row in rows),
                "positions": [position for row in rows for position in row["positions"]]})
        # Legacy HYPE-only clients/tests accept the original envelope unchanged.
        extra = {"tracks": tracks} if self.config.get("tracks") else {}
        self.emitter.emit("snapshot", stage=self.stage, accounts=accounts, **extra)

    def strategy_bars(self, item, live):
        if not self.python:
            raise ValueError("bars are accepted only by a Python strategy run")
        key = track_key(item.get("venue"), item.get("market"))
        if key not in self.strategies:
            raise ValueError("bars for an unselected track")
        if self.stopping:
            return
        strategy = self.strategies[key]
        strategy._guard("strategy bars", lambda: strategy.receive_bars(item.get("bars"), live))

    def pine_orders(self, item):
        if not self.pine or self.python:
            raise ValueError("Pine order sets require the Pine runtime")
        venue = item.get("venue")
        key = track_key(venue, item.get("market"))
        if key not in self.strategies:
            raise ValueError("Pine order set for an unselected track")
        if self.stopping:
            return
        self.strategies[key]._guard("Pine order set", lambda: self.strategies[key].apply_orders(item))

    def bar_boundary(self, at_ms):
        frame = self.config["timeframeMs"]
        boundary = at_ms // frame * frame
        if self.last_boundary_ms is None:
            self.last_boundary_ms = boundary
            return
        if boundary > self.last_boundary_ms:
            self.last_boundary_ms = boundary
            for strategy in self.strategies.values():
                strategy.bar_boundary(boundary)



def make_controller(config, emitter):
    """The run controller for the configured strategy kind."""
    if config.get("nativeStrategy") in (PINE_STRATEGY, PYTHON_STRATEGY):
        return RuntimeController(config, emitter)
    native = native_module()
    controller_class = type("NativeController", (native.NativeControllerMixin, RuntimeController), {})
    return controller_class(config, emitter)


def parent_alive(parent_pid):
    if os.getppid() != parent_pid:
        return False
    try:
        os.kill(parent_pid, 0)
        return True
    except OSError as exc:
        return exc.errno == errno.EPERM


def build_node(config, controller):
    if config["mode"] == "public" and config.get("hyperliquidFastBook", False):
        require_fast_book_support()
    feeds = {}
    offline_sources = {}
    live = config.get("live")
    real = live is not None and live["exchange"] == "lighter"
    builder = (LiveNode.builder(
        f"PSR-PAPER-{config['runId'][:8]}", TraderId("PSR-PAPER-001"), Environment.LIVE if real else Environment.SANDBOX,
    ).with_delay_post_stop_secs(0).with_timeout_connection(30 if real else 20))
    # Live starts from the account as the exchange reports it (open orders, positions, fills).
    builder = (builder.with_reconciliation(True).with_timeout_reconciliation(120).with_reconciliation_lookback_mins(1440)
               if real else builder.with_reconciliation(False))
    for key, spec in SPECS.items():
        venue_specs = [track for track in controller.specs.values() if track.venue_key == key]
        if not venue_specs:
            continue  # a Pine run may use one venue only
        if config["mode"] == "public":
            if key == "lighter":
                factory = LighterDataClientFactory()
                source_config = LighterDataClientConfig(
                    environment=LighterEnvironment.MAINNET,
                    deployment=LighterDeployment.LIGHTER,
                )
            else:
                factory = HyperliquidDataClientFactory()
                source_config = HyperliquidDataClientConfig(environment=HyperliquidEnvironment.MAINNET)
        else:
            factory = OfflineSourceFactory(venue_specs, offline_sources)
            source_config = DataClientConfig()
        builder = builder.add_data_client(
            str(spec.source_venue), factory, source_config,
            RoutingConfig(default=False, venues=[str(spec.source_venue)]),
        )
        builder = builder.add_data_client(
            str(spec.paper_venue), PaperFeedFactory(venue_specs, feeds), DataClientConfig(),
            RoutingConfig(default=False, venues=[str(spec.paper_venue)]),
        )
        if live is not None and real:
            account_index, key_index, secret = live_credentials()
            controller.live_account_index = account_index
            builder = builder.add_exec_client(
                str(spec.source_venue), LighterExecutionClientFactory(),
                LighterExecutionClientConfig(
                    account_id=AccountId(f"LIGHTER-{account_index}"), account_index=account_index,
                    api_key_index=key_index, private_key=secret,
                    environment=LighterEnvironment.MAINNET,
                    deployment=LighterDeployment.LIGHTER,
                ))
            del secret
            continue
        fee_row = config["fees"][key]
        maker_rate = Decimal(str(fee_row["makerPercent"])) / Decimal("100")
        taker_rate = Decimal(str(fee_row["takerPercent"])) / Decimal("100")
        overrides = {(track.source_id if live is not None else track.paper_id): (Decimal(str(row["makerPercent"])) / Decimal("100"),
                                      Decimal(str(row["takerPercent"])) / Decimal("100"))
                     for track in venue_specs
                     for row in [config.get("marketFees", {}).get(track.key)] if row}
        # Paper fills on the Sandbox copy; an offline Live test fills the same way on LIGHTER itself.
        exec_venue = spec.source_venue if live is not None else spec.paper_venue
        builder = builder.add_simulated_exec_client(
            str(exec_venue), SandboxExecutionClientFactory(),
            SandboxExecutionClientConfig(
                venue=exec_venue,
                starting_balances=[Money(Decimal(config["capitalPerVenue"]), USDC)],
                account_type=AccountType.MARGIN, oms_type=OmsType.NETTING,
                # An offline Live test stands in for Lighter's cross margin; Paper trades its own cash.
                default_leverage=LIVE_MAX_LEVERAGE if live is not None else Decimal("1"), book_type=BookType.L2_MBP,
                trade_execution=False, bar_execution=False,
                liquidity_consumption=True,
                fee_model=MakerTakerFeeModel(maker_rate, taker_rate, overrides or None),
            ),
        )
    node = builder.build()
    for key, spec in controller.specs.items():
        node.add_strategy(PublicBridge((spec, feeds, controller)))
    strategy_class = controller.strategy_class()
    for key, spec in controller.specs.items():
        strategy = strategy_class((spec, controller, config))
        node.add_strategy(strategy)
        controller.strategies[key] = strategy
    return node, offline_sources


async def monitor_stdin(controller, offline_sources):
    fd = sys.stdin.fileno()
    os.set_blocking(fd, False)
    buffer = b""
    # Offline tests keep feeding books while a run stops (a live venue keeps streaming them).
    while not controller.stop_event.is_set() or controller.config["mode"] == "offline":
        try:
            chunk = os.read(fd, 65_536)
        except BlockingIOError:
            await asyncio.sleep(0.02)
            continue
        if not chunk:
            reason = "stdin EOF / controlling API disconnected"
            # A parent that only closed stdin may still read the events; a dead one cannot.
            if parent_alive(controller.config["parentPid"]):
                controller.request_stop(reason)
            else:
                controller.parent_gone(reason)
            return
        buffer += chunk
        if len(buffer) > 1_048_576:
            controller.fail("stdin command exceeded 1 MiB")
            return
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                if not isinstance(item, dict):
                    raise ValueError("command must be a JSON object")
                command = item.get("cmd")
                if command == "stop":
                    controller.request_stop(str(item.get("reason", "user"))[:200])
                    if controller.config["mode"] != "offline":
                        return
                    continue  # offline tests keep feeding books while the run stops
                if controller.extra_command(command, item):
                    continue
                if command in ("bars", "bar"):
                    controller.strategy_bars(item, command == "bar")
                    continue
                if command == "pine_orders":
                    controller.pine_orders(item)
                    continue
                if command == "socket" and controller.config["mode"] == "offline":
                    venue, state = item["venue"], item["state"]
                    if venue not in SPECS or state not in ("CONNECTED", "DISCONNECTED"):
                        raise ValueError("invalid offline socket state")
                    controller.socket_state(f"{venue}-data-streams", state)
                elif command == "snapshot" and controller.config["mode"] == "offline":
                    controller.snapshot()
                elif command == "live_exchange_position" and controller.config["mode"] == "offline" and controller.live:
                    controller.live_test_positions[str(item["market"])] = Decimal(str(item["quantity"]))
                elif command == "live_exchange_pnl" and controller.config["mode"] == "offline" and controller.live:
                    controller.live_test_pnl[str(item["market"])] = Decimal(str(item["pnl"]))
                elif command == "live_test_drop_safety" and controller.config["mode"] == "offline" and controller.live:
                    # Offline test: the stand-in exchange removes the exchange-side stop on its own.
                    strategy = controller.strategies[track_key("lighter", str(item["market"]))]
                    strategy.cancel_order(ClientOrderId.from_str(strategy.safety["id"]))
                elif command == "live_test_hold_fill" and controller.config["mode"] == "offline" and controller.live:
                    controller.strategies[track_key("lighter", str(item["market"]))].test_hold_fill = True
                elif command == "trade" and controller.config["mode"] == "offline":
                    key = track_key(item["venue"], item.get("market", "HYPE"))
                    if key not in controller.specs or key not in offline_sources:
                        raise ValueError("offline source not ready")
                    offline_sources[key].publish_trade(item["price"], item["size"], market=item.get("market", "HYPE"))
                elif command == "frame" and controller.config["mode"] == "offline":
                    venue = item["venue"]
                    key = track_key(venue, item.get("market", "HYPE"))
                    if key not in controller.specs or key not in offline_sources:
                        raise ValueError("offline source not ready")
                    offline_sources[key].publish_frame(item["bids"], item["asks"], market=item.get("market", "HYPE"),
                        part=item.get("part", "both"), snapshot=item.get("snapshot", True), age_ms=item.get("ageMs", 0),
                        source_lag_ms=item.get("sourceLagMs", 0))
                else:
                    raise ValueError(f"unsupported command: {command}")
            except Exception as exc:
                controller.fail(f"stdin command failed: {type(exc).__name__}: {exc}")
                return


async def watchdog(controller, node_task):
    last_snapshot = 0
    last_signature = None
    while not controller.stop_event.is_set():
        await asyncio.sleep(0.5)
        if controller.stop_event.is_set() or controller.stopping:
            # Stop/failure owns shutdown; a node stopping now is expected.
            return
        if not parent_alive(controller.config["parentPid"]):
            controller.parent_gone("controlling API process died")
            return
        try:
            controller.check_live_limits()
            controller.check_live_orders()
            controller.check_live_gaps()
            controller.on_tick(now_ms())
            controller.emitter.sync()
        except Exception as exc:
            controller.fail(f"bar/day boundary handling failed: {type(exc).__name__}: {exc}")
            return
        if node_task.done():
            try:
                await node_task
                controller.fail("Nautilus node stopped unexpectedly")
            except Exception as exc:
                controller.fail(f"Nautilus node failed: {type(exc).__name__}: {exc}")
            return
        at_ms = now_ms()
        try:
            controller.revive_stalled_tracks()
            controller.check_recovery()
        except Exception as exc:
            controller.fail(f"{controller.run_word} recovery check failed: {type(exc).__name__}: {exc}")
            return
        if controller.stopping:
            return
        try:
            for strategy in controller.strategies.values():
                strategy.observe_diagnostics()
            controller.flush_diagnostics()
        except Exception as exc:
            controller.fail(f"{controller.run_word} diagnostics failed: {type(exc).__name__}: {exc}")
            return
        for key in controller.specs:
            if controller.track_recovering(key):
                continue
            last = controller.last_public_ms[key]
            if last is None and at_ms - controller.started_ms > 30_000:
                controller.fail(f"{controller.specs[key].display} {controller.specs[key].market} public feed produced no frames for 30 seconds", key)
                return
            if last is not None and at_ms - last > 60_000:
                venue = controller.specs[key].venue_key
                # The whole venue silent means a broken socket; one silent market is resubscribed alone.
                venue_silent = all(
                    controller.track_recovering(other) or (controller.last_public_ms[other] is not None
                                                           and at_ms - controller.last_public_ms[other] > 60_000)
                    for other, spec in controller.specs.items() if spec.venue_key == venue)
                try:
                    if venue_silent:
                        controller.recover_silent_feed(key)
                    else:
                        controller.recover_silent_market(key)
                except Exception as exc:
                    controller.fail(f"Public reconnect request failed: {type(exc).__name__}: {exc}", key)
                    return
                break
        if controller.stage == "waiting_for_data" and all(
            strategy.fresh(at_ms) for strategy in controller.strategies.values()
        ) and len(controller.instrument_ready_keys) == len(controller.specs):
            controller.stage = "running"
            controller.emitter.emit("phase", stage="running", message="All selected markets have fresh public data"
                                    if controller.live is not None else "All selected Paper markets have fresh public data")
        # Periodic snapshots every 5 s while accounts/orders change, otherwise
        # every 15 s; fills, recovery and phase changes emit their own.
        signature = controller.material_state()
        # Open positions refresh every 5 s so their unrealized PnL stays current.
        if at_ms - last_snapshot >= (5_000 if signature != last_signature or controller.has_open_positions()
                                     else SNAPSHOT_IDLE_MS):
            controller.snapshot()
            last_snapshot, last_signature = at_ms, signature


async def live_position_check(controller):
    """Live: compare every idle market's position with the exchange's account (LIVE_POSITION_CHECK_S).

    The exchange is asked off the event loop; an unanswered request only delays the next check.
    """
    interval = 1.0 if controller.live["exchange"] == "sandbox" else LIVE_POSITION_CHECK_S
    failures = 0
    while not controller.stop_event.is_set():
        await asyncio.sleep(interval)
        if controller.stopping or controller.stage not in ("running", "recovering"):
            continue  # a data gap does not stop it: it needs Lighter's account, not prices
        before = controller.live_position_view()
        try:
            exchange = await controller.live_exchange_positions()
        except Exception as exc:
            failures += 1
            limited = getattr(exc, "code", None) in (429, 405)  # Lighter's rate limit
            if limited or failures == 1 or failures % 30 == 0:
                controller.emitter.emit("event", venue="Lighter", message=(
                    f"LIVE position check: Lighter account not available ({type(exc).__name__}: {exc}); "
                    + ("Lighter's request limit: next check in 60 s; " if limited else "") + "trading continues"))
            if limited:
                await asyncio.sleep(60)  # Lighter's cooldown; checks resume after it
            continue
        failures = 0
        controller.live_exchange_pnl = {market: pnl for market, (_, pnl) in exchange.items() if pnl is not None}
        controller.live_exchange_pnl_at = time.monotonic()
        try:
            controller.check_live_positions(before, exchange)
        except Exception as exc:
            controller.fail(f"Live position check failed: {type(exc).__name__}: {exc}")
            return


async def live_close_all(controller):
    """Live stop: close every position at market (reduce-only), then remove this run's orders.

    A position that did not close within LIVE_FLATTEN_WAIT_S keeps its exchange-side stop and is
    named in the stop reason, to be closed in the Lighter app. Every market closes on its own: a failure on one (or a log line that
    cannot be written) never stops the others.
    """
    await asyncio.sleep(0.5)  # cancels of working engine orders settle first
    deadline = time.monotonic() + LIVE_FLATTEN_WAIT_S
    while time.monotonic() < deadline:
        open_markets = [strategy for strategy in controller.strategies.values()
                        if strategy.position != 0 and not strategy.flatten_gave_up]
        if not open_markets:
            break
        at = time.monotonic()
        for strategy in open_markets:
            try:
                strategy.live_close_step(at)  # the first close at once, then the rest after each answer
            except Exception as exc:
                controller.safe_event(strategy.spec.key, f"LIVE close failed: {type(exc).__name__}: {exc}")
        await asyncio.sleep(0.2)
    still_open = []
    for strategy in controller.strategies.values():
        if strategy.position != 0:
            # An accepted exchange-side stop stays on Lighter and keeps protecting it.
            still_open.append(f"{strategy.spec.market} {decimal_string(strategy.position)} ("
                              + ("its exchange-side stop stays on Lighter" if strategy.safety_resting()
                                 else "no exchange-side stop") + ")")
            continue
        try:
            strategy.live_cleanup()
        except Exception as exc:
            controller.safe_event(strategy.spec.key, f"LIVE order cleanup failed: {type(exc).__name__}: {exc}")
    await asyncio.sleep(1.0)  # the cancels reach the exchange before the node stops
    # The stop's outcome ends the stop reason, so the API and the run page state it (owner decision 2026-10-16).
    if still_open:
        note = (f"LIVE: positions still open on Lighter after the stop: {', '.join(still_open)} — close them in "
                "the Lighter app")
    else:
        note = "LIVE: every position of this run is closed on Lighter"
    controller.stop_reason = f"{controller.stop_reason or 'stopped'}; {note}"
    for strategy in controller.strategies.values():
        controller.safe_event(strategy.spec.key, note)
        break


async def run(config, emitter):
    for key in list(os.environ):
        if key.startswith(("HYPERLIQUID_", "LIGHTER_")):
            del os.environ[key]
    controller = make_controller(config, emitter)
    node = None
    node_task = None
    stdin_task = None
    watchdog_task = None
    check_task = None
    try:
        node, offline_sources = build_node(config, controller)
        controller.emitter.emit("phase", stage="waiting_for_data", message=(
            "LIVE: Nautilus starting with the real Lighter account" if controller.live is not None
            else "Nautilus Sandbox starting selected markets on two shared venue accounts"))
        # Reported on the first Hyperliquid track: a run need not include HYPE (or Hyperliquid at all).
        hyperliquid_track = next((key for key, spec in controller.specs.items() if spec.venue_key == "hyperliquid"), None)
        if config["mode"] == "public" and config.get("hyperliquidFastBook", False) and hyperliquid_track:
            controller.event(hyperliquid_track, "Hyperliquid fast book selected: five levels per side; BBO unchanged")
        controller.snapshot()
        node_task = asyncio.create_task(node.run_async(), name="nautilus-node")
        stdin_task = asyncio.create_task(monitor_stdin(controller, offline_sources), name="stdin-commands")
        watchdog_task = asyncio.create_task(watchdog(controller, node_task), name="runtime-watchdog")
        if controller.live:
            check_task = asyncio.create_task(live_position_check(controller), name="live-position-check")
        loop = asyncio.get_running_loop()
        try:
            loop.add_signal_handler(os_signal.SIGTERM, lambda: controller.request_stop("SIGTERM"))
        except NotImplementedError:
            pass
        await controller.stop_event.wait()
    except Exception as exc:
        controller.fail(f"sidecar failure: {type(exc).__name__}: {exc}")
    finally:
        controller.stopping = True
        controller.stage = "stopping"
        for strategy in controller.strategies.values():
            try:
                strategy.stop_new_orders()
            except Exception as exc:
                controller.fail(f"cancel pending {controller.run_word} order failed: {type(exc).__name__}: {exc}")
        if controller.live and node_task is not None and not node_task.done():
            try:
                await live_close_all(controller)
            except Exception as exc:  # the node still stops below
                print(f"LIVE close-all failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        if node_task is not None:
            await asyncio.sleep(0.35)
            if node is not None:
                node.handle().stop()
            try:
                await asyncio.wait_for(asyncio.shield(node_task), timeout=20)
            except Exception as exc:
                controller.fail(f"Nautilus shutdown incomplete: {type(exc).__name__}: {exc}")
        for task in (stdin_task, watchdog_task, check_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        try:
            for strategy in controller.strategies.values():
                flush = getattr(strategy, "flush_logs", None)
                if flush is not None:
                    flush()
            controller.close_diagnostics("shutdown")
            controller.snapshot()
            pending = sum(len(strategy.pending_order_ids) for strategy in controller.strategies.values())
            if pending:
                controller.fail(f"{pending} {controller.run_word} order(s) remained unresolved at Stop")
            controller.emitter.emit("stopped", reason=controller.stop_reason or "completed")
        finally:
            if node is not None:
                node.dispose()


def main():
    parser = argparse.ArgumentParser(description="Five-market Nautilus Sandbox sidecar")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--check-fast-book", action="store_true")
    args = parser.parse_args()
    if nautilus_trader.__version__ == PINNED_FAST_NAUTILUS:
        require_fast_book_support()
    elif nautilus_trader.__version__ != PINNED_NAUTILUS:
        raise SystemExit(f"Expected qualified Nautilus build, got {nautilus_trader.__version__}")
    if args.check_fast_book:
        require_fast_book_support()
        print(f"PSR_FAST_BOOK_OK={PINNED_FAST_NAUTILUS}", flush=True)
        return
    if args.check:
        print(f"PSR_RUNTIME_OK={nautilus_trader.__version__}", flush=True)
        return
    if args.config is None:
        parser.error("--config is required unless --check is used")
    config = validate_config(json.loads(args.config.read_text(encoding="utf-8")))
    if not parent_alive(config["parentPid"]):
        raise SystemExit("controlling API parent PID is not alive")
    # Preserve the machine-readable pipe. Nautilus' native logger writes to fd
    # 1; redirect that fd to stderr before constructing/starting its node.
    event_fd = os.dup(1)
    os.dup2(2, 1)
    directory = Path(config["eventOutboxPath"]).parent
    write_child_identity(config["runId"], config["parentPid"], directory)
    emitter = EventEmitter(config["runId"], event_fd, Path(config["eventOutboxPath"]))
    try:
        asyncio.run(run(config, emitter))
    finally:
        emitter.close()
        os.close(event_fd)


if __name__ == "__main__":
    main()
