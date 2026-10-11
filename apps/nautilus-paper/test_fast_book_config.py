"""Fast-book opt-in must reach only HL and must never silently use a stock wheel."""

from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from data_bridge import PublicBridge, make_specs, PAPER_MARKETS
import runtime
from test_pine_runtime import pine_config


class FastBookConfigTest(unittest.TestCase):
    def test_subscription_is_opt_in_and_hyperliquid_only(self):
        specs = make_specs([{"venue": venue, "market": market}
                            for venue in ("lighter", "hyperliquid") for market in PAPER_MARKETS])
        for setting in ({}, {"hyperliquidFastBook": False}, {"hyperliquidFastBook": True}):
            for spec in specs.values():
                with self.subTest(setting=setting, market=spec.key):
                    bridge = PublicBridge((spec, {}, SimpleNamespace(config=setting)))
                    bridge.subscribe_quotes = Mock()
                    bridge.subscribe_book_deltas = Mock()
                    bridge.subscribe_socket_state = Mock()
                    bridge.on_start()
                    expected = {"fast": True} if setting.get("hyperliquidFastBook") and spec.venue_key == "hyperliquid" else None
                    self.assertEqual(bridge.subscribe_book_deltas.call_args.kwargs["params"], expected)
                    bridge.subscribe_quotes.assert_called_once_with(spec.source_id)
                    bridge.subscribe_socket_state.assert_called_once_with()

    def test_stock_or_unmarked_build_cannot_start_fast_public_node(self):
        for version, marker in ((runtime.PINNED_NAUTILUS, False), (runtime.PINNED_NAUTILUS, True),
                                (runtime.PINNED_FAST_NAUTILUS, False), ("unqualified", True)):
            with self.subTest(version=version, marker=marker):
                with patch.object(runtime.nautilus_trader, "__version__", version), patch.object(
                        runtime.hyperliquid_adapter, "HYPERLIQUID_FAST_BOOK_SUPPORTED", marker, create=True):
                    with self.assertRaisesRegex(ValueError, "qualified native fast-book build"):
                        runtime.build_node({"mode": "public", "hyperliquidFastBook": True}, None)
        with patch.object(runtime.nautilus_trader, "__version__", runtime.PINNED_FAST_NAUTILUS), patch.object(
                runtime.hyperliquid_adapter, "HYPERLIQUID_FAST_BOOK_SUPPORTED", True, create=True):
            runtime.require_fast_book_support()

    def test_flag_does_not_accept_strings_or_numbers(self):
        folder = Path(__file__).resolve().parents[2] / ".local" / ("fast-book-config-" + uuid4().hex)
        folder.mkdir(mode=0o700, parents=True)
        for value in ("true", 1, 0, None, []):
            raw = pine_config(folder, "invalid-fast-book", [("hyperliquid", "HYPE")])
            raw["hyperliquidFastBook"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "must be a boolean"):
                runtime.validate_config(raw)
        for value in (False, True):
            raw = pine_config(folder, "valid-fast-book", [("hyperliquid", "HYPE")])
            raw["hyperliquidFastBook"] = value
            self.assertIs(runtime.validate_config(raw)["hyperliquidFastBook"], value)


if __name__ == "__main__":
    unittest.main()
