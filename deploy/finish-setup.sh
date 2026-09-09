#!/usr/bin/env bash
# folio — one-shot privileged setup. Run with: sudo ~/folio/deploy/finish-setup.sh
# Idempotent. Safe to re-run. Never touches the babel ingress rule or your documents.
set -euo pipefail

TUNNEL_ID=e56d9ee8-37a7-4a22-bbbe-03668982baf7
CF_CONFIG=/etc/cloudflared/config.yml
HOSTNAME_FQDN=folio.kz3.dev
PORT=8082
SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# The provisional user-level instance belongs to `agent`, NOT to whoever runs
# this script (that is normally `ubuntu`, the only sudo-capable account).
PROV_USER="${FOLIO_PROVISIONAL_USER:-agent}"
PROV_UID="$(id -u "$PROV_USER" 2>/dev/null || true)"
PROV_HOME="$(getent passwd "$PROV_USER" | cut -d: -f6)"

[[ $EUID -eq 0 ]] || { echo "error: run with sudo" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

# 1. Free port 8082: the provisional user-level unit must go first, otherwise
#    install.sh's /healthz probe answers from the OLD process and reports success
#    while the new system unit fails to bind.
say "stopping provisional user-level folio owned by $PROV_USER (if running)"
uctl() { runuser -u "$PROV_USER" -- env XDG_RUNTIME_DIR="/run/user/$PROV_UID" systemctl --user "$@"; }
if [[ -n "$PROV_UID" ]] && uctl is-active folio.service >/dev/null 2>&1; then
  uctl disable --now folio.service || true
  echo "    stopped and disabled $PROV_HOME/.config/systemd/user/folio.service"
else
  echo "    not running"
fi
sleep 1
if ss -tlnp 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
  echo "error: port $PORT still in use after stopping the user unit:" >&2
  ss -tlnp | grep "127.0.0.1:$PORT" >&2; exit 1
fi

# 2. System install
say "running install.sh"
bash "$SRC/install.sh"

# 3. Migrate documents from the provisional instance (copy, never move)
OLD_DOCS="$PROV_HOME/.local/share/folio/docs"
if [[ -d "$OLD_DOCS" ]] && [[ -n "$(ls -A "$OLD_DOCS" 2>/dev/null)" ]]; then
  say "migrating documents from $OLD_DOCS"
  cp -a "$OLD_DOCS/." /srv/folio/docs/
  chown -R folio:folio /srv/folio/docs
  echo "    copied $(find "$OLD_DOCS" -mindepth 1 -maxdepth 1 -type d | wc -l) document(s); originals left in place"
fi

# 4. Tunnel ingress — insert before the catch-all, leaving every other rule alone
say "configuring tunnel ingress in $CF_CONFIG"
if grep -q "hostname: $HOSTNAME_FQDN" "$CF_CONFIG"; then
  echo "    $HOSTNAME_FQDN already present — leaving config unchanged"
else
  cp -a "$CF_CONFIG" "$CF_CONFIG.bak.$(date +%Y%m%d%H%M%S)"
  echo "    backed up to $CF_CONFIG.bak.*"
  python3 - "$CF_CONFIG" "$HOSTNAME_FQDN" "$PORT" <<'PY'
import re, sys
path, fqdn, port = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
m = re.search(r'^(\s*)-\s*service:\s*http_status:404\s*$', src, re.M)
if not m:
    sys.exit("could not find the '- service: http_status:404' catch-all; edit manually")
indent = m.group(1)
rule = f"{indent}- hostname: {fqdn}\n{indent}  service: http://127.0.0.1:{port}\n"
open(path, 'w').write(src[:m.start()] + rule + src[m.start():])
print(f"    inserted {fqdn} -> http://127.0.0.1:{port} before the catch-all")
PY
fi

say "validating tunnel config"
cloudflared --config "$CF_CONFIG" tunnel ingress validate

say "restarting cloudflared"
systemctl restart cloudflared
sleep 2
systemctl is-active --quiet cloudflared || { journalctl -u cloudflared -n 30 --no-pager >&2; exit 1; }

# 5. Verify
say "verifying"
systemctl is-active --quiet folio && echo "    folio: active" || { journalctl -u folio -n 30 --no-pager >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz")
echo "    /healthz: $code"; [[ "$code" == "200" ]] || exit 1
cloudflared --config "$CF_CONFIG" tunnel ingress rule "https://$HOSTNAME_FQDN/p/x" | sed 's/^/    /'

cat <<NEXT

==> Origin is up and the tunnel routes $HOSTNAME_FQDN.

Remaining (Cloudflare dashboard — cannot be done from this machine).
DO THESE IN THIS ORDER:

  1. ACCESS FIRST.  one.dash.cloudflare.com -> Access -> Applications
     Create all four apps for folio.kz3.dev per $SRC/deploy/ACCESS.md.
     Access applications can be created before the DNS record exists.

     >> ORDER MATTERS. If the DNS record exists before the Access apps,
     >> folio.kz3.dev is served with NO authentication at all: not just /p/,
     >> but /a/ (private docs) and / (the index) are readable by anyone who
     >> knows the hostname. The origin trusts Access to gate reads.

  2. DNS SECOND.  dash.cloudflare.com -> kz3.dev -> DNS -> Add record
       CNAME   folio   ${TUNNEL_ID}.cfargotunnel.com   [Proxied]
     or from here:
       sudo cloudflared tunnel route dns ${TUNNEL_ID} ${HOSTNAME_FQDN}

  3. Verify from a browser that is NOT logged in to Access:
       curl -sI https://${HOSTNAME_FQDN}/         # expect 302 to cloudflareaccess.com
       curl -sI https://${HOSTNAME_FQDN}/a/welcome # expect 302, NOT 200

  4. CLI token for your user:
       sudo sed -n 's/^FOLIO_TOKEN=//p' /etc/folio/env

NEXT
