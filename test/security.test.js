// folio — security tests (SPEC.md "Tests": 2 visibility leak, 3 path traversal,
// 4 id validation, 5 auth, 6 CSP headers).
// Zero dependencies. Spawns the real src/server.js on an ephemeral port with a
// throwaway FOLIO_DATA under /tmp, and tears it down in after().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const TOKEN = 'folio-test-token-0123456789abcdef';

// Markers that must never appear in a response they were not meant for.
const SENTINEL = 'FOLIO-SENTINEL-OUTSIDE-DATA-ROOT';
const PRIVATE_MARK = 'FOLIO-SECRET-PRIVATE-BODY';
const SHARED_MARK = 'FOLIO-SECRET-SHARED-BODY';
const ASSET_MARK = 'FOLIO-SECRET-ASSET-BODY';
const NEIGHBOUR_MARK = 'FOLIO-SECRET-NEIGHBOUR-BODY';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A fresh connection per request: the global agent pools keep-alive sockets,
// which would let one test's aborted body bleed into the next request.
const AGENT = new http.Agent({ keepAlive: false });
const auth = { authorization: `Bearer ${TOKEN}` };

async function freePort() {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function startServer(extraEnv = {}) {
  assert.ok(fs.existsSync(SERVER), `server not found at ${SERVER} — src/server.js must exist`);
  const root = fs.mkdtempSync('/tmp/folio-test-');
  const data = path.join(root, 'docs');
  fs.mkdirSync(data);
  // A file the server process CAN read but must never serve: it lives one
  // level above FOLIO_DATA, so only a traversal bug could expose it.
  fs.writeFileSync(path.join(root, 'secret.txt'), `${SENTINEL}\n`);
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOLIO_ADDR: '127.0.0.1',
      FOLIO_PORT: String(port),
      FOLIO_DATA: data,
      FOLIO_TOKEN: TOKEN,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const s = { child, port, root, data, base: `http://127.0.0.1:${port}`, log: () => log };

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (exited) {
      await stopServer(s);
      throw new Error(`server exited during startup (code ${child.exitCode}):\n${log}`);
    }
    try {
      const res = await fetch(`${s.base}/healthz`);
      await res.text();
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      await stopServer(s);
      throw new Error(`server never answered /healthz within 15s:\n${log}`);
    }
    await sleep(100);
  }
  return s;
}

async function stopServer(s) {
  if (!s) return;
  const { child } = s;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    await Promise.race([once(child, 'exit'), sleep(6000)]);
    clearTimeout(hard);
  }
  try { fs.rmSync(s.root, { recursive: true, force: true }); } catch {}
}

// Raw HTTP so the request-target is sent verbatim (fetch/WHATWG-URL would
// normalise dot segments before they ever reach the server).
function raw(s, method, target, opts = {}) {
  return new Promise((resolve, reject) => {
    const state = { responded: false, settled: false };
    let timer;
    const finish = (fn, arg) => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const req = http.request(
      { host: '127.0.0.1', port: s.port, method, path: target, agent: AGENT, headers: opts.headers || {} },
      (res) => {
        state.responded = true;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          finish(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          req.destroy();
        });
      },
    );
    timer = setTimeout(() => {
      req.destroy();
      finish(reject, new Error(`${method} ${target} got no response within 20s`));
    }, 20_000);
    req.on('error', (err) => {
      // A server that answers early (e.g. 413) and closes the socket can reset
      // our still-in-flight write; let a response already on the wire land first.
      setTimeout(() => finish(reject, err), 300);
    });
    const payload = opts.chunks
      ? Buffer.concat(opts.chunks.map((c) => Buffer.from(c)))
      : opts.body === undefined ? null : Buffer.from(opts.body);
    if (!payload || payload.length <= 16 * 1024) req.end(payload ?? undefined);
    else void writeGradually(req, payload, state);
  });
}

