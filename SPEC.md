# folio — build spec (authoritative contract)

Single-origin, path-based HTML artifact host. Self-hosted behind Cloudflare Tunnel + Access.
Public URL: https://folio.kz3.dev   Origin: http://127.0.0.1:8082

## Hard rules
- **Node 22, ZERO runtime dependencies.** Only `node:*` builtins. No express, no npm installs.
- ESM (`"type": "module"`). No TypeScript. No build step.
- Everything must run as an unprivileged user with read/write ONLY to the docs dir.
- No secrets in code or logs. Never log token values or full request bodies.

## Config (env vars, all read at startup)
| Var | Default | Meaning |
|---|---|---|
| `FOLIO_ADDR` | `127.0.0.1` | bind address |
| `FOLIO_PORT` | `8082` | bind port |
| `FOLIO_DATA` | `/srv/folio/docs` | doc root |
| `FOLIO_TOKEN` | (required) | bearer secret for /api/* |
| `FOLIO_MAX_BYTES` | `10485760` | max doc upload (10 MiB) |
| `FOLIO_ACCESS_TEAM` | (optional) | e.g. `kz3` -> verify Cf-Access-Jwt-Assertion |
| `FOLIO_ACCESS_AUD` | (optional) | expected `aud` claim(s), comma-separated |

Startup MUST fail loudly (exit 1, clear stderr message) if `FOLIO_TOKEN` is unset/short(<16 chars)
or `FOLIO_DATA` is not a writable directory.

## Storage (filesystem is source of truth)
```
$FOLIO_DATA/<id>/index.html
$FOLIO_DATA/<id>/meta.json
$FOLIO_DATA/<id>/assets/...        (optional extra files)
```
`meta.json`:
```json
{ "id":"q3", "title":"Q3 report", "visibility":"private",
  "shared_with":[], "sandbox":true,
  "created":"2026-09-09T00:00:00Z", "updated":"...", "bytes":1234, "sha256":"..." }
```
- `visibility` ∈ `public` | `shared` | `private`
- All writes atomic: write `*.tmp` in same dir then `fs.rename`.

## ID validation (SECURITY CRITICAL)
`/^[a-z0-9][a-z0-9._-]{0,63}$/` — reject anything else with 400. Reject `.`/`..`.
Any resolved filesystem path MUST be verified to stay inside `$FOLIO_DATA/<id>/`
(resolve then check `startsWith(dir + sep)`). Traversal attempts -> 404.

## Visibility ↔ prefix mapping (SECURITY CRITICAL)
| prefix | required visibility |
|---|---|
| `/p/` | `public` |
| `/t/` | `shared` |
| `/a/` | `private` |

The origin MUST re-check that the doc's stored `visibility` matches the requested prefix and
return **404** on mismatch. Never trust the edge. A private doc requested at `/p/<id>` is a 404.

## Routes
```
GET    /                     index page (HTML, lists all docs)
GET    /healthz              200 "ok" (no auth, no logging)
GET    /p/:id  /t/:id  /a/:id           -> serve index.html
GET    /p/:id/*  /t/:id/*  /a/:id/*     -> serve asset within doc dir
PUT    /api/a/:id            publish/replace. body = raw HTML (Content-Type: text/html)
                             query/JSON header opts: ?title=&visibility=
PATCH  /api/a/:id            JSON body: {title?, visibility?, shared_with?, sandbox?}
DELETE /api/a/:id            remove doc dir
GET    /api/a                JSON list of all docs (meta only)
```
Unknown route -> 404 (plain text, no stack traces ever).

## Auth
- `/api/*`: require `Authorization: Bearer $FOLIO_TOKEN`. Compare with
  `crypto.timingSafeEqual` on equal-length buffers. Missing/wrong -> 401.
- If `FOLIO_ACCESS_TEAM` is set, `/api/*` and `/` additionally verify the
  `Cf-Access-Jwt-Assertion` header: fetch + cache JWKS from
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, verify RS256 signature,
  `exp`, and `aud` if `FOLIO_ACCESS_AUD` set. Requests from 127.0.0.1 are exempt
  (local CLI). Use `node:crypto` `createPublicKey` + `createVerify`. Cache JWKS 1h.
- Read routes (`/p /t /a`): no origin auth (Cloudflare Access gates them), but the
  prefix↔visibility check above is mandatory.

## Response headers
Doc responses (`/p/:id`, `/t/:id`, `/a/:id` and their assets):
```
Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals; worker-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store          (public docs: public, max-age=300)
```
If `meta.sandbox === false`, omit the `sandbox` directive but keep the rest.
Index page (`/`) gets a strict CSP: `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`.

## Index page
Server-rendered HTML, no JS frameworks, no external requests. Dark/light via
`prefers-color-scheme`. Shows: title, id, visibility badge, updated time, size, link.
Escape ALL interpolated values (docs are attacker-influenced text).

## CLI: bin/folio
Reads `FOLIO_URL` (default `http://127.0.0.1:8082`) and `FOLIO_TOKEN`, or `~/.config/folio/config.json`
(`{"url":"...","token":"..."}`, created with mode 0600).
```
folio publish <file> [--id X] [--title T] [--public|--shared|--private] [--no-sandbox]
folio list
folio show <id>
folio share <id> --public | --private | --shared [--with a@b.com]
folio rm <id>
```
- `--id` defaults to slugified filename. Prints the resulting public URL on success.
- Non-zero exit + clear stderr on failure. `--json` flag for machine output.

## Tests: test/*.test.js  (node --test, zero deps)
MUST cover, using a real server on an ephemeral port + temp FOLIO_DATA:
1. publish -> fetch at correct prefix -> 200
2. **private doc at /p/ -> 404** and public doc at /a/ -> 404 (the leak test)
3. path traversal `/a/x/../../etc/passwd` and encoded `%2e%2e` -> 404, never escapes
4. bad id (`../`, uppercase, 100 chars) -> 400
5. /api without token -> 401; with wrong token -> 401; right token -> 200
6. CSP sandbox header present on doc responses, absent when sandbox:false
7. oversize body -> 413
8. delete removes dir; list reflects changes
9. index page escapes `<script>` in a doc title
