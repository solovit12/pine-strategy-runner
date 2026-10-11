"""Bounded, single-owner observation metrics for the Paper decision path.

Counts and durations are deltas, not lifetime totals. Waiting duration advances
only between calls to waits(), using the monotonic clock; a flush is not a new
market observation. An open interval can therefore contribute duration to the
next batch after its opening episode was reported in an earlier batch.

Every fixed scope/reason combination is supported. A normal flush produces a
small number of messages; the exhaustive vocabulary is bounded to 64 parts per
batch (128 per force-flush if it also completes a previously failed batch).
One latest age sample is retained per row. Wait samples describe the latest
blocking observation, including when the interval closes after a flush.
No rows or samples are truncated.

An emission failure retains the failed/unattempted parts. Completed parts are
not repeated. If the callback writes and then raises, retry can repeat that
part with the same batch/part identity, allowing readers to deduplicate it.
The owner must stop on emission failure or explicitly retry; failures propagate.
"""

import json
import math
import time


PREFIX = "Paper diagnostic: "
FLUSH_INTERVAL_NS = 30_000_000_000
MAX_MESSAGE_CHARS = 2048
MAX_PARTS_PER_BATCH = 64
MAX_MESSAGES_PER_FLUSH = 2 * MAX_PARTS_PER_BATCH
MAX_SAFE_INTEGER = 9_007_199_254_740_991

SCOPES = frozenset({"bridge_quote", "bridge_book", "quote", "book", "entry", "exit"})
SKIP_REASONS = frozenset({
    "source_before_reconnect", "initialized_before_reconnect", "source_out_of_order",
    "source_before_position", "socket_disconnected", "snapshot_required",
    "quote_missing", "book_missing", "book_sync_required", "quote_delivery_stale", "book_delivery_stale",
    "quote_source_stale", "book_source_stale", "quote_delivery_future", "book_delivery_future",
    "quote_source_future", "book_source_future", "hourly_not_ready", "volatility_expired",
    "entry_delay", "book_not_advanced", "level_unavailable", "quantity_below_step",
    "notional_below_minimum", "insufficient_entry_depth", "exit_delay",
    "insufficient_exit_depth", "duplicate_book", "recovery", "shared_capital_exhausted", "instrument_order_limit",
    # Venue-stream liveness and arrival-time entry outcomes (2026-10-06).
    "venue_missing", "venue_delivery_stale", "venue_source_stale", "venue_delivery_future",
    "venue_source_future", "track_quiet", "superseded_by_book", "entry_wait_expired",
    "price_left_limit", "no_liquidity_at_limit",
})
WAIT_REASONS = (SKIP_REASONS - {
    "source_before_reconnect", "initialized_before_reconnect", "source_out_of_order",
    "source_before_position", "duplicate_book", "superseded_by_book",
}) | {"recovery"}
AGE_KEYS = frozenset({
    "quoteSourceMs", "bookSourceMs", "quoteDeliveryMs", "bookDeliveryMs",
    "eventSourceMs", "eventInitMs", "venueDeliveryMs", "venueSourceMs",
})
MAX_KEYS = len(SCOPES) * len(SKIP_REASONS) + len(WAIT_REASONS)


def _reasons(values, allowed):
    if not isinstance(values, list) or len(values) > len(allowed):
        raise ValueError("diagnostic reasons must be a bounded list")
    if any(not isinstance(value, str) or value not in allowed for value in values):
        raise ValueError("unknown diagnostic reason")
    if len(set(values)) != len(values):
        raise ValueError("duplicate diagnostic reason in one observation")
    return set(values)


def _ages(values):
    if values is None:
        return None
    if not isinstance(values, dict) or not set(values) <= AGE_KEYS:
        raise ValueError("unknown diagnostic age field")
    for value in values.values():
        if value is not None and (type(value) not in (int, float)
                                  or abs(value) > MAX_SAFE_INTEGER
                                  or not math.isfinite(value)):
            raise ValueError("diagnostic age must be a bounded finite number or None")
    return dict(sorted(values.items()))


def _wall_ms():
    value = time.time_ns() // 1_000_000
    if abs(value) > MAX_SAFE_INTEGER:
        raise ValueError("diagnostic wall clock outside safe integer range")
    return value


