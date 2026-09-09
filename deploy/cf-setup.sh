#!/usr/bin/env bash
# folio — create Access applications + DNS record via the Cloudflare API.
# Reads the API token from ~/.config/cf-api-token (never an argument, never logged).
# Order is deliberate: every Access policy is created BEFORE the DNS record exists.
set -euo pipefail

ZONE=kz3.dev
FQDN=folio.kz3.dev
TUNNEL=e56d9ee8-37a7-4a22-bbbe-03668982baf7
OWNER=shubhchaudhary1203@gmail.com
TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/.config/cf-api-token}"
API=https://api.cloudflare.com/client/v4

[[ -r $TOKEN_FILE ]] || { echo "error: no token at $TOKEN_FILE" >&2; exit 1; }
TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
[[ -n $TOKEN ]] || { echo "error: token file is empty" >&2; exit 1; }

cf() { # cf METHOD PATH [json]
  local m=$1 p=$2 body=${3:-}
  if [[ -n $body ]]; then
    curl -sS -X "$m" "$API$p" -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" --data "$body"
  else
    curl -sS -X "$m" "$API$p" -H "Authorization: Bearer $TOKEN"
  fi
}
ok() { python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else 1)'; }
jqp() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
die() { echo "error: $*" >&2; exit 1; }

echo "==> verifying token"
cf GET /user/tokens/verify | ok || die "token rejected by Cloudflare"
echo "    token OK"

echo "==> looking up zone $ZONE"
ZR=$(cf GET "/zones?name=$ZONE")
echo "$ZR" | ok || die "cannot read zones (needs Zone:Read)"
ZONE_ID=$(echo "$ZR" | jqp 'd["result"][0]["id"]')
ACCOUNT_ID=$(echo "$ZR" | jqp 'd["result"][0]["account"]["id"]')
echo "    zone $ZONE_ID  account $ACCOUNT_ID"

# ---- service token (for /api/*) ----
echo "==> service token"
STS=$(cf GET "/accounts/$ACCOUNT_ID/access/service_tokens")
echo "$STS" | ok || die "cannot list service tokens (needs Access: Service Tokens: Edit)"
ST_ID=$(echo "$STS" | jqp 'next((t["id"] for t in d["result"] if t["name"]=="folio-cli"), "")')
if [[ -z $ST_ID ]]; then
  R=$(cf POST "/accounts/$ACCOUNT_ID/access/service_tokens" '{"name":"folio-cli","duration":"8760h"}')
  echo "$R" | ok || { echo "$R" >&2; die "service token creation failed"; }
  ST_ID=$(echo "$R" | jqp 'd["result"]["id"]')
  echo "$R" | python3 -c '
import sys,json,os,stat
d=json.load(sys.stdin)["result"]
p=os.path.expanduser("~/.config/folio/service-token.json")
os.makedirs(os.path.dirname(p),exist_ok=True)
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
os.write(fd,json.dumps({"client_id":d["client_id"],"client_secret":d["client_secret"]},indent=2).encode())
os.close(fd)
print("    secret saved to",p,"(0600) — shown by the API only once")'
else
  echo "    reusing existing service token folio-cli"
fi

# ---- Access applications ----
# name|path|decision|include-json    (path empty = whole-hostname catch-all)
APPS=(
  "folio api|/api|non_identity|[{\"service_token\":{\"token_id\":\"$ST_ID\"}}]"
  "folio public docs|/p|bypass|[{\"everyone\":{}}]"
  "folio shared docs|/t|allow|[{\"email\":{\"email\":\"$OWNER\"}}]"
  "folio|
|allow|[{\"email\":{\"email\":\"$OWNER\"}}]"
)
EXISTING=$(cf GET "/accounts/$ACCOUNT_ID/access/apps")
echo "$EXISTING" | ok || die "cannot list Access apps (needs Access: Apps and Policies: Edit)"

for spec in "${APPS[@]}"; do
  IFS='|' read -r name path decision include <<<"${spec//$'\n'/}"
  domain="$FQDN$path"
  have=$(echo "$EXISTING" | jqp "next((a['id'] for a in d['result'] if a.get('domain')=='$domain'), '')")
  if [[ -n $have ]]; then echo "==> app '$name' ($domain) exists — skipping"; continue; fi
  echo "==> creating app '$name'  ->  $domain"
  sess='"24h"'; [[ $decision == non_identity ]] && sess='"0s"'
  R=$(cf POST "/accounts/$ACCOUNT_ID/access/apps" \
      "{\"name\":\"$name\",\"domain\":\"$domain\",\"type\":\"self_hosted\",\"session_duration\":$sess}")
  echo "$R" | ok || { echo "$R" >&2; die "app creation failed for $name"; }
  APP_ID=$(echo "$R" | jqp 'd["result"]["id"]')
  P=$(cf POST "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" \
      "{\"name\":\"$name policy\",\"decision\":\"$decision\",\"include\":$include,\"precedence\":1}")
  echo "$P" | ok || { echo "$P" >&2; die "policy creation failed for $name"; }
  echo "    policy: $decision"
done

# ---- DNS last ----
echo "==> DNS record (created only now that policies exist)"
D=$(cf GET "/zones/$ZONE_ID/dns_records?name=$FQDN")
if [[ $(echo "$D" | jqp 'len(d["result"])') != "0" ]]; then
  echo "    $FQDN already exists — leaving it alone"
else
  R=$(cf POST "/zones/$ZONE_ID/dns_records" \
     "{\"type\":\"CNAME\",\"name\":\"folio\",\"content\":\"$TUNNEL.cfargotunnel.com\",\"proxied\":true,\"comment\":\"folio via cloudflared\"}")
  echo "$R" | ok || { echo "$R" >&2; die "DNS creation failed"; }
  echo "    created CNAME folio -> $TUNNEL.cfargotunnel.com (proxied)"
fi
echo
echo "==> done. Verifying from the outside may take ~30s for DNS to propagate."
