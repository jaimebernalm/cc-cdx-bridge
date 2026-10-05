#!/bin/sh
# Desktop PATH may differ from the user's interactive shell. Keep paths quoted.
set -eu
if command -v bun >/dev/null 2>&1; then
  exec bun "$@"
fi
for bridge_bun in "${HOME:-}/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun /usr/bin/bun; do
  if [ -x "$bridge_bun" ]; then
    exec "$bridge_bun" "$@"
  fi
done
echo 'cc-cdx-bridge: Bun is missing. Install Bun, then retry. Desktop searches PATH, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin and /usr/bin.' >&2
exit 127
