# folio

**Publish a one-page HTML artifact from the command line. Get back a URL on
your own domain. Nothing touches a third party.**

[![Live product page](https://img.shields.io/badge/product%20page-folio.kz3.dev-2f5bd8)](https://folio.kz3.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933)](package.json)
[![Zero runtime deps](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Tests](https://img.shields.io/badge/tests-47%20passing-2f5bd8)](test/)

![One document, three gateways: a server on the left feeds a single sheet of paper through an open teal gate, a half-closed amber gate, and a locked indigo gate — public, shared and private.](assets/banner.jpg)

folio is a small, self-hosted host for single-page HTML artifacts — reports,
dashboards, mockups, build logs, anything that is one `index.html` plus maybe
some assets. You publish a file, you get a URL back, and the document lives as
a plain directory on your own disk — no database, no managed service, no
account to create anywhere else.

- **Live product page:** [folio.kz3.dev](https://folio.kz3.dev)
- **Origin:** `http://127.0.0.1:8082` (loopback only, reached via Cloudflare Tunnel)
- **Runtime:** Node 22, **zero dependencies**, no build step — read the whole
  server in one sitting (`src/`, ~900 lines).

```sh
folio publish ./report.html --public --folder reports --tag q3
# -> https://folio.kz3.dev/p/report
```

### Why this instead of a gist, a bucket, or a SaaS dashboard tool

- **You own the bytes.** A document is a directory (`index.html`, `meta.json`,
  `assets/`). Backup is `tar czf`. There is no vendor to lose access to.
- **Visibility is the URL, truthfully.** `/p/` public, `/t/` shared with named
  people, `/a/` private — and the origin independently re-checks that the
  stored visibility matches the prefix on *every* request, so a leaked old
  link 404s instead of quietly still working.
- **Browse by folder and tag, not just a flat list.** Every document can carry
  a folder and free-form subtags; `/main` filters them with CSS-only
  checkboxes — no client JavaScript runs anywhere on this host, ever.
- **Nothing to audit but ~900 lines.** No framework, no transitive dependency
  tree, no build pipeline between the code you read and the code that runs.

---

## The visibility / prefix model

Every document has a `visibility` of `public`, `shared`, or `private`, and each
visibility is served under its own URL prefix:

| Prefix | Visibility | Who can reach it |
|---|---|---|
| `/p/<id>` | `public` | anyone on the internet (Access **Bypass**) |
| `/t/<id>` | `shared` | the email addresses you list in the Access policy |
| `/a/<id>` | `private` | you only |
| `/` | — | the public product page (this project, not your documents) |
| `/main` | — | index of every document, folder/tag filterable; you only |

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
   proxied CNAME and five Access applications (one new one, §3 App 5, makes
   `/` public — the pre-existing four are unchanged).

### Upgrading an existing install to the `/` + `/main` split

This version moves the private document index from `/` to `/main` and puts a
public product page at `/`. On a server that already runs an older folio:

```sh
cd ~/folio && git pull
sudo ./install.sh                 # redeploys code, does not touch documents
sudo systemctl restart folio
./scripts/apply-tags.sh           # one-time: seeds folder/tags on existing docs
```

Then add the one new Cloudflare Access application described in
[`deploy/ACCESS.md` §3, App 5](deploy/ACCESS.md) so `/` is reachable without a
login — the pre-existing four applications (`api/*`, `p/*`, `t/*`, catch-all)
are untouched and still guard everything else, including `/main`.

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
folio publish ./deck.html --id q3-deck --public --folder reports --tag q3 --tag finance
folio list
folio show q3-deck
folio share q3-deck --shared --with alice@example.com
folio share q3-deck --private
folio tag q3-deck --folder reports --tag q3           # re-tag an existing doc
folio rm q3-deck
```

- `--id` defaults to a slug of the filename.
- Visibility flags: `--public` | `--shared` | `--private`.
- `--folder F` / `--tag T` (repeatable) organise the document for `/main`'s
  filterable index — both are slugs (`/^[a-z0-9][a-z0-9-]{0,31}$/`), purely
  organisational, and never affect auth or the URL.
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
PUT    /api/a/:id      body = raw HTML (Content-Type: text/html), ?title=&visibility=&folder=&tags=a,b
PATCH  /api/a/:id      JSON {title?, visibility?, shared_with?, folder?, tags?, sandbox?}
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
scripts/tags.json       folder/subtags for every existing document (one-time seed)
scripts/apply-tags.sh   applies tags.json via the API — run once after upgrading
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
