#!/usr/bin/env bash
#
# folio installer — idempotent. Run as root:
#
#     sudo ./install.sh
#
# Safe to re-run: it never deletes documents in /srv/folio/docs and never
# rotates an existing FOLIO_TOKEN.
#
set -euo pipefail

APP_USER=folio
APP_GROUP=folio
APP_DIR=/srv/folio
DATA_DIR=/srv/folio/docs
ETC_DIR=/etc/folio
ENV_FILE=/etc/folio/env
UNIT_NAME=folio.service
UNIT_DST=/etc/systemd/system/folio.service
NODE_BIN=/usr/bin/node
CLI_LINK=/usr/local/bin/folio

SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

say()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight --
[ "$(id -u)" -eq 0 ] || die "must run as root — try: sudo $0"

for cmd in systemctl openssl curl install getent; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done
[ -x "$NODE_BIN" ] || die "$NODE_BIN not found (Node 22+ required)"

node_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || die "Node 22+ required, found $("$NODE_BIN" -v)"

[ -d "$SRC_DIR/src" ] || die "$SRC_DIR/src does not exist — run this from the folio checkout"
[ -f "$SRC_DIR/systemd/$UNIT_NAME" ] || die "missing $SRC_DIR/systemd/$UNIT_NAME"

say "installing folio from $SRC_DIR (node $("$NODE_BIN" -v))"

# ------------------------------------------------------------ user & group --
if getent group "$APP_GROUP" >/dev/null; then
  say "group $APP_GROUP already exists"
else
  say "creating system group $APP_GROUP"
  groupadd --system "$APP_GROUP"
fi

if getent passwd "$APP_USER" >/dev/null; then
  say "user $APP_USER already exists"
else
  say "creating system user $APP_USER (no home, no login shell)"
  useradd --system \
          --gid "$APP_GROUP" \
          --home-dir /nonexistent \
          --no-create-home \
          --shell /usr/sbin/nologin \
          --comment "folio artifact host" \
          "$APP_USER"
fi

# ------------------------------------------------------------ app payload ---
# Code is owned by root and only readable by the service user.
say "installing application to $APP_DIR"
install -d -o root -g "$APP_GROUP" -m 0755 "$APP_DIR"

# Replace code directories wholesale (stale files must not survive an upgrade).
# $DATA_DIR is untouched by this.
for d in src bin; do
  if [ -d "$SRC_DIR/$d" ]; then
    rm -rf "${APP_DIR:?}/$d"
    install -d -o root -g "$APP_GROUP" -m 0755 "$APP_DIR/$d"
    cp -a "$SRC_DIR/$d/." "$APP_DIR/$d/"
  fi
done

for f in package.json package-lock.json README.md SPEC.md; do
  if [ -f "$SRC_DIR/$f" ]; then
    install -o root -g "$APP_GROUP" -m 0644 "$SRC_DIR/$f" "$APP_DIR/$f"
  fi
done

chown -R root:"$APP_GROUP" "$APP_DIR/src" "$APP_DIR/bin" 2>/dev/null || true
find "$APP_DIR/src" "$APP_DIR/bin" -type d -exec chmod 0755 {} + 2>/dev/null || true
find "$APP_DIR/src" -type f -exec chmod 0644 {} + 2>/dev/null || true
find "$APP_DIR/bin" -type f -exec chmod 0755 {} + 2>/dev/null || true

# CLI on PATH for the admin (it talks to the origin over loopback).
if [ -f "$APP_DIR/bin/folio" ]; then
  ln -sfn "$APP_DIR/bin/folio" "$CLI_LINK"
  say "linked CLI: $CLI_LINK -> $APP_DIR/bin/folio"
fi

# ------------------------------------------------------------- data dir -----
# Created only if absent; contents are never removed or re-moded.
if [ -d "$DATA_DIR" ]; then
  say "data dir $DATA_DIR already exists — leaving documents alone"
else
  say "creating data dir $DATA_DIR"
fi
install -d -o "$APP_USER" -g "$APP_GROUP" -m 0750 "$DATA_DIR"
chown -R "$APP_USER":"$APP_GROUP" "$DATA_DIR"

# ------------------------------------------------------------- env file -----
install -d -o root -g "$APP_GROUP" -m 0750 "$ETC_DIR"

if [ -f "$ENV_FILE" ] && grep -qE '^[[:space:]]*FOLIO_TOKEN=..' "$ENV_FILE"; then
  say "$ENV_FILE already has a FOLIO_TOKEN — keeping it (not rotating)"
else
  say "generating FOLIO_TOKEN into $ENV_FILE"
  token="$(openssl rand -base64 32 | tr -d '\n')"
  umask 077
  if [ -f "$ENV_FILE" ]; then
    # File exists but has no usable token: append one, keep everything else.
    printf '\nFOLIO_TOKEN=%s\n' "$token" >> "$ENV_FILE"
  else
    cat > "$ENV_FILE" <<ENVEOF
