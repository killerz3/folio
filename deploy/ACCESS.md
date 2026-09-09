# folio — Cloudflare DNS + Access setup

Click-by-click setup for `folio.kz3.dev` on tunnel
`<tunnel-id>`.

Do this **after** `sudo ./install.sh` has run and the tunnel ingress snippet
(`deploy/cloudflared-ingress.yml`) is in `/etc/cloudflared/config.yml`.

Two different dashboards are involved:

| What | Where |
|---|---|
| DNS record | **dash.cloudflare.com** → the `kz3.dev` zone |
| Access applications, service tokens | **one.dash.cloudflare.com** (Zero Trust) |

---

## 1. DNS: one proxied CNAME

1. Go to <https://dash.cloudflare.com> and pick the **kz3.dev** zone.
2. Left sidebar → **DNS** → **Records**.
3. Click **Add record**.
4. Fill in exactly:
   - **Type**: `CNAME`
   - **Name**: `folio`  ← just the label, not `folio.kz3.dev`
   - **Target**: `<tunnel-id>.cfargotunnel.com`
   - **Proxy status**: **Proxied** (the cloud toggle must be **orange**).
     A grey/DNS-only record cannot resolve a `.cfargotunnel.com` target and
     will fail — this is the single most common mistake here.
   - **TTL**: `Auto` (forced when proxied)
5. **Save**.

Equivalent from the shell on the tunnel host, if you prefer:

```sh
sudo cloudflared tunnel route dns <tunnel-id> folio.kz3.dev
```

Verify:

```sh
dig +short folio.kz3.dev          # returns Cloudflare anycast IPs, not the origin
curl -sI https://folio.kz3.dev/p/none   # 404 from the origin, or an Access redirect
```

If you get error 1033, the DNS record exists but the tunnel is not routing that
hostname — re-check the ingress snippet and `sudo systemctl restart cloudflared`.

---

## 2. Service token for the CLI / CI

Only needed if you will call `/api/*` **through the public hostname**. The CLI
running on the host itself talks to `http://127.0.0.1:8082` and skips Access
entirely.

1. <https://one.dash.cloudflare.com> → **Access** → **Service Auth** →
   **Service Tokens**.
2. **Create Service Token**.
   - **Service token name**: `folio-cli`
   - **Service Token Duration**: `1 year` (rotate on expiry)
3. **Generate token**. You are shown two values **once**:
   - **Client ID** → sent as header `CF-Access-Client-Id`
   - **Client Secret** → sent as header `CF-Access-Client-Secret`

   Copy both now; the secret is never shown again. Store them in a password
   manager, or on a client machine in a `0600` file.

A request through the edge then needs **three** headers — two for Access, one
for folio's own bearer check:

```sh
curl -X PUT https://folio.kz3.dev/api/a/q3 \
  -H "CF-Access-Client-Id: <client-id>" \
  -H "CF-Access-Client-Secret: <client-secret>" \
  -H "Authorization: Bearer $FOLIO_TOKEN" \
  -H "Content-Type: text/html" \
  --data-binary @report.html
```

Access gates the request at the edge; `FOLIO_TOKEN` is checked again at the
origin. Neither one alone is sufficient.

---

## 3. The four Access applications

### How path matching works — read this first

All four applications sit on the same hostname and differ only by path.
**Cloudflare evaluates the most specific matching path**, not the first one
created, so ordering in the list does not matter and overlap is fine:

| Request | App that decides |
|---|---|
| `https://folio.kz3.dev/api/a/q3` | `api/*` (Service Auth) |
| `https://folio.kz3.dev/p/q3` | `p/*` (Bypass) |
| `https://folio.kz3.dev/t/q3` | `t/*` (Allow, listed emails) |
| `https://folio.kz3.dev/a/q3` | `*` (Allow, owner) |
| `https://folio.kz3.dev/` | `*` (Allow, owner) |
| `https://folio.kz3.dev/healthz` | `*` (Allow, owner) |

The bare-hostname app is the catch-all: anything not covered by a more
specific app lands there, so a new route added to folio later is private by
default rather than open by default. Create it — do not skip it.

The path field in the UI is entered **without** a leading slash: `api/*`,
`p/*`, `t/*`. For the catch-all, leave the path field empty.

### Common steps for every application

1. <https://one.dash.cloudflare.com> → **Access** → **Applications**.
2. **Add an application** → **Self-hosted**.
3. **Application name**: as listed below.
4. **Session Duration**: `24 hours` (`No duration, expires immediately` for the
   API app).
