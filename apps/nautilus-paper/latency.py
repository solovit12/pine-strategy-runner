"""Bounded per-signal timing in the existing durable Paper event journal.

Source/init stamps are wall clocks, NOT proven socket receipt. Local elapsed
times use a monotonic clock. Only signal/order milestones are persisted.
"""

from dataclasses import dataclass
import json
import time


PREFIX = "Paper latency: "
MAX_MESSAGE_CHARS = 2048


@dataclass(frozen=True)
class Stamp:
    wall_ns: int
    mono_ns: int

    @classmethod
    def now(cls):
        return cls(time.time_ns(), time.monotonic_ns())


def elapsed_ms(start, end):
    return round((end.mono_ns - start.mono_ns) / 1_000_000, 6)


@dataclass(frozen=True)
class InputTiming:
    source_ns: int
    init_ns: int
    callback: Stamp

    @classmethod
    def capture(cls, event):
        return cls(event.ts_event, event.ts_init, Stamp.now())

    def fields(self):
        # Strings preserve nanoseconds through JSON/JavaScript. Signed wall
        # differences expose clock skew rather than turning it into zero lag.
        return {
            "sourceAtNs": str(self.source_ns), "adapterInitAtNs": str(self.init_ns),
            "callbackAtNs": str(self.callback.wall_ns),
            "sourceToCallbackMs": round((self.callback.wall_ns - self.source_ns) / 1_000_000, 6),
            "initToCallbackMs": round((self.callback.wall_ns - self.init_ns) / 1_000_000, 6),
        }


class SignalLatency:
    """At most one active order per trace; partial exits reuse the signal ID."""

    def __init__(self, emit, signal_id, kind, quote, modeled_delay_ms):
        self.emit = emit
        self.signal_id = signal_id
        self.kind = kind
        self.signal = Stamp.now()
        self.submitted = None
        self.order_id = None
        self.first_fill = True
        self.record("signal", self.signal, modeledDelayMs=modeled_delay_ms,
                    quote=quote.fields(), callbackToSignalMs=elapsed_ms(quote.callback, self.signal))

    def record(self, stage, stamp=None, **fields):
        stamp = stamp or Stamp.now()
        body = {"v": 1, "signalId": self.signal_id, "kind": self.kind, "stage": stage,
                "atNs": str(stamp.wall_ns), "signalElapsedMs": elapsed_ms(self.signal, stamp)}
        if self.order_id is not None:
            body.update(orderId=self.order_id, submitElapsedMs=elapsed_ms(self.submitted, stamp))
        body.update(fields)
        message = PREFIX + json.dumps(body, separators=(",", ":"), sort_keys=True)
        if len(message) > MAX_MESSAGE_CHARS:
            raise ValueError("Paper latency event exceeds journal message limit")
        self.emit(message)

    def submit(self, order_id, book):
        self.order_id = str(order_id)
        self.submitted = Stamp.now()
        self.first_fill = True
        self.record("submit", self.submitted, book=book.fields(),
                    bookCallbackToSubmitMs=elapsed_ms(book.callback, self.submitted))

    def order_event(self, stage, event, stamp, **fields):
        if str(event.client_order_id) != self.order_id:
            raise ValueError("Paper latency order identity mismatch")
        if stage == "fill":
            fields["firstFill"] = self.first_fill
            self.first_fill = False
        # These timestamps belong to Sandbox, not a real venue order.
        self.record(stage, stamp, sandboxEventAtNs=str(event.ts_event),
                    sandboxInitAtNs=str(event.ts_init), **fields)
