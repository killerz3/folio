#!/usr/bin/env bash
# Wire a local user's folio CLI to the installed origin, then publish the
# architecture doc. Run with: sudo ~/folio/deploy/wire-cli.sh [user]
# The token is copied root -> user's config file and never printed or echoed.
set -euo pipefail

TARGET_USER="${1:-agent}"
ENV_FILE=/etc/folio/env
SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DOC="$SRC/docs-src/architecture.html"
# runuser gets no login shell -> resolve the CLI absolutely
FOLIO_BIN="$(command -v folio || echo /usr/local/bin/folio)"

[[ $EUID -eq 0 ]] || { echo "error: run with sudo" >&2; exit 1; }
[[ -r $ENV_FILE ]] || { echo "error: $ENV_FILE not readable" >&2; exit 1; }
id "$TARGET_USER" >/dev/null 2>&1 || { echo "error: no such user $TARGET_USER" >&2; exit 1; }

HOME_DIR="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
CONF_DIR="$HOME_DIR/.config/folio"
CONF="$CONF_DIR/config.json"
PORT="$(sed -n 's/^FOLIO_PORT=//p' "$ENV_FILE")"; PORT="${PORT:-8082}"

echo "==> wiring CLI for $TARGET_USER -> http://127.0.0.1:$PORT"
install -d -m 0700 -o "$TARGET_USER" -g "$TARGET_USER" "$CONF_DIR"
( umask 077
  tok="$(sed -n 's/^FOLIO_TOKEN=//p' "$ENV_FILE")"
  [[ -n "$tok" ]] || { echo "error: no FOLIO_TOKEN in $ENV_FILE" >&2; exit 1; }
  printf '{"url":"http://127.0.0.1:%s","token":"%s"}\n' "$PORT" "$tok" > "$CONF" )
chown "$TARGET_USER":"$TARGET_USER" "$CONF"; chmod 600 "$CONF"
echo "    wrote $CONF (0600, token not echoed)"

echo "==> verifying CLI auth"
runuser -u "$TARGET_USER" -- "$FOLIO_BIN" list >/dev/null && echo "    auth OK"

if [[ -r $DOC ]]; then
  echo "==> publishing the architecture doc"
  runuser -u "$TARGET_USER" -- "$FOLIO_BIN" publish "$DOC" \
    --id architecture --title "folio architecture" --private
else
  echo "    (no $DOC to publish — skipping)"
fi

echo
echo "==> current documents"
runuser -u "$TARGET_USER" -- "$FOLIO_BIN" list
