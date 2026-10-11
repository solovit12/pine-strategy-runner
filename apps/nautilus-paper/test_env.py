"""Interpreter for the offline Nautilus tests.

Defaults to the qualified fast5 environment used by the API; set
PSR_NAUTILUS_PYTHON to test another pinned Nautilus build.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYTHON = Path(os.environ.get("PSR_NAUTILUS_PYTHON")
              or ROOT / ".local/nautilus-hl-fast5-20261001/.venv/bin/python")