class DecisionDiagnostics:
    def __init__(self, emit):
        if not callable(emit):
            raise TypeError("diagnostic emit must be callable")
        self._emit = emit
        self._skips = {}
        self._wait_rows = {}
        self._open = set()
        self._open_ages = {}
        self._last_wait_ns = None
        self._last_wait_wall_ms = None
        self._last_flush_ns = time.monotonic_ns()
        self._next_batch = 1
        self._inflight = None
        self._emitting = False

    def _writable(self):
        if self._emitting:
            raise RuntimeError("diagnostic callback must not reenter the aggregator")

    def skip(self, scope: str, reasons: list[str], ages: dict | None = None):
        self._writable()
        if not isinstance(scope, str) or scope not in SCOPES:
            raise ValueError("unknown diagnostic scope")
        reasons = _reasons(reasons, SKIP_REASONS)
        sample = _ages(ages)
        at_ms = _wall_ms()
        if any(self._skips.get((scope, reason), {}).get("count", 0) >= MAX_SAFE_INTEGER
               for reason in reasons):
            raise OverflowError("diagnostic skip count exhausted")
        for reason in sorted(reasons):
            row = self._skips.setdefault((scope, reason), {
                "scope": scope, "reason": reason, "count": 0,
                "firstAtMs": at_ms, "lastAtMs": at_ms,
            })
            row["count"] += 1
            row["lastAtMs"] = at_ms
            if sample is not None:
                row["ages"] = sample

    def waits(self, reasons: list[str], ages: dict | None = None):
        self._writable()
        current = _reasons(reasons, WAIT_REASONS)
        sample = _ages(ages)
        at_ns, at_ms = time.monotonic_ns(), _wall_ms()
        delta_ns = 0 if self._last_wait_ns is None else at_ns - self._last_wait_ns
        if delta_ns < 0:
            raise ValueError("diagnostic monotonic clock moved backward")
        touched = self._open | current
        for reason in touched:
            row = self._wait_rows.get(reason, {})
            duration = row.get("_observedNs", 0) + (delta_ns if reason in self._open else 0)
            if (duration > MAX_SAFE_INTEGER or row.get("observations", 0) >= MAX_SAFE_INTEGER
                    or row.get("episodes", 0) >= MAX_SAFE_INTEGER):
                raise OverflowError("diagnostic waiting counter exhausted")
        for reason in sorted(touched):
            was_open = reason in self._open
            row = self._wait_rows.setdefault(reason, {
                "reason": reason, "observations": 0, "episodes": 0, "_observedNs": 0,
                "firstAtMs": self._last_wait_wall_ms if was_open else at_ms,
                "lastAtMs": at_ms, "open": False,
            })
            row["observations"] += 1
            row["episodes"] += int(reason in current and not was_open)
            if was_open:
                row["_observedNs"] += delta_ns
            row["lastAtMs"] = at_ms
            row["open"] = reason in current
            if sample is not None and reason in current:
                row["ages"] = sample
            elif "ages" not in row and was_open and reason in self._open_ages:
                row["ages"] = self._open_ages[reason]
        self._open_ages = {reason: self._wait_rows[reason]["ages"] for reason in current
                           if "ages" in self._wait_rows[reason]}
        self._open = current
        self._last_wait_ns, self._last_wait_wall_ms = at_ns, at_ms

    def _prepare(self, reason):
        records = [("skips", dict(row)) for _, row in sorted(self._skips.items())]
        for _, row in sorted(self._wait_rows.items()):
            public = {key: value for key, value in row.items() if key != "_observedNs"}
            public["observedMs"] = row["_observedNs"] / 1_000_000
            records.append(("waits", public))
        if not records:
            return False
        if len(records) > MAX_KEYS:
            raise RuntimeError("diagnostic fixed keyspace exceeded")
        if self._next_batch > MAX_SAFE_INTEGER:
            raise OverflowError("diagnostic batch identity exhausted")
        base = {"v": 1, "batch": self._next_batch, "atMs": _wall_ms(), "reason": reason}

        def encode(groups, part=MAX_PARTS_PER_BATCH, parts=MAX_PARTS_PER_BATCH):
            return PREFIX + json.dumps({**base, "part": part, "parts": parts, **groups},
                                       separators=(",", ":"), sort_keys=True, allow_nan=False)

        chunks, groups = [], {"skips": [], "waits": []}
        for kind, row in records:
            candidate = {name: list(rows) for name, rows in groups.items()}
            candidate[kind].append(row)
            if len(encode(candidate)) > MAX_MESSAGE_CHARS:
                if not groups["skips"] and not groups["waits"]:
                    raise ValueError("diagnostic row exceeds message bound")
                chunks.append(groups)
                groups = {"skips": [], "waits": []}
                groups[kind].append(row)
                if len(encode(groups)) > MAX_MESSAGE_CHARS:
                    raise ValueError("diagnostic row exceeds message bound")
            else:
                groups = candidate
        chunks.append(groups)
        if len(chunks) > MAX_PARTS_PER_BATCH:
            raise ValueError("diagnostic batch exceeds bounded part count")
        messages = [encode(group, i + 1, len(chunks)) for i, group in enumerate(chunks)]
        # The immutable queued strings now own every count, including on failure.
        self._inflight = {"messages": messages, "next": 0}
        self._next_batch += 1
        self._skips.clear()
        self._wait_rows.clear()
        return True

    def _drain(self):
        emitted = 0
        self._emitting = True
        try:
            while self._inflight["next"] < len(self._inflight["messages"]):
                self._emit(self._inflight["messages"][self._inflight["next"]])
                self._inflight["next"] += 1
                emitted += 1
        finally:
            self._emitting = False
        self._inflight = None
        self._last_flush_ns = time.monotonic_ns()
        return emitted

    def flush(self, force=False, reason="periodic"):
        self._writable()
        if type(force) is not bool:
            raise ValueError("diagnostic force must be boolean")
        if (not isinstance(reason, str) or not 1 <= len(reason) <= 64
                or any(ord(char) < 32 or ord(char) > 126 for char in reason)):
            raise ValueError("diagnostic flush reason must be 1..64 printable ASCII characters")
        emitted = 0
        if self._inflight is not None:
            emitted += self._drain()
            if not force:
                return emitted
        if not force and time.monotonic_ns() - self._last_flush_ns < FLUSH_INTERVAL_NS:
            return emitted
        if self._prepare(reason):
            emitted += self._drain()
        return emitted
