"""Offline sidecar failure, EOF and crash audit checks; no network or real orders."""

import asyncio
import json
import os
from pathlib import Path
import signal
import tempfile

ROOT = Path(__file__).resolve().parents[2]
from test_env import PYTHON
RUNTIME = ROOT / "apps/nautilus-paper/runtime.py"


def has_native():
    """The built-in strategy module is private; the public edition checks Pine runs only."""
    try:
        import native_strategy  # noqa: F401
    except ImportError:
        return False
    return True


def pine_lifecycle_config(folder: Path, label: str):
    from test_pine_runtime import pine_config
    return pine_config(folder, label, [("hyperliquid", "HYPE"), ("lighter", "HYPE")])


async def scenario(kind: str, make_config):
    with tempfile.TemporaryDirectory(prefix=f"psr-nautilus-{kind}-") as tmp:
        folder = Path(tmp)
        config_path = folder / "config.json"
        config_path.write_text(json.dumps(make_config(folder, kind)), encoding="utf-8")
        with (folder / "stderr.log").open("wb") as stderr:
            proc = await asyncio.create_subprocess_exec(
                str(PYTHON), str(RUNTIME), "--config", str(config_path),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=stderr,
            )
            events = []

            async def read():
                while line := await proc.stdout.readline():
                    assert line.startswith(b"PSR_EVENT="), line
                    events.append(json.loads(line[len(b"PSR_EVENT="):]))

            reader = asyncio.create_task(read())
            try:
                await asyncio.sleep(0.8)
                if kind == "invalid":
                    proc.stdin.write(b'{"cmd":"no-such-command"}\n')
                    await proc.stdin.drain()
                elif kind == "eof":
                    proc.stdin.close()
                elif kind == "kill":
                    proc.send_signal(signal.SIGKILL)
                await asyncio.wait_for(proc.wait(), timeout=15)
                await reader
            finally:
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
                if not reader.done():
                    reader.cancel()
            outbox = [json.loads(line) for line in (folder / "nautilus-events.jsonl").read_text().splitlines()]
            assert outbox == events
            assert [item["seq"] for item in events] == list(range(1, len(events) + 1))
            assert all("venue" not in item or item["venue"] is not None for item in events)
            marker = json.loads((folder / "nautilus-child.json").read_text())
            assert marker["childPid"] == proc.pid
            assert marker["parentPid"] == os.getpid()
            if kind == "invalid":
                failures = [item for item in events if item["type"] == "failure"]
                assert len(failures) == 1 and "unsupported command" in failures[0]["message"]
                assert "venue" not in failures[0]
                assert any(item["type"] == "stopped" for item in events)
            elif kind == "eof":
                assert not any(item["type"] == "failure" for item in events)
                assert any(item["type"] == "stopped" and "stdin EOF" in item["reason"] for item in events)
            else:
                assert proc.returncode != 0
                assert not any(item["type"] == "stopped" for item in events)
            print(make_config.__name__, kind, "exit", proc.returncode, "events", len(events), "outbox byte match")


async def main():
    configs = [pine_lifecycle_config]
    if has_native():
        from native_test_config import config
        configs.append(config)
    for make_config in configs:
        for kind in ("invalid", "eof", "kill"):
            await scenario(kind, make_config)


if __name__ == "__main__":
    asyncio.run(main())
