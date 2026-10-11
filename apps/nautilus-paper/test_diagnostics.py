"""Pure bounded diagnostic aggregation checks; no Nautilus or network."""

import json
import unittest
from unittest.mock import patch

import diagnostics


class Clock:
    def __init__(self):
        self.wall_ns = 1_790_000_000_000_000_000
        self.mono_ns = 10_000_000_000

    def advance(self, ms, *, wall_ms=None):
        self.mono_ns += ms * 1_000_000
        self.wall_ns += (ms if wall_ms is None else wall_ms) * 1_000_000


def decode(messages):
    result = []
    for message in messages:
        assert message.startswith(diagnostics.PREFIX)
        assert len(message) <= diagnostics.MAX_MESSAGE_CHARS
        result.append(json.loads(message[len(diagnostics.PREFIX):]))
    return result


def rows(messages, kind):
    return [row for message in decode(messages) for row in message[kind]]


class DecisionDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        wall = patch.object(diagnostics.time, "time_ns", side_effect=lambda: self.clock.wall_ns)
        mono = patch.object(diagnostics.time, "monotonic_ns", side_effect=lambda: self.clock.mono_ns)
        wall.start()
        mono.start()
        self.addCleanup(wall.stop)
        self.addCleanup(mono.stop)
        self.messages = []
        self.aggregator = diagnostics.DecisionDiagnostics(self.messages.append)

    def test_ten_thousand_skips_exact_counts_samples_and_thirty_second_rate(self):
        first_ms = self.clock.wall_ns // 1_000_000
        sample = {"bookSourceMs": 1001}
        for i in range(10_000):
            sample["bookSourceMs"] = 1001 + i
            self.aggregator.skip("quote", ["book_source_stale", "book_delivery_stale"], sample)
            self.clock.advance(1)
        sample["bookSourceMs"] = -1  # Caller-owned maps cannot change a recorded sample.
        self.assertEqual(self.aggregator.flush(), 0)
        self.clock.advance(19_999)
        self.assertEqual(self.aggregator.flush(), 0)
        self.clock.advance(1)
        self.assertEqual(self.aggregator.flush(), 1)
        observed = rows(self.messages, "skips")
        self.assertEqual(len(observed), 2)
        for row in observed:
            self.assertEqual(row["count"], 10_000)
            self.assertEqual(row["firstAtMs"], first_ms)
            self.assertEqual(row["lastAtMs"], first_ms + 9_999)
            self.assertEqual(row["ages"], {"bookSourceMs": 11_000})
        self.aggregator.skip("entry", ["entry_delay"])
        self.assertEqual(self.aggregator.flush(), 0)
        self.assertEqual(self.aggregator.flush(force=True, reason="recovery"), 1)
        self.assertEqual(self.aggregator.flush(force=True, reason="stop"), 0)
        self.assertEqual(len(self.messages), 2)

    def test_wait_closure_episode_counts_and_interval_carry_across_flush(self):
        self.aggregator.waits(["book_missing"], {"bookSourceMs": None})
        self.clock.advance(5000)
        self.aggregator.waits(["book_missing"], {"bookSourceMs": None})
        self.clock.advance(25_000)
        self.aggregator.flush()
        first = rows(self.messages, "waits")[0]
        self.assertEqual((first["episodes"], first["observations"], first["observedMs"], first["open"]),
                         (1, 2, 5000, True))
        # A flush is not an observation and must not invent the unseen 25 s.
        self.assertEqual(self.aggregator.flush(force=True), 0)
        self.clock.advance(10_000)
        self.aggregator.waits([])
        self.aggregator.flush(force=True, reason="recovery")
        second = rows(self.messages, "waits")[1]
        self.assertEqual((second["episodes"], second["observations"], second["observedMs"], second["open"]),
                         (0, 1, 35_000, False))
        self.assertEqual(first["observedMs"] + second["observedMs"], 40_000)
        self.assertEqual(second["firstAtMs"], first["lastAtMs"])
        self.clock.advance(1000)
        self.aggregator.waits(["book_missing"])
        self.clock.advance(2000)
        self.aggregator.waits([])
        self.aggregator.flush(force=True, reason="stop")
        third = rows(self.messages, "waits")[2]
        self.assertEqual((third["episodes"], third["observedMs"], third["open"]), (1, 2000, False))
        self.assertEqual(sum(row["episodes"] for row in rows(self.messages, "waits")), 2)

    def test_overlapping_waiters_are_independent_observed_intervals(self):
        self.aggregator.waits(["quote_missing", "book_missing"])
        self.clock.advance(100)
        self.aggregator.waits(["book_missing"])
        self.clock.advance(200)
        self.aggregator.waits(["quote_missing"])
        self.clock.advance(300)
        self.aggregator.waits([])
        self.aggregator.flush(force=True)
        observed = {row["reason"]: row for row in rows(self.messages, "waits")}
        self.assertEqual(observed["quote_missing"]["episodes"], 2)
        self.assertEqual(observed["quote_missing"]["observedMs"], 400)
        self.assertEqual(observed["book_missing"]["episodes"], 1)
        self.assertEqual(observed["book_missing"]["observedMs"], 300)
        self.assertTrue(all(not row["open"] for row in observed.values()))

    def test_closed_wait_preserves_latest_blocking_ages_even_across_flush(self):
        for flush_while_open in (False, True):
            with self.subTest(flush_while_open=flush_while_open):
                messages = []
                aggregator = diagnostics.DecisionDiagnostics(messages.append)
                aggregator.waits(["book_source_stale"], {"bookSourceMs": 1200})
                self.clock.advance(100)
                aggregator.waits(["book_source_stale"], {"bookSourceMs": 1300})
                if flush_while_open:
                    aggregator.flush(force=True)
                self.clock.advance(100)
                aggregator.waits([], {"bookSourceMs": 0})
                aggregator.flush(force=True, reason="stop")
                closed = rows(messages, "waits")[-1]
                self.assertFalse(closed["open"])
                self.assertEqual(closed["ages"], {"bookSourceMs": 1300})
                self.assertEqual(sum(row["observedMs"] for row in rows(messages, "waits")), 200)

    def test_recovery_callbacks_aggregate_skips_and_waits_in_one_force_flush(self):
        self.aggregator.skip("quote", ["recovery"])
        self.aggregator.skip("book", ["recovery"])
        self.aggregator.waits(["recovery"])
        self.clock.advance(123)
        self.aggregator.waits([])
        self.assertEqual(self.aggregator.flush(force=True, reason="recovery"), 1)
        self.assertEqual({row["scope"] for row in rows(self.messages, "skips")}, {"quote", "book"})
        self.assertTrue(all(row["reason"] == "recovery" and row["count"] == 1
                            for row in rows(self.messages, "skips")))
        observed = rows(self.messages, "waits")[0]
        self.assertEqual((observed["reason"], observed["observedMs"], observed["open"]),
                         ("recovery", 123, False))

    def test_wall_clock_jumps_do_not_change_monotonic_duration_or_rate(self):
        self.aggregator.waits(["recovery"])
        self.clock.advance(1000, wall_ms=-3_600_000)
        self.aggregator.waits(["recovery"])
        self.assertEqual(self.aggregator.flush(), 0)
        self.aggregator.flush(force=True)
        first = rows(self.messages, "waits")[0]
        self.assertEqual(first["observedMs"], 1000)
        self.assertLess(first["lastAtMs"], first["firstAtMs"])
        self.clock.advance(2000, wall_ms=172_800_000)
        self.aggregator.waits([])
        self.assertEqual(self.aggregator.flush(), 0)
        self.aggregator.flush(force=True)
        self.assertEqual(sum(row["observedMs"] for row in rows(self.messages, "waits")), 3000)

    def populate_fixed_keyspace(self, aggregator):
        ages = {key: diagnostics.MAX_SAFE_INTEGER for key in diagnostics.AGE_KEYS}
        for scope in diagnostics.SCOPES:
            aggregator.skip(scope, sorted(diagnostics.SKIP_REASONS), ages)
        aggregator.waits(sorted(diagnostics.WAIT_REASONS), ages)

    def test_full_fixed_vocabulary_payload_bounds_and_no_silent_trimming(self):
        self.populate_fixed_keyspace(self.aggregator)
        emitted = self.aggregator.flush(force=True, reason="stop")
        self.assertLessEqual(emitted, diagnostics.MAX_PARTS_PER_BATCH)
        packets = decode(self.messages)
        self.assertEqual([packet["part"] for packet in packets], list(range(1, emitted + 1)))
        self.assertEqual({packet["parts"] for packet in packets}, {emitted})
        self.assertEqual({packet["batch"] for packet in packets}, {1})
        skipped = rows(self.messages, "skips")
        expected = {(scope, reason) for scope in diagnostics.SCOPES for reason in diagnostics.SKIP_REASONS}
        self.assertEqual({(row["scope"], row["reason"]) for row in skipped}, expected)
        self.assertTrue(all(row["count"] == 1 and len(row["ages"]) == len(diagnostics.AGE_KEYS) for row in skipped))
        self.assertEqual({row["reason"] for row in rows(self.messages, "waits")}, diagnostics.WAIT_REASONS)
        self.assertEqual(len(skipped) + len(rows(self.messages, "waits")), diagnostics.MAX_KEYS)
        self.assertEqual(self.aggregator.flush(force=True), 0)

    def test_invalid_labels_arrays_and_samples_raise_before_recording(self):
        invalid = [
            lambda: self.aggregator.skip("unknown", ["book_missing"]),
            lambda: self.aggregator.skip("quote", ["unknown"]),
            lambda: self.aggregator.waits(["duplicate_book"]),
            lambda: self.aggregator.waits(["source_out_of_order"]),
            lambda: self.aggregator.skip("quote", ["book_missing", "book_missing"]),
            lambda: self.aggregator.skip("quote", ["book_missing"] * 1000),
            lambda: self.aggregator.skip("quote", ["book_missing"], {"otherAge": 1}),
            lambda: self.aggregator.skip("quote", ["book_missing"], {"bookSourceMs": float("nan")}),
            lambda: self.aggregator.skip("quote", ["book_missing"], {"bookSourceMs": float("inf")}),
            lambda: self.aggregator.skip("quote", ["book_missing"], {"bookSourceMs": True}),
            lambda: self.aggregator.skip("quote", ["book_missing"], {"bookSourceMs": [1, 2]}),
            lambda: self.aggregator.flush(force=True, reason="x" * 65),
        ]
        for operation in invalid:
            with self.subTest(operation=operation):
                with self.assertRaises(ValueError):
                    operation()
        self.assertEqual(self.aggregator.flush(force=True), 0)

    def test_emit_failure_retains_exact_counts_and_accepts_later_observations(self):
        attempts = []
        failed = False

        def emit(message):
            nonlocal failed
            attempts.append(message)
            if not failed:
                failed = True
                raise OSError("outbox unavailable")
            self.messages.append(message)

        aggregator = diagnostics.DecisionDiagnostics(emit)
        for _ in range(7):
            aggregator.skip("entry", ["entry_delay"])
        with self.assertRaises(OSError):
            aggregator.flush(force=True, reason="recovery")
        for _ in range(3):
            aggregator.skip("entry", ["entry_delay"])
        self.assertEqual(aggregator.flush(force=True, reason="stop"), 2)
        self.assertEqual(attempts[0], attempts[1])
        self.assertEqual(sum(row["count"] for row in rows(self.messages, "skips")), 10)
        self.assertEqual([packet["batch"] for packet in decode(self.messages)], [1, 2])
        self.assertEqual(aggregator.flush(force=True), 0)

    def test_partial_emission_retries_only_failed_and_unattempted_parts(self):
        calls = 0

        def emit(message):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("second part failed")
            self.messages.append(message)

        aggregator = diagnostics.DecisionDiagnostics(emit)
        self.populate_fixed_keyspace(aggregator)
        with self.assertRaises(OSError):
            aggregator.flush(force=True)
        self.assertEqual(len(self.messages), 1)
        aggregator.flush(force=True)
        packets = decode(self.messages)
        self.assertEqual([packet["part"] for packet in packets], list(range(1, len(packets) + 1)))
        self.assertEqual({packet["batch"] for packet in packets}, {1})
        self.assertEqual(sum(row["count"] for row in rows(self.messages, "skips")),
                         len(diagnostics.SCOPES) * len(diagnostics.SKIP_REASONS))
        self.assertEqual(aggregator.flush(force=True), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