// Write a large body in steps and stop as soon as the server has answered: a
// server that rejects on Content-Length replies before the body is sent, and
// flooding the socket would race its 413 (and reset our own connection).
async function writeGradually(req, payload, state) {
  const head = payload.subarray(0, Math.min(512, payload.length));
  req.write(head);
  await sleep(60); // give a Content-Length-based rejection time to land
  const STEP = 16 * 1024;
  for (let i = head.length; i < payload.length; i += STEP) {
    if (state.responded || state.settled || req.destroyed || req.writableEnded) break;
    if (!req.write(payload.subarray(i, i + STEP))) {
      await new Promise((r) => {
        const done = () => { clearTimeout(t); req.off('drain', done); r(); };
        const t = setTimeout(done, 100);
        req.once('drain', done);
      });
    }
    await sleep(5);
  }
  if (!req.destroyed && !req.writableEnded && !state.responded) req.end();
}

function publish(s, id, html, { title, visibility } = {}) {
  const q = new URLSearchParams();
  if (title !== undefined) q.set('title', title);
  if (visibility) q.set('visibility', visibility);
  const qs = q.toString() ? `?${q}` : '';
  const body = Buffer.from(html);
  return raw(s, 'PUT', `/api/a/${id}${qs}`, {
    headers: { ...auth, 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length) },
    body,
  });
}

