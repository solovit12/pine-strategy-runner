"""Long pause and silence policy without network or accelerated runtime flags."""
import json
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from runtime import PINE_STRATEGY, make_controller as RuntimeController
from test_lifecycle import has_native

HOUR_MS = 3_600_000
# The built-in strategy is private; the public edition checks the Pine controller only.
KINDS = (PINE_STRATEGY, None) if has_native() else (PINE_STRATEGY,)


class RecoveryPolicyTests(unittest.TestCase):
    def controller(self, kind=None):
        events = []
        emitter = SimpleNamespace(on_failure=None, emit=lambda kind, **fields: events.append({'type': kind, **fields}))
        config = {'mode': 'public', 'volatilityExpiresAtMs': 10**15, **({'nativeStrategy': kind} if kind else {})}
        controller = RuntimeController(config, emitter)
        now = time.time_ns() // 1_000_000
        controller.snapshot = Mock()
        for key in controller.specs:
            controller.strategies[key] = SimpleNamespace(
                pause_for_recovery=Mock(), invalidate_inputs=Mock(), reconnect_socket=Mock(),
                observe_diagnostics=Mock(), signal=SimpleNamespace(last_closed_hour_ms=now//HOUR_MS*HOUR_MS),
                last_quote_ms=now, last_book_ms=now, last_quote_event_ms=now, last_book_event_ms=now,
                run_config={'maxQuoteAgeMs': 1000, 'maxBookAgeMs': 1000},
                input_diagnostics=lambda at_ms=None: ([], {}))
        return controller, events

    def test_ten_minute_pause_keeps_waiting_and_stop_remains_available(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                self.ten_minute_pause(kind)

    def ten_minute_pause(self, kind):
        controller, events = self.controller(kind)
        start = time.monotonic_ns()
        with patch('runtime.time.monotonic_ns', return_value=start):
            controller.begin_recovery('hyperliquid')
            controller.check_recovery()
        with patch('runtime.time.monotonic_ns', return_value=start + 600_000_000_000):
            for _ in range(50):
                controller.check_recovery()
            self.assertTrue(controller.recovering)
            self.assertFalse(controller.stopping)
            checks = [json.loads(e['message'].removeprefix('Recovery diagnostic: ')) for e in events
                      if e.get('message', '').startswith('Recovery diagnostic: ')]
            self.assertEqual(len(checks), 2)
            controller.request_stop('user stops long pause')
            self.assertTrue(controller.stop_event.is_set())
            self.assertFalse(controller.failed)
            self.assertTrue(any('duration 600000 ms' in e.get('message', '') for e in events))

    def test_silent_feed_pauses_before_requesting_existing_client_reconnect(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                self.silent_feed(kind)

    def silent_feed(self, kind):
        controller, events = self.controller(kind)
        controller.connected_endpoints.add('hyperliquid-data-streams')
        strategy = controller.strategies['hyperliquid']
        strategy.reconnect_socket.side_effect = lambda *args: self.assertTrue(controller.recovering)
        controller.recover_silent_feed('hyperliquid')
        strategy.reconnect_socket.assert_called_once()
        client, endpoint = strategy.reconnect_socket.call_args.args
        self.assertEqual(str(client), str(controller.specs['hyperliquid'].source_venue))
        self.assertEqual(endpoint, 'hyperliquid-data-streams')
        self.assertFalse(controller.recovery_gaps['hyperliquid']['connected'])
        self.assertTrue(all(s.pause_for_recovery.call_count == 1 for s in controller.strategies.values()))
        self.assertTrue(any('reconnect requested' in e.get('message', '') for e in events))

    def test_pine_and_python_recovery_does_not_read_native_hourly_signal(self):
        # Pine/Python tracks have no built-in strategy signal (signal is None);
        # a short data gap must not crash the recovery check (run 2095ef54).
        controller, _ = self.controller(PINE_STRATEGY)
        for strategy in controller.strategies.values():
            strategy.signal = None
        controller.begin_recovery('lighter')
        blockers, _ = controller.recovery_input_state()
        self.assertNotIn('hourly_candles_not_ready', blockers)


if __name__ == '__main__':
    unittest.main(verbosity=2)
