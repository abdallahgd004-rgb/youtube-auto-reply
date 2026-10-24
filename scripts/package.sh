#!/usr/bin/env bash
#
# Build the installable ZIP (Phase 18.5).
#
# The archive contains the `src/` folder itself, so unpacking it and pointing Chrome's
# "Load unpacked" at `src/` is all that is needed. Development files — the test
# harnesses, macOS metadata, editor droppings — are left out, because a shipping build
# should not carry the scaffolding used to test it.
#
# Run:  bash scripts/package.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src"
DIST="$ROOT/dist"

# Read the version straight from the manifest so the archive can never disagree with
# what Chrome will report.
VERSION="$(node -e "process.stdout.write(require('$SRC/manifest.json').version)")"
NAME="$(node -e "process.stdout.write(require('$SRC/manifest.json').name)")"
SLUG="$(printf '%s' "$NAME" | tr '[:upper:] ' '[:lower:]-')"
ZIP="$DIST/$SLUG-$VERSION.zip"

if [ ! -f "$SRC/manifest.json" ]; then
  echo "error: $SRC/manifest.json not found — run this from the repository root" >&2
  exit 1
fi

# Refuse to package something that would not load.
node "$ROOT/scripts/verify-extension.mjs" >/dev/null || {
  echo "error: packaging checks failed; fix them before building" >&2
  exit 1
}

rm -rf "$DIST"
mkdir -p "$DIST"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# -name '*/tests' prunes the browser test harnesses. Everything else under src/ ships,
# because every file there is either loaded by the manifest or is loaded by one of them.
rsync -a --exclude '.DS_Store' --exclude '*/tests' --exclude '__*' "$SRC/" "$STAGE/src/"

if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -qr "$ZIP" src)
else
  # Fallback: Python's zipfile is always present with the Python used for tooling.
  STAGE="$STAGE" ZIP="$ZIP" python3 - <<'PY'
import os, zipfile
stage, zip_path = os.environ['STAGE'], os.environ['ZIP']
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(os.path.join(stage, 'src')):
        for name in files:
            full = os.path.join(root, name)
            z.write(full, os.path.relpath(full, stage))
PY
fi

FILES="$(unzip -l "$ZIP" | tail -1 | awk '{print $2}')"
echo "built $ZIP"
echo "  version : $VERSION"
echo "  entries : $FILES"
echo
echo "Install: chrome://extensions/ → Developer mode → Load unpacked → pick the"
echo "extracted 'src' folder (not the folder the zip was extracted into)."