function patch(s, id, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  return raw(s, 'PATCH', `/api/a/${id}`, {
    headers: { ...auth, 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  });
}

const ok = (status, msg) => assert.ok(status === 200 || status === 201, `${msg} (got ${status})`);

function assertNoLeak(res, target) {
  for (const mark of [SENTINEL, PRIVATE_MARK, SHARED_MARK, ASSET_MARK, NEIGHBOUR_MARK]) {
    assert.ok(!res.body.includes(mark), `${target} leaked ${mark}`);
  }
  assert.ok(!/^root:/m.test(res.body), `${target} leaked /etc/passwd`);
}

let S;

before(async () => {
  S = await startServer();
  // Fixtures used across the whole file.
  ok((await publish(S, 'privdoc', `<p>${PRIVATE_MARK}</p>`, { title: 'Priv', visibility: 'private' })).status, 'PUT privdoc');
  ok((await publish(S, 'pubdoc', '<p>public body</p>', { title: 'Pub', visibility: 'public' })).status, 'PUT pubdoc');
  ok((await publish(S, 'shrdoc', `<p>${SHARED_MARK}</p>`, { title: 'Shr', visibility: 'shared' })).status, 'PUT shrdoc');
  ok((await publish(S, 'neighbour', `<p>${NEIGHBOUR_MARK}</p>`, { visibility: 'private' })).status, 'PUT neighbour');
  // An asset inside the private doc, written at both plausible mount points.
  fs.mkdirSync(path.join(S.data, 'privdoc', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(S.data, 'privdoc', 'assets', 'a.txt'), ASSET_MARK);
  fs.writeFileSync(path.join(S.data, 'privdoc', 'a.txt'), ASSET_MARK);
});

after(async () => { await stopServer(S); S = null; });

/* =========================================================================
   SPEC test 2 — the visibility leak. Prefix must match stored visibility.
   ========================================================================= */

test('2. a private doc is 404 at /p/ and /t/, 200 only at /a/', async () => {
  const a = await raw(S, 'GET', '/a/privdoc');
  assert.equal(a.status, 200, 'private doc must be served at /a/');
  assert.ok(a.body.includes(PRIVATE_MARK));

  for (const target of ['/p/privdoc', '/t/privdoc']) {
    const res = await raw(S, 'GET', target);
    assert.equal(res.status, 404, `${target} must be 404 for a private doc`);
    assertNoLeak(res, target);
    assert.ok(!res.body.includes('Priv'), `${target} must not disclose the title`);
  }
});

test('2. a public doc is 404 at /a/ and /t/, 200 only at /p/', async () => {
  const p = await raw(S, 'GET', '/p/pubdoc');
  assert.equal(p.status, 200, 'public doc must be served at /p/');

  for (const target of ['/a/pubdoc', '/t/pubdoc']) {
    const res = await raw(S, 'GET', target);
    assert.equal(res.status, 404, `${target} must be 404 for a public doc`);
    assert.ok(!res.body.includes('public body'), `${target} leaked the document body`);
  }
});

test('2. a shared doc is 404 at /p/ and /a/, 200 only at /t/', async () => {
  const t = await raw(S, 'GET', '/t/shrdoc');
  assert.equal(t.status, 200, 'shared doc must be served at /t/');
  assert.ok(t.body.includes(SHARED_MARK));

  for (const target of ['/p/shrdoc', '/a/shrdoc']) {
    const res = await raw(S, 'GET', target);
    assert.equal(res.status, 404, `${target} must be 404 for a shared doc`);
    assertNoLeak(res, target);
  }
});

test('2. the mismatch 404 is indistinguishable from a missing doc', async () => {
  const mismatch = await raw(S, 'GET', '/p/privdoc');
  const missing = await raw(S, 'GET', '/p/doesnotexistatall');
  assert.equal(mismatch.status, 404);
  assert.equal(missing.status, 404);
  assert.ok(!mismatch.body.includes('privdoc'), 'the 404 must not confirm the id exists');
});

test('2. visibility changes take effect immediately (no stale prefix cache)', async () => {
  ok((await publish(S, 'flip', '<p>flip body</p>', { visibility: 'private' })).status, 'PUT flip');
  assert.equal((await raw(S, 'GET', '/a/flip')).status, 200);
  assert.equal((await raw(S, 'GET', '/p/flip')).status, 404);

  ok((await patch(S, 'flip', { visibility: 'public' })).status, 'PATCH -> public');
  assert.equal((await raw(S, 'GET', '/p/flip')).status, 200, 'now public at /p/');
  assert.equal((await raw(S, 'GET', '/a/flip')).status, 404, 'must stop answering at /a/');

  ok((await patch(S, 'flip', { visibility: 'shared' })).status, 'PATCH -> shared');
  assert.equal((await raw(S, 'GET', '/t/flip')).status, 200);
  assert.equal((await raw(S, 'GET', '/p/flip')).status, 404, 'must stop answering at /p/');
  assert.equal((await raw(S, 'GET', '/a/flip')).status, 404);

  ok((await patch(S, 'flip', { visibility: 'private' })).status, 'PATCH -> private');
  const leak = await raw(S, 'GET', '/p/flip');
  assert.equal(leak.status, 404, 'a doc made private must vanish from /p/ at once');
  assert.ok(!leak.body.includes('flip body'));
});

test('2. edge headers cannot override the stored visibility', async () => {
  // meta.json is the source of truth, not anything the edge or the URL claims.
  const metaPath = path.join(S.data, 'privdoc', 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.visibility, 'private', 'fixture sanity');
  const res = await raw(S, 'GET', '/p/privdoc', { headers: { 'cf-access-authenticated-user-email': 'a@b.com' } });
  assert.equal(res.status, 404, 'edge headers must not override the stored visibility');
  assertNoLeak(res, '/p/privdoc with edge headers');
});

test('2. assets inherit the visibility of their doc', async () => {
  // Positive control: the asset is reachable at the doc's own prefix.
  const good = await Promise.all([
    raw(S, 'GET', '/a/privdoc/assets/a.txt'),
    raw(S, 'GET', '/a/privdoc/a.txt'),
  ]);
  assert.ok(good.some((r) => r.status === 200 && r.body.includes(ASSET_MARK)),
    'an asset of a private doc must be served under /a/');

  for (const target of [
    '/p/privdoc/assets/a.txt', '/t/privdoc/assets/a.txt',
    '/p/privdoc/a.txt', '/t/privdoc/a.txt',
    '/p/privdoc/index.html', '/p/privdoc/meta.json',
  ]) {
    const res = await raw(S, 'GET', target);
    assert.equal(res.status, 404, `${target} must be 404 — wrong prefix for a private doc`);
    assertNoLeak(res, target);
  }
});

/* =========================================================================
   SPEC test 3 — path traversal. Nothing may escape $FOLIO_DATA/<id>/.
   ========================================================================= */

const TRAVERSALS = [
  // literal dot segments (SPEC test 3 names this one explicitly)
  '/a/x/../../etc/passwd',
  '/a/privdoc/../../etc/passwd',
  '/a/privdoc/../../../../../../../../etc/passwd',
  '/p/pubdoc/../../etc/passwd',
  '/t/shrdoc/../../etc/passwd',
  // escape into the parent of FOLIO_DATA (our sentinel lives there)
  '/a/privdoc/../../secret.txt',
  '/a/privdoc/../../../secret.txt',
  '/a/privdoc/assets/../../../secret.txt',
  // percent-encoded dot segments (SPEC test 3: encoded %2e%2e)
  '/a/privdoc/%2e%2e/%2e%2e/etc/passwd',
  '/a/privdoc/%2E%2E/%2E%2E/secret.txt',
  '/a/privdoc/.%2e/.%2e/secret.txt',
  '/a/privdoc/%2e./%2e./secret.txt',
  // percent-encoded separators
  '/a/privdoc/..%2f..%2fsecret.txt',
  '/a/privdoc/%2e%2e%2f%2e%2e%2fsecret.txt',
  // double encoding must not be decoded twice
  '/a/privdoc/%252e%252e/%252e%252e/secret.txt',
  '/a/privdoc/%252e%252e%252fsecret.txt',
  // backslashes and mixed separators
  '/a/privdoc/..%5c..%5csecret.txt',
  '/a/privdoc/%5c..%5c..%5csecret.txt',
  // absolute-looking and empty segments
  '/a/privdoc//etc/passwd',
  '/a/privdoc/./../../secret.txt',
  // sibling document: inside FOLIO_DATA, but outside this doc's directory
  '/a/privdoc/../neighbour/index.html',
  '/a/pubdoc/../neighbour/index.html',
  '/p/pubdoc/%2e%2e/neighbour/index.html',
];

// Traversal attempts where the *id* segment itself is malformed: the spec allows
// either answer (400 from id validation, 404 from the traversal guard) — but the
// request must never succeed and never leak.
const TRAVERSALS_REFUSED = [
  '/a/privdoc%2f..%2f..%2fsecret.txt',
  '/a/..%2f..%2fsecret.txt',
  '/a/%2e%2e/%2e%2e/etc/passwd',
  '/a/../secret.txt',
  '/a//../secret.txt',
  // NUL truncation
  '/a/privdoc/../../secret.txt%00.html',
  '/a/privdoc/index.html%00.txt',
];
test('3. path traversal on doc routes -> 404, never escapes the doc dir', async () => {
  // The sentinel really is readable by this process, so a 404 proves the guard.
  assert.match(fs.readFileSync(path.join(S.root, 'secret.txt'), 'utf8'), new RegExp(SENTINEL));

  for (const target of TRAVERSALS) {
    const res = await raw(S, 'GET', target);
    assertNoLeak(res, target);
    assert.equal(res.status, 404, `${target} must be 404 (got ${res.status})`);
  }
});

test('3. malformed traversal ids are refused (400 or 404) and never leak', async () => {
  for (const target of TRAVERSALS_REFUSED) {
    const res = await raw(S, 'GET', target);
    assertNoLeak(res, target);
    assert.ok(res.status === 400 || res.status === 404,
      `${target} must be refused with 400/404 (got ${res.status})`);
  }
});

test('3. traversal in the id segment of API routes is refused', async () => {
  for (const target of [
    '/api/a/../../etc/passwd',
    '/api/a/%2e%2e/%2e%2e/secret.txt',
    '/api/a/..%2f..%2fsecret.txt',
    '/api/a/%2e%2e',
    '/api/a/../neighbour',
  ]) {
    const res = await raw(S, 'GET', target, { headers: auth });
    assert.ok(res.status === 400 || res.status === 404,
      `GET ${target} must be refused with 400/404 (got ${res.status})`);
    assertNoLeak(res, target);
  }
});

test('3. traversal cannot write or delete outside FOLIO_DATA', async () => {
  const outside = path.join(S.root, 'pwned.html');
  for (const target of [
    '/api/a/..%2f..%2fpwned',
    '/api/a/%2e%2e%2fpwned',
    '/api/a/../../pwned',
    '/api/a/..',
  ]) {
    const res = await raw(S, 'PUT', target, {
      headers: { ...auth, 'content-type': 'text/html', 'content-length': '5' },
      body: 'pwned',
    });
    assert.ok(res.status >= 400, `PUT ${target} must fail (got ${res.status})`);
    assert.equal(fs.existsSync(outside), false, `PUT ${target} wrote outside FOLIO_DATA`);
  }
  // nothing but the docs dir and our sentinel may exist under the temp root
  assert.deepEqual(fs.readdirSync(S.root).sort(), ['docs', 'secret.txt']);

  for (const target of ['/api/a/..%2f..%2fdocs', '/api/a/../../docs', '/api/a/..']) {
    const res = await raw(S, 'DELETE', target, { headers: auth });
    assert.ok(res.status >= 400, `DELETE ${target} must fail (got ${res.status})`);
  }
  assert.ok(fs.existsSync(S.data), 'FOLIO_DATA must still exist');
  assert.ok(fs.existsSync(path.join(S.data, 'privdoc', 'index.html')), 'docs must survive');
});

test('3. a symlink inside a doc dir cannot be followed out of it', async () => {
  const link = path.join(S.data, 'privdoc', 'escape.txt');
  try {
    fs.symlinkSync(path.join(S.root, 'secret.txt'), link);
  } catch {
    return; // symlinks unavailable — nothing to assert
  }
  try {
    for (const target of ['/a/privdoc/escape.txt', '/a/privdoc/assets/../escape.txt']) {
      const res = await raw(S, 'GET', target);
      assertNoLeak(res, target);
    }
  } finally {
    fs.rmSync(link, { force: true });
  }
});

/* =========================================================================
   SPEC test 4 — id validation: /^[a-z0-9][a-z0-9._-]{0,63}$/, else 400.
   ========================================================================= */

const BAD_IDS = [
  ['..', 'dot dot'],
  ['.', 'single dot'],
  ['%2e%2e', 'encoded dot dot'],
  ['%2E', 'encoded dot'],
  ['ABC', 'uppercase'],
  ['MixedCase', 'mixed case'],
  ['a'.repeat(100), '100 chars'],
  ['a'.repeat(65), '65 chars (one over the limit)'],
  ['-leading', 'leading dash'],
  ['_leading', 'leading underscore'],
  ['.leading', 'leading dot'],
  ['a%20b', 'space'],
  ['a%2Fb', 'encoded slash'],
  ['a%5Cb', 'backslash'],
  ['a%00b', 'NUL byte'],
  ['a%0Ab', 'newline'],
  ['h%C3%A9llo', 'non-ascii'],
  ['a%3Ab', 'colon'],
  ['a%24b', 'dollar sign'],
  ['%2e%2e%2f%2e%2e', 'encoded traversal'],
  ['a%25b', 'percent sign'],
];

test('4. invalid ids are rejected with 400 on PUT', async () => {
  for (const [id, why] of BAD_IDS) {
    const res = await raw(S, 'PUT', `/api/a/${id}`, {
      headers: { ...auth, 'content-type': 'text/html', 'content-length': '3' },
      body: '<p>',
    });
    assert.equal(res.status, 400, `PUT /api/a/${id} (${why}) must be 400, got ${res.status}`);
    assert.ok(!/\n\s+at\s/.test(res.body), `${why}: 400 leaked a stack trace`);
  }
  assert.deepEqual(fs.readdirSync(S.root).sort(), ['docs', 'secret.txt']);
});

test('4. invalid ids are rejected on PATCH and DELETE too', async () => {
  for (const [id, why] of BAD_IDS.slice(0, 12)) {
    const p = await patch(S, id, { title: 'x' });
    assert.equal(p.status, 400, `PATCH /api/a/${id} (${why}) must be 400, got ${p.status}`);
    const d = await raw(S, 'DELETE', `/api/a/${id}`, { headers: auth });
    assert.equal(d.status, 400, `DELETE /api/a/${id} (${why}) must be 400, got ${d.status}`);
  }
  assert.ok(fs.existsSync(path.join(S.data, 'privdoc', 'index.html')), 'docs must survive');
});

test('4. invalid ids on read routes are refused and never 200', async () => {
  for (const [id, why] of BAD_IDS) {
    for (const prefix of ['p', 't', 'a']) {
      const res = await raw(S, 'GET', `/${prefix}/${id}`);
      assert.ok(res.status === 400 || res.status === 404,
        `GET /${prefix}/${id} (${why}) must be 400/404, got ${res.status}`);
      assertNoLeak(res, `/${prefix}/${id}`);
    }
  }
});

test('4. ids at the edge of the allowed grammar are accepted', async () => {
  const longest = `a${'b'.repeat(63)}`; // 64 chars = the maximum
  for (const id of ['a', '0', longest, 'a.b_c-d.9', '9-lives']) {
    const res = await publish(S, id, '<p>edge</p>', { visibility: 'public' });
    ok(res.status, `PUT /api/a/${id} must be accepted`);
    assert.equal((await raw(S, 'GET', `/p/${id}`)).status, 200);
    assert.ok(res.status < 400);
    await raw(S, 'DELETE', `/api/a/${id}`, { headers: auth });
  }
});

/* =========================================================================
   SPEC test 5 — bearer auth on /api/*.
   ========================================================================= */

const BAD_AUTH = [
  [undefined, 'no Authorization header'],
  ['', 'empty Authorization header'],
  ['Bearer', 'Bearer with no value'],
  ['Bearer ', 'Bearer with empty value'],
  [`Bearer ${TOKEN}x`, 'token with a trailing character'],
  [`Bearer ${TOKEN.slice(0, -1)}`, 'truncated token (shorter)'],
  [`Bearer ${TOKEN.slice(0, -1)}X`, 'same-length wrong token'],
  ['Bearer wrong-token-entirely', 'a different token'],
  ['Bearer ' + 'a'.repeat(4096), 'absurdly long token'],
  [`Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}`, 'basic auth'],
  [TOKEN, 'bare token without the Bearer scheme'],
  [`bearer ${TOKEN}`.toUpperCase(), 'uppercased scheme and token'],
];

test('5. /api/* without a valid bearer token -> 401', async () => {
  for (const [value, why] of BAD_AUTH) {
    const headers = value === undefined ? {} : { authorization: value };
    const res = await raw(S, 'GET', '/api/a', { headers });
    assert.equal(res.status, 401, `GET /api/a with ${why} must be 401, got ${res.status}`);
    assert.ok(!res.body.includes(TOKEN), `${why}: the 401 body echoed the token`);
    assert.ok(!JSON.stringify(res.headers).includes(TOKEN), `${why}: the token leaked in headers`);
  }
});

test('5. a token in the query string is not accepted', async () => {
  const res = await raw(S, 'GET', `/api/a?token=${TOKEN}`);
  assert.equal(res.status, 401);
});

test('5. /api/* with the right token -> 200', async () => {
  const res = await raw(S, 'GET', '/api/a', { headers: auth });
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  const docs = Array.isArray(parsed) ? parsed : parsed.docs;
  assert.ok(Array.isArray(docs));
  assert.ok(docs.some((d) => d.id === 'privdoc'));
});

test('5. unauthenticated writes are refused and have no side effects', async () => {
  const anon = '<p>hi</p>';
  const put = await raw(S, 'PUT', '/api/a/nobody', {
    headers: { 'content-type': 'text/html', 'content-length': String(Buffer.byteLength(anon)) },
    body: anon,
  });
  assert.equal(put.status, 401, 'PUT without a token must be 401');
  assert.equal(fs.existsSync(path.join(S.data, 'nobody')), false, 'no doc may be created');

  const anonPatch = '{"visibility":"public"}';
  const patchRes = await raw(S, 'PATCH', '/api/a/privdoc', {
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(anonPatch)) },
    body: anonPatch,
  });
  assert.equal(patchRes.status, 401, 'PATCH without a token must be 401');
  assert.equal(JSON.parse(fs.readFileSync(path.join(S.data, 'privdoc', 'meta.json'), 'utf8')).visibility,
    'private', 'an unauthenticated PATCH must not change visibility');

  const delRes = await raw(S, 'DELETE', '/api/a/privdoc', { headers: { authorization: 'Bearer nope' } });
  assert.equal(delRes.status, 401, 'DELETE with a wrong token must be 401');
  assert.ok(fs.existsSync(path.join(S.data, 'privdoc', 'index.html')), 'the doc must survive');
});

