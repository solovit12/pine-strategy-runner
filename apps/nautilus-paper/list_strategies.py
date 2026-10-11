"""Print the Python strategies of the configured packs as JSON (no Nautilus import).

Usage: python list_strategies.py [--pack /abs/path ...]
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from psr_sdk.packs import discover  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", action="append", default=[])
    args = parser.parse_args()
    rows, errors = discover(args.pack)
    print(json.dumps({"strategies": rows, "errors": errors}, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
