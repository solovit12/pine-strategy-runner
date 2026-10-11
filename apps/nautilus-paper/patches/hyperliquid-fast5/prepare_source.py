#!/usr/bin/env python3
"""Fetch and prepare only the hash-pinned source for an isolated candidate build."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", required=True, type=Path)
    args = parser.parse_args()
    recipe = Path(__file__).resolve().parent
    manifest = json.loads((recipe / "manifest.json").read_text())
    work = args.work_dir.resolve()
    source = work / "source"
    if source.exists() or source.is_symlink():
        raise SystemExit(f"Refusing to overwrite existing source: {source}")
    patch = recipe / manifest["patch"]
    if sha256(patch) != manifest["patchSha256"]:
        raise SystemExit("Patch SHA-256 mismatch")
    work.mkdir(parents=True, exist_ok=True)
    archive = work / "upstream.tar.gz"
    if not archive.exists():
        with urllib.request.urlopen(manifest["archiveUrl"], timeout=60) as response:
            archive.write_bytes(response.read())
    if sha256(archive) != manifest["archiveSha256"]:
        raise SystemExit("Upstream archive SHA-256 mismatch")
    extraction = work / "upstream-extract"
    if extraction.exists():
        raise SystemExit(f"Refusing to overwrite existing extraction: {extraction}")
    extraction.mkdir()
    with tarfile.open(archive) as bundle:
        roots = {member.name.split("/", 1)[0] for member in bundle.getmembers()}
        if len(roots) != 1:
            raise SystemExit("Expected one upstream archive root")
        bundle.extractall(extraction, filter="data")
    (extraction / roots.pop()).rename(source)
    for item in manifest["files"]:
        if sha256(source / item["path"]) != item["upstreamSha256"]:
            raise SystemExit(f"Unexpected upstream file: {item['path']}")
    subprocess.run(
        ["/usr/bin/patch", "--batch", "-p1", "-i", str(patch)],
        cwd=source,
        check=True,
    )
    for item in manifest["files"]:
        if sha256(source / item["path"]) != item["patchedSha256"]:
            raise SystemExit(f"Unexpected patched file: {item['path']}")
    print(f"Verified patched source: {source}")


if __name__ == "__main__":
    main()