# folio service environment — read by systemd (EnvironmentFile).
# Mode 0600, root:folio. Values are literal; do not add shell quoting.
FOLIO_ADDR=127.0.0.1
FOLIO_PORT=8082
FOLIO_DATA=$DATA_DIR
FOLIO_MAX_BYTES=10485760

# Optional Cloudflare Access JWT verification at the origin (defence in depth).
# See deploy/ACCESS.md for where to find the AUD tag.
#FOLIO_ACCESS_TEAM=kz3
#FOLIO_ACCESS_AUD=

# Bearer secret for /api/*. Generated once by install.sh; see README
# ("Rolling the API token") before changing it.
FOLIO_TOKEN=$token
ENVEOF
  fi
  unset token
fi
chown root:"$APP_GROUP" "$ENV_FILE"
chmod 0600 "$ENV_FILE"

# -------------------------------------------------------------- unit file ---
say "installing $UNIT_DST"
install -o root -g root -m 0644 "$SRC_DIR/systemd/$UNIT_NAME" "$UNIT_DST"

# Resolve the entrypoint: package.json "main", else the conventional paths.
entry=""
if [ -f "$APP_DIR/package.json" ]; then
  entry="$("$NODE_BIN" -e 'const fs=require("fs");try{const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof p.main==="string")process.stdout.write(p.main)}catch(e){}' "$APP_DIR/package.json" || true)"
fi
for cand in "$entry" src/server.js src/index.js src/main.js server.js; do
  [ -n "$cand" ] || continue
  if [ -f "$APP_DIR/${cand#./}" ]; then entry="${cand#./}"; break; fi
  entry=""
done
[ -n "$entry" ] || die "could not find a server entrypoint under $APP_DIR/src"

if [ "$entry" != "src/server.js" ]; then
  say "entrypoint is $entry — rewriting ExecStart"
  sed -i "s#^ExecStart=.*#ExecStart=$NODE_BIN $APP_DIR/$entry#" "$UNIT_DST"
fi

was_active=no
if systemctl is-active --quiet "$UNIT_NAME"; then was_active=yes; fi

say "systemctl daemon-reload"
systemctl daemon-reload

say "enabling and starting $UNIT_NAME"
systemctl enable --now "$UNIT_NAME"
if [ "$was_active" = yes ]; then
  say "service was already running — restarting to pick up new code"
  systemctl restart "$UNIT_NAME"
fi

# ------------------------------------------------------------ verification --
port="$(sed -n 's/^[[:space:]]*FOLIO_PORT=\([0-9]\+\).*/\1/p' "$ENV_FILE" | tail -n1)"
port="${port:-8082}"
health="http://127.0.0.1:${port}/healthz"

say "verifying $health"
if curl -fsS --max-time 30 --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null "$health"; then
  say "healthz OK"
else
  printf '\nerror: folio did not answer %s\n\n' "$health" >&2
  systemctl status --no-pager --full "$UNIT_NAME" >&2 || true
  printf '\n--- last 40 journal lines ---\n' >&2
  journalctl -u "$UNIT_NAME" -n 40 --no-pager >&2 || true
  die "install failed: origin is not healthy"
fi

# ----------------------------------------------------------- next steps -----
cat <<'NEXT'

folio is installed and running on 127.0.0.1 (see FOLIO_PORT in /etc/folio/env).

Next manual steps
-----------------
1. Tunnel ingress — as root, add the folio hostname to /etc/cloudflared/config.yml
   ABOVE the final `- service: http_status:404` entry. The exact snippet is in
   deploy/cloudflared-ingress.yml. Then:

       sudo cloudflared tunnel ingress validate
       sudo systemctl restart cloudflared

2. DNS + Cloudflare Access — follow deploy/ACCESS.md click-by-click:
     * one proxied CNAME  folio -> e56d9ee8-37a7-4a22-bbbe-03668982baf7.cfargotunnel.com
     * four Access applications (/api/* service auth, /p/* bypass,
       /t/* allow-listed emails, /* owner only)

3. Point the CLI at the origin. On this host, as your own user:

       install -d -m 0700 ~/.config/folio
       umask 077
       printf '{"url":"http://127.0.0.1:%s","token":"%s"}\n' \
         "$(sed -n 's/^FOLIO_PORT=//p' /etc/folio/env)" \
         "$(sudo sed -n 's/^FOLIO_TOKEN=//p' /etc/folio/env)" \
         > ~/.config/folio/config.json

   Then:  folio publish ./report.html --title "Q3 report" --private

Useful commands
---------------
   systemctl status folio
   journalctl -u folio -f
   sudo tar czf folio-docs-$(date +%F).tar.gz -C /srv/folio docs

NEXT
