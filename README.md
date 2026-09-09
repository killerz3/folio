# folio

A small, self-hosted host for one-page HTML artifacts — reports, dashboards,
mockups, anything that is a single `index.html` plus maybe some assets.

You publish a file from the command line and get back a URL on your own
domain. Nothing is uploaded to a third party, the documents live as plain
files on disk, and who can see what is decided by two independent layers:
Cloudflare Access at the edge and folio itself at the origin.

- Public URL: `https://folio.kz3.dev`
- Origin: `http://127.0.0.1:8082` (loopback only, reached via Cloudflare Tunnel)
- Node 22, **zero runtime dependencies**, no build step.

---

## The visibility / prefix model

Every document has a `visibility` of `public`, `shared`, or `private`, and each
visibility is served under its own URL prefix:

| Prefix | Visibility | Who can reach it |
|---|---|---|
| `/p/<id>` | `public` | anyone on the internet (Access **Bypass**) |
| `/t/<id>` | `shared` | the email addresses you list in the Access policy |
| `/a/<id>` | `private` | you only |
| `/` | — | index of every document; you only |

The two layers are deliberately redundant:

- **Cloudflare Access** decides who may reach a prefix at all. A request for
  `/a/...` from a stranger never reaches your server.
- **folio** re-checks, for every request, that the document's stored
  visibility matches the prefix it was asked for, and returns **404** if it
  does not. It never trusts the edge. A private document requested at
  `/p/<id>` is a 404 even if Access lets the request through, and a public
  document requested at `/a/<id>` is a 404 too.

So changing a document's visibility is a single operation (`folio share`) that
changes its URL, and a leaked old URL stops working rather than continuing to
serve the file.

Documents are served with a sandboxing `Content-Security-Policy`, `nosniff`,
and `Referrer-Policy: no-referrer`. Publish with `--no-sandbox` only for
documents you wrote yourself and that genuinely need same-origin behaviour.

---

## Layout on disk

```
/srv/folio/            application code, owned by root, read-only to the service
/srv/folio/docs/       the document root — the only writable path
  <id>/index.html
  <id>/meta.json
  <id>/assets/...
/etc/folio/env         FOLIO_TOKEN and friends, 0600 root:folio
/etc/systemd/system/folio.service
```

The filesystem is the source of truth: there is no database, and a document is
exactly the directory that holds it.

---

## Install

On the server, as a user with sudo:

```sh
git clone <this repo> ~/folio
cd ~/folio
sudo ./install.sh
```

`install.sh` is idempotent — re-run it to deploy new code. It:

- creates the system user and group `folio` (no home, no login shell);
- installs the code to `/srv/folio` (root-owned, read-only to the service) and
  creates `/srv/folio/docs` owned by `folio`;
- generates `FOLIO_TOKEN` with `openssl rand -base64 32` into `/etc/folio/env`
  (mode `0600`, `root:folio`) **only if no token is there yet** — re-running
  never rotates the token and never touches your documents;
- installs and enables the systemd unit, then fails loudly if `/healthz` does
  not answer;
- prints the remaining manual steps.

Then do the two manual steps it names:

1. **Tunnel** — paste `deploy/cloudflared-ingress.yml` into
   `/etc/cloudflared/config.yml` above the `http_status:404` catch-all,
   `cloudflared tunnel ingress validate`, restart `cloudflared`.
2. **DNS + Access** — follow [`deploy/ACCESS.md`](deploy/ACCESS.md): one
   proxied CNAME and four Access applications.

### Configuration

Everything is environment variables, read once at startup from
`/etc/folio/env`:

| Var | Default | Meaning |
|---|---|---|
| `FOLIO_ADDR` | `127.0.0.1` | bind address — keep it on loopback |
| `FOLIO_PORT` | `8082` | bind port |
| `FOLIO_DATA` | `/srv/folio/docs` | document root |
| `FOLIO_TOKEN` | *(required)* | bearer secret for `/api/*` |
| `FOLIO_MAX_BYTES` | `10485760` | max document size (10 MiB) |
| `FOLIO_ACCESS_TEAM` | *(unset)* | e.g. `kz3` — also verify Access JWTs at the origin |
| `FOLIO_ACCESS_AUD` | *(unset)* | expected `aud` claim(s), comma-separated |

After editing: `sudo systemctl restart folio`.

---

## CLI

`install.sh` links the CLI to `/usr/local/bin/folio`. It reads `FOLIO_URL`
(default `http://127.0.0.1:8082`) and `FOLIO_TOKEN` from the environment, or
from `~/.config/folio/config.json` (mode `0600`):

```json
{ "url": "http://127.0.0.1:8082", "token": "…" }
```

```sh
folio publish ./report.html --title "Q3 report" --private
folio publish ./deck.html --id q3-deck --public
folio list
folio show q3-deck
folio share q3-deck --shared --with alice@example.com
folio share q3-deck --private
folio rm q3-deck
```