test('5. read routes and /healthz need no token', async () => {
  assert.equal((await raw(S, 'GET', '/p/pubdoc')).status, 200);
  assert.equal((await raw(S, 'GET', '/healthz')).status, 200);
});

/* =========================================================================
   SPEC test 6 — CSP and hardening headers on doc responses.
   ========================================================================= */

function assertDocHeaders(res, target) {
  assert.equal(String(res.headers['x-content-type-options']), 'nosniff', `${target}: nosniff`);
  assert.equal(String(res.headers['referrer-policy']), 'no-referrer', `${target}: referrer-policy`);
  const csp = String(res.headers['content-security-policy'] || '');
  assert.ok(csp, `${target}: missing Content-Security-Policy`);
  assert.match(csp, /worker-src 'none'/, `${target}: worker-src 'none'`);
  return csp;
}

test('6. doc responses carry the sandbox CSP by default', async () => {
  for (const [target, cache] of [['/a/privdoc', /no-store/], ['/t/shrdoc', /no-store/], ['/p/pubdoc', /public/]]) {
    const res = await raw(S, 'GET', target);
    assert.equal(res.status, 200, target);
    const csp = assertDocHeaders(res, target);
    assert.match(csp, /sandbox\s+allow-scripts\s+allow-popups\s+allow-forms\s+allow-modals/,
      `${target}: full sandbox directive`);
    assert.match(String(res.headers['cache-control']), cache, `${target}: cache-control`);
  }
  const pub = await raw(S, 'GET', '/p/pubdoc');
  assert.match(String(pub.headers['cache-control']), /max-age=300/);
});

