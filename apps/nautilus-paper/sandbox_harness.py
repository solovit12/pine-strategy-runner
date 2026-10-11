"""Shared harness for network-free Nautilus Sandbox runtime tests.

Starts runtime.py as a child process with a given config, feeds it stdin
commands and reads its PSR_EVENT lines and persisted outbox.
"""

import asyncio
import json
import os
from pathlib import Path
import time

from test_env import PYTHON

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "apps/nautilus-paper/runtime.py"
VENUES = ("lighter", "hyperliquid")
DISPLAY = {"lighter": "Lighter", "hyperliquid": "Hyperliquid"}


def stable_positions(rows):
    """Holdings without the display-only live mark and its UPNL."""
    return [{k: v for k, v in row.items() if k not in ("markPrice", "unrealizedPnl")} for row in rows]


class SandboxRun:
    def __init__(self, folder, config):
        self.folder = folder
        self.config = config
        self.events = []
        self.proc = None
        self.reader = None
        self.stderr = None

    async def launch(self):
        path = self.folder / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        self.stderr = (self.folder / "stderr.log").open("wb")
        self.proc = await asyncio.create_subprocess_exec(
            str(PYTHON), str(RUNTIME), "--config", str(path),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=self.stderr,
        )
        self.reader = asyncio.create_task(self.read_events())
        await self.wait(lambda: any(e["type"] == "phase" for e in self.events),
                        "initial sidecar phase")
        # The initial phase precedes asynchronous Nautilus client startup.
        await asyncio.sleep(0.7)

    async def read_events(self):
        while line := await self.proc.stdout.readline():
            assert line.startswith(b"PSR_EVENT="), line
            self.events.append(json.loads(line[len(b"PSR_EVENT="):]))

    async def send(self, *items):
        assert self.proc.returncode is None, self.proc.returncode
        self.proc.stdin.write(b"".join((json.dumps(item) + "\n").encode() for item in items))
        await self.proc.stdin.drain()

    async def wait(self, predicate, label, timeout=5):
        deadline = time.monotonic() + timeout
        while not predicate():
            if self.reader.done():
                await self.reader
            if self.proc.returncode is not None:
                raise AssertionError(f"sidecar exited before {label}: {self.proc.returncode}")
            if time.monotonic() >= deadline:
                raise AssertionError(f"timed out waiting for {label}")
            await asyncio.sleep(0.01)

    async def socket(self, venue, state):
        await self.send({"cmd": "socket", "venue": venue, "state": state})

    def latest_stage(self):
        states = [e["stage"] for e in self.events if e["type"] in ("snapshot", "phase")]
        return states[-1] if states else None

    async def wait_stage(self, stage):
        await self.wait(lambda: self.latest_stage() == stage, f"stage {stage}")

    async def snapshot(self):
        after = len(self.events)
        await self.send({"cmd": "snapshot"})
        await self.wait(lambda: any(e["type"] == "snapshot" for e in self.events[after:]),
                        "requested audit snapshot")
        return next(e for e in self.events[after:] if e["type"] == "snapshot")

    def fills(self, kind=None):
        return [e for e in self.events if e["type"] == "fill"
                and (kind is None or e["kind"] == kind)]

    async def wait_messages(self, message, count=2):
        await self.wait(lambda: sum(message in e.get("message", "") for e in self.events) == count,
                        f"{count} {message} events")

    def failures(self):
        return [e for e in self.events if e["type"] == "failure"]

    async def stop(self, reason="recovery test complete"):
        await self.send({"cmd": "stop", "reason": reason})
        await self.finish()
        assert not self.failures(), self.failures()
        assert [e["reason"] for e in self.events if e["type"] == "stopped"] == [reason]

    async def finish(self):
        await asyncio.wait_for(self.proc.wait(), timeout=15)
        await self.reader
        assert self.proc.returncode == 0, self.proc.returncode
        self.audit()

    def audit(self):
        outbox = [json.loads(line) for line in
                  (self.folder / "nautilus-events.jsonl").read_text().splitlines()]
        assert outbox == self.events
        assert [e["seq"] for e in self.events] == list(range(1, len(self.events) + 1))
        assert all(e["runId"] == self.config["runId"] for e in self.events)
        assert all("venue" not in e or e["venue"] in DISPLAY.values() for e in self.events)
        marker = json.loads((self.folder / "nautilus-child.json").read_text())
        assert marker == {"experimentId": self.config["runId"],
                          "childPid": self.proc.pid, "parentPid": os.getpid()}
        fill_ids = [e["id"] for e in self.fills()]
        assert len(fill_ids) == len(set(fill_ids)), fill_ids
        assert sum(e["type"] == "stopped" for e in self.events) == 1

    async def close(self):
        if self.proc is not None and self.proc.returncode is None:
            self.proc.kill()
            await self.proc.wait()
        if self.reader is not None:
            await self.reader
        if self.stderr is not None:
            self.stderr.close()