- `--id` defaults to a slug of the filename.
- Visibility flags: `--public` | `--shared` | `--private`.
- `--no-sandbox` drops the CSP sandbox for that document.
- `--json` gives machine-readable output; failures exit non-zero with a
  message on stderr.

`publish` prints the resulting public URL, which reflects the visibility you
chose (`/p/`, `/t/`, or `/a/`).

Running the CLI **on the server** is the simple path: it talks to loopback and
never touches Cloudflare Access. From a laptop, point `FOLIO_URL` at
`https://folio.kz3.dev` and add the service-token headers described in
`deploy/ACCESS.md`.

### The HTTP API, if you need it directly

```
PUT    /api/a/:id      body = raw HTML (Content-Type: text/html), ?title=&visibility=
PATCH  /api/a/:id      JSON {title?, visibility?, shared_with?, sandbox?}
DELETE /api/a/:id      remove the document
GET    /api/a          JSON list of all documents (metadata only)
GET    /healthz        200 "ok", no auth
```

All `/api/*` calls need `Authorization: Bearer $FOLIO_TOKEN`.

---

## Operations

```sh
systemctl status folio
journalctl -u folio -f
sudo systemctl restart folio
curl -s http://127.0.0.1:8082/healthz     # -> ok
```

The service runs under a tight systemd sandbox: `ProtectSystem=strict`,
`ProtectHome=yes`, `PrivateTmp`, `PrivateDevices`, no capabilities,
`MemoryMax=512M`, and `ReadWritePaths=/srv/folio/docs` — the document root is
the only path it can write. Tokens are never logged.

### Backup

Documents are just files, so a tarball is a complete backup:

```sh
sudo tar czf ~/folio-docs-$(date +%F).tar.gz -C /srv/folio docs
```

Back up `/etc/folio/env` separately and treat it as a secret (it contains
`FOLIO_TOKEN`); it is not part of the document tarball on purpose.

### Restore

```sh
sudo systemctl stop folio
sudo tar xzf ~/folio-docs-2026-09-09.tar.gz -C /srv/folio
sudo chown -R folio:folio /srv/folio/docs
sudo systemctl start folio
```

Restoring over an existing tree merges rather than replaces; to restore
exactly, move the current `docs` aside first (`sudo mv /srv/folio/docs
/srv/folio/docs.old`) instead of deleting it.

### Rolling the API token

The token only guards `/api/*` (writes). Rolling it does not affect published
documents or their URLs.

```sh
# 1. new token
NEW=$(openssl rand -base64 32)

# 2. replace it in place, keeping the rest of the file
sudo sed -i "s|^FOLIO_TOKEN=.*|FOLIO_TOKEN=${NEW}|" /etc/folio/env
sudo chown root:folio /etc/folio/env && sudo chmod 600 /etc/folio/env

# 3. restart and confirm
sudo systemctl restart folio
curl -s http://127.0.0.1:8082/healthz

# 4. update every client
#    - ~/.config/folio/config.json on each machine  ("token": "…", mode 0600)
#    - any CI secret / password-manager entry
printf '%s\n' "$NEW"
unset NEW
```

Note that `install.sh` will **not** overwrite the new value — it only
generates a token when none exists.

Rotating the Cloudflare **service token** is separate and lives in the Zero
Trust dashboard (`deploy/ACCESS.md`, §2).

---

## Repository layout

```
src/                    the server (zero dependencies)
bin/folio               the CLI
test/*.test.js          node --test, no dependencies
systemd/folio.service   the hardened unit
deploy/ACCESS.md        Cloudflare DNS + Access, click-by-click
deploy/cloudflared-ingress.yml
install.sh              idempotent installer (run with sudo)
SPEC.md                 the authoritative build contract
```

Tests: `node --test` from the repo root.

---

## Provisional user-level instance (currently running)

Before `install.sh` is run, folio is running as a **user** systemd unit so it is
usable immediately without root. Linger is enabled, so it survives reboots.

| | Path |
|---|---|
| unit | `~/.config/systemd/user/folio.service` |
| data | `~/.local/share/folio/docs` |
| token / CLI config | `~/.config/folio/env`, `~/.config/folio/config.json` (0600) |
| CLI on PATH | `~/.local/bin/folio` → `~/folio/bin/folio` |

```sh
systemctl --user status folio
systemctl --user restart folio
journalctl --user -u folio -f
```

### Migrating to the system install

The system service binds the same port (8082), so **stop the user unit first**:

```sh
systemctl --user disable --now folio
sudo ./install.sh
# then move existing docs across:
sudo cp -a ~/.local/share/folio/docs/. /srv/folio/docs/
sudo chown -R folio:folio /srv/folio/docs
sudo systemctl restart folio
```

The system install generates its own `FOLIO_TOKEN` in `/etc/folio/env`; update
`~/.config/folio/config.json` to match, or point the CLI at it.