test('6. sandbox:false omits only the sandbox directive', async () => {
  ok((await publish(S, 'nosb', '<p>no sandbox</p>', { visibility: 'public' })).status, 'PUT nosb');
  const before = await raw(S, 'GET', '/p/nosb');
  assert.match(String(before.headers['content-security-policy']), /sandbox/);

  ok((await patch(S, 'nosb', { sandbox: false })).status, 'PATCH sandbox:false');
  const after = await raw(S, 'GET', '/p/nosb');
  assert.equal(after.status, 200);
  const csp = assertDocHeaders(after, '/p/nosb');
  assert.ok(!/sandbox/.test(csp), `sandbox directive must be gone, got: ${csp}`);

  ok((await patch(S, 'nosb', { sandbox: true })).status, 'PATCH sandbox:true');
  const back = await raw(S, 'GET', '/p/nosb');
  assert.match(String(back.headers['content-security-policy']), /sandbox/, 'sandbox must come back');
});

test('6. assets of a doc get the same hardening headers', async () => {
  const candidates = ['/a/privdoc/assets/a.txt', '/a/privdoc/a.txt'];
  const served = [];
  for (const target of candidates) {
    const res = await raw(S, 'GET', target);
    if (res.status === 200) served.push([target, res]);
  }
  assert.ok(served.length > 0, 'at least one asset path must be served');
  for (const [target, res] of served) {
    const csp = assertDocHeaders(res, target);
    assert.match(csp, /sandbox/, `${target}: assets of a sandboxed doc stay sandboxed`);
  }
});

test('6. 404 and error responses never contain a stack trace', async () => {
  for (const target of ['/p/privdoc', '/a/nothinghere', '/totally/unknown']) {
    const res = await raw(S, 'GET', target);
    assert.ok(!/\n\s+at\s/.test(res.body), `${target} leaked a stack trace`);
    assert.ok(!res.body.includes(ROOT), `${target} leaked a filesystem path`);
    assert.ok(!res.body.includes(S.data), `${target} leaked FOLIO_DATA`);
  }
});
