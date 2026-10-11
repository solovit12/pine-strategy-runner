"""Public strategy API of Pine Strategy Runner.

A strategy is a Python class. It receives closed bars, live best bid/ask and
its own fills, and places orders through `ctx`. The order model mirrors Pine
(`strategy.entry`, `strategy.exit`, `strategy.close`, `strategy.cancel`), so
Pine and Python strategies are executed by the very same real-time engine:

    from psr_sdk import Param, Strategy

    class EmaCross(Strategy):
        name = "EMA cross"
        timeframe = "15m"
        params = {"fast": Param(int, 12, min=2), "slow": Param(int, 26, min=3)}

        def on_bar(self, ctx, bar):
            ...
            ctx.entry("L", "long")
            ctx.exit("XL", "L", profit_ticks=300, loss_ticks=150)

Execution is real time: market orders arrive ~200 ms after they are placed,
limit orders fill when the opposite best price reaches them, stops trigger on
the live best price and execute 300 ms later. Entry size is the Paper
"order size" percent of the venue account (optionally scaled per entry).
"""

from dataclasses import dataclass
import math

TIMEFRAMES = ("1m", "5m", "15m", "30m", "1h", "4h", "1d")


@dataclass(frozen=True)
class Param:
    """A user-adjustable strategy parameter shown in the Paper form."""
    kind: type
    default: object
    min: float | None = None
    max: float | None = None
    choices: tuple | None = None
    label: str = ""
    help: str = ""

    def __post_init__(self):
        if self.kind not in (int, float, bool, str):
            raise TypeError("Param kind must be int, float, bool or str")
        self.validate("default", self.default)

    def validate(self, name, value):
        if self.kind is bool:
            if not isinstance(value, bool):
                raise ValueError(f"{name} must be true or false")
            return value
        if self.kind is int:
            if isinstance(value, bool) or not isinstance(value, int):
                if isinstance(value, float) and value.is_integer():
                    value = int(value)
                else:
                    raise ValueError(f"{name} must be an integer")
        elif self.kind is float:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{name} must be a finite number")
            value = float(value)
        elif not isinstance(value, str):
            raise ValueError(f"{name} must be text")
        if self.choices is not None and value not in self.choices:
            raise ValueError(f"{name} must be one of {', '.join(map(str, self.choices))}")
        if self.min is not None and value < self.min:
            raise ValueError(f"{name} must be at least {self.min}")
        if self.max is not None and value > self.max:
            raise ValueError(f"{name} must be at most {self.max}")
        return value

    def describe(self):
        return {"type": self.kind.__name__, "default": self.default, "min": self.min, "max": self.max,
                "choices": list(self.choices) if self.choices else None, "label": self.label, "help": self.help}


@dataclass(frozen=True)
class Bar:
    """One closed candle of the strategy timeframe (venue candles, UTC)."""
    open_time: int  # epoch ms
    close_time: int  # exclusive end, epoch ms
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class Quote:
    bid: float
    ask: float
    time_ms: int


@dataclass(frozen=True)
class Fill:
    """A real Paper execution of one of the strategy's orders."""
    order_id: str
    category: str  # entry | exit
    side: str  # long | short (position side affected)
    price: float
    qty: float  # base quantity of this fill
    time_ms: int
    trade_id: str | None  # trade opened (entry) or closed (exit)
    leg: str  # market | limit | stop | profit | loss | trail


@dataclass(frozen=True)
class Instrument:
    """Exact venue steps of the traded market (Decimal)."""
    price_increment: object
    size_increment: object
    min_quantity: object | None = None
    min_notional: object | None = None


@dataclass(frozen=True)
class OpenTrade:
    id: str
    entry_id: str
    side: str
    qty: float
    entry_price: float
    entry_time_ms: int


class Strategy:
    """Base class. Override the callbacks you need; all are optional."""
    name: str = "Unnamed strategy"
    description: str = ""
    timeframe: str = "1h"
    #: Closed bars passed to on_bar before the start (indicator warm-up; orders are ignored).
    warmup_bars: int = 300
    #: Maximum open trades in one direction (like Pine's pyramiding).
    pyramiding: int = 1
    #: At most this many markets of one exchange hold a position at once (None: no limit
    #: besides the account cash). An entry beyond it is rejected ("position_limit").
    max_positions_per_venue: int | None = None
    params: dict = {}

    def on_start(self, ctx):
        """Called once after warm-up, before live data."""

    def on_bar(self, ctx, bar):
        """Called for every closed bar. During warm-up ctx.is_history is True."""

    def on_quote(self, ctx, quote):
        """Called on every fresh best bid/ask change (live only)."""

    def on_fill(self, ctx, fill):
        """Called after each real execution of this strategy's orders."""

    def on_order_rejected(self, ctx, order_id, reason):
        """An entry was not executed with real size. `reason` is e.g. no_liquidity,
        price_left_limit, entry_wait_expired, position_limit, shared_capital_exhausted,
        notional_below_minimum or fillable_below_minimum."""


def describe_strategy(cls):
    if not isinstance(cls, type) or not issubclass(cls, Strategy) or cls is Strategy:
        raise TypeError("not a Strategy subclass")
    if cls.timeframe not in TIMEFRAMES:
        raise ValueError(f"{cls.__name__}.timeframe must be one of {', '.join(TIMEFRAMES)}")
    if not isinstance(cls.params, dict) or any(not isinstance(value, Param) for value in cls.params.values()):
        raise TypeError(f"{cls.__name__}.params must map names to Param")
    limit = cls.max_positions_per_venue
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10):
        raise ValueError(f"{cls.__name__}.max_positions_per_venue must be 1..10 or None")
    return {"name": cls.name, "description": cls.description, "timeframe": cls.timeframe,
            "warmupBars": int(cls.warmup_bars), "pyramiding": int(cls.pyramiding),
            "maxPositionsPerVenue": cls.max_positions_per_venue,
            "params": {name: param.describe() for name, param in cls.params.items()}}


def resolve_params(cls, values):
    values = dict(values or {})
    unknown = set(values) - set(cls.params)
    if unknown:
        raise ValueError(f"unknown parameter(s): {', '.join(sorted(unknown))}")
    return {name: param.validate(name, values.get(name, param.default)) for name, param in cls.params.items()}