5. Under **Public hostname**, click **Add public hostname** and set:
   - **Subdomain**: `folio`
   - **Domain**: `kz3.dev`
   - **Path**: as listed below
6. **Next** → add the policy described below → **Next** → **Save**.

Repeat four times.

---

### App 1 — `folio api` → `folio.kz3.dev/api/*` (Service Auth)

- **Path**: `api/*`
- **Session Duration**: `No duration, expires immediately`
- Policy:
  - **Policy name**: `folio service token`
  - **Action**: **Service Auth**
  - **Include** → selector **Service Token** → value `folio-cli`
    (or **Any Access Service Token** if you would rather not pin it)
- In the application's **Settings** step, leave **Bypass Access for
  Cloudflare Tunnel / browser rendering** off.

`Service Auth` means *no interactive login is ever offered*. A browser hitting
`/api/*` gets a 403 rather than a login page — that is intended; the write API
is for the CLI only.

### App 2 — `folio public docs` → `folio.kz3.dev/p/*` (Bypass)

- **Path**: `p/*`
- Policy:
  - **Policy name**: `everyone`
  - **Action**: **Bypass**
  - **Include** → selector **Everyone**

Bypass = no authentication at all, for anyone on the internet. This is the
only genuinely public surface. The origin independently refuses to serve a
document under `/p/` unless its stored `visibility` is `public`, so a Bypass
policy here cannot leak a private document — a private id at `/p/` is a 404.

### App 3 — `folio shared docs` → `folio.kz3.dev/t/*` (Allow, listed emails)

- **Path**: `t/*`
- Policy:
  - **Policy name**: `shared viewers`
  - **Action**: **Allow**
  - **Include** → selector **Emails** → add each address on its own line,
    e.g. `<your-email>`, plus whoever you are sharing with
  - (For a whole company, use **Emails ending in** → `@example.com` instead.)

Viewers get a one-time PIN / identity-provider login at the edge. Editing the
guest list is done here, in this policy — folio's `shared_with` field is
metadata for the index page and does **not** enforce anything by itself.

### App 4 — `folio` → `folio.kz3.dev/*` (Allow, owner only)

- **Path**: leave **empty** (covers the whole hostname)
- Policy:
  - **Policy name**: `owner`
  - **Action**: **Allow**
  - **Include** → selector **Emails** → `<your-email>`

This is what protects the index page at `/` and every private document under
`/a/*`.

---

## 4. Optional: verify Access JWTs at the origin too

Belt and braces — stops anything that reaches port 8082 without passing
through the tunnel.

1. Open any of the four applications → **Overview** tab → copy the
   **Application Audience (AUD) Tag**.
2. On the host, edit `/etc/folio/env` (it is `0600 root:folio`):

   ```
   FOLIO_ACCESS_TEAM=kz3
   FOLIO_ACCESS_AUD=<the AUD tag>
   ```

3. `sudo systemctl restart folio`

Each application has its **own** AUD tag, so `FOLIO_ACCESS_AUD` accepts a
**comma-separated list** — a token is accepted if it matches any of them:

```
FOLIO_ACCESS_TEAM=kz3
FOLIO_ACCESS_AUD=<catch-all app AUD>,<api app AUD>
```

List the catch-all `folio.kz3.dev/*` app (guards `/` and `/a/*`) and the
`api/*` app. Leaving `FOLIO_ACCESS_AUD` unset verifies signature and expiry
only. Requests from `127.0.0.1` are exempt, so the local CLI keeps working
either way.

---

## 5. Verify the whole chain

From a machine that is **not** logged in to Access:

```sh
# public doc  -> 200, no login
curl -sI https://folio.kz3.dev/p/<public-id>

# index       -> 302 to <team>.cloudflareaccess.com (login required)
curl -sI https://folio.kz3.dev/

# private doc -> 302 to login (and 404 from the origin even after login
#                if the doc's visibility is not "private")
curl -sI https://folio.kz3.dev/a/<private-id>

# api without a service token -> 403 from Access
curl -sI https://folio.kz3.dev/api/a

# api with service token but no bearer -> 401 from the origin
curl -sI https://folio.kz3.dev/api/a \
  -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>"
```

If `/p/*` asks for a login, the Bypass app's path is wrong (check for a stray
leading slash). If `/` does **not** ask for a login, the catch-all app is
missing — fix that immediately; the index lists every document.
