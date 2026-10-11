#!/bin/bash
# Build a frozen Paper engine release from one Git commit. The engine runs from
# this copy, so rebuilding or restarting the site never changes the code of a
# running Paper experiment.
# Usage: scripts/paper-engine-release.sh <releases-dir> [commit]   (prints the release path)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASES="${1:?releases directory required}"
COMMIT="${2:-HEAD}"
SHA=$(git -C "$ROOT" rev-parse --short=12 "$COMMIT^{commit}")
DEST="$RELEASES/$SHA"
if [ -f "$DEST/.release-ok" ]; then echo "$DEST"; exit 0; fi
rm -rf "$DEST"
mkdir -p "$DEST"
git -C "$ROOT" archive "$SHA" | tar -x -C "$DEST"
(cd "$DEST" && npm ci --no-audit --no-fund >&2 && npm run build:api >&2)
printf '%s\n' "$(git -C "$ROOT" rev-parse "$SHA")" > "$DEST/.release-ok"
echo "$DEST"
