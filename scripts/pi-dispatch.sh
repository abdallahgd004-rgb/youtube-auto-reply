#!/usr/bin/env bash
# pi-dispatch.sh — dispatch a brief to pi via the delegate relay, with retries.
#
# LM Studio's provider list intermittently reports "Unknown provider: lmstudio"
# even while the server is up and the model is loaded. Retrying works around it.
#
# Usage: scripts/pi-dispatch.sh <brief-file> [extra relay args...]
#   e.g. scripts/pi-dispatch.sh brief.txt --read-only
#        scripts/pi-dispatch.sh brief.txt --session 01a10b...

set -uo pipefail

RELAY="${PI_RELAY:-$HOME/.agents/skills/pi-delegate/scripts/relay.mjs}"
REPO="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
MODEL="${PI_MODEL:-qwen3.6-35b-a3b}"
PROVIDER="lmstudio"
MAX_ATTEMPTS="${PI_MAX_ATTEMPTS:-4}"

if [ $# -lt 1 ]; then
  echo "usage: $(basename "$0") <brief-file> [relay args...]" >&2
  exit 64
fi

BRIEF="$1"
shift

if [ ! -f "$BRIEF" ]; then
  echo "error: brief not found: $BRIEF" >&2
  exit 66
fi

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "=== pi dispatch attempt $attempt/$MAX_ATTEMPTS ===" >&2

  out="$(node "$RELAY" \
    --brief "$BRIEF" \
    --cd "$REPO" \
    --model "$MODEL" \
    --provider "$PROVIDER" \
    --timeout 45m \
    "$@" 2>&1)"
  status=$?

  echo "$out"

  # A provider/model resolution failure is transient; retry it.
  if printf '%s' "$out" | grep -qE 'Unknown provider|not found\. Use --list-models'; then
    echo "--- transient provider resolution failure; retrying ---" >&2
    sleep 5
    continue
  fi

  # Any other outcome (success or a real task failure) is final.
  exit $status
done

echo "error: exhausted $MAX_ATTEMPTS attempts; LM Studio provider never resolved" >&2
exit 1