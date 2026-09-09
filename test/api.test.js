// folio — HTTP contract tests (SPEC.md "Tests": 1, 7, 8, 9 + route/meta behaviour).
// Zero dependencies. Spawns the real src/server.js on an ephemeral port with a
// throwaway FOLIO_DATA under /tmp, and tears it down in after().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const TOKEN = 'folio-test-token-0123456789abcdef';
const MAX = 65536; // FOLIO_MAX_BYTES for this run — keeps the 413 test cheap

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
  assert.ok(
    fs.existsSync(SERVER),
    `server not found at ${SERVER} — src/server.js must exist`,
  );
  const root = fs.mkdtempSync('/tmp/folio-test-');
  const data = path.join(root, 'docs');
  fs.mkdirSync(data);
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOLIO_ADDR: '127.0.0.1',
      FOLIO_PORT: String(port),
      FOLIO_DATA: data,
      FOLIO_TOKEN: TOKEN,
      FOLIO_MAX_BYTES: String(MAX),
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
    headers: {
      ...auth,
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
    },
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

const del = (s, id) => raw(s, 'DELETE', `/api/a/${id}`, { headers: auth });

async function listDocs(s) {
  const res = await raw(s, 'GET', '/api/a', { headers: auth });
  assert.equal(res.status, 200, `GET /api/a -> ${res.status}`);
  const parsed = JSON.parse(res.body);
  const docs = Array.isArray(parsed) ? parsed : parsed.docs;
  assert.ok(Array.isArray(docs), 'GET /api/a must return a JSON list of docs');
  return docs;
}

const readMeta = (s, id) => JSON.parse(fs.readFileSync(path.join(s.data, id, 'meta.json'), 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ok = (status, msg) => assert.ok(status === 200 || status === 201, `${msg} (got ${status})`);

let S;
before(async () => { S = await startServer(); });
after(async () => { await stopServer(S); S = null; });

/* ------------------------------------------------------------------ basics */

test('GET /healthz -> 200 ok, no auth required', async () => {
  const res = await raw(S, 'GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.trim(), 'ok');
});

test('unknown route -> 404 plain text with no stack trace', async () => {
  for (const target of ['/nope', '/api/nope', '/x/abc', '/p', '/api']) {
    const res = await raw(S, 'GET', target, { headers: auth });
    assert.equal(res.status, 404, `${target} -> ${res.status}`);
    assert.ok(!/\n\s+at\s/.test(res.body), `${target} leaked a stack trace: ${res.body}`);
    assert.ok(!/[A-Za-z]*Error:/.test(res.body), `${target} leaked an error name: ${res.body}`);
    assert.ok(res.body.length < 512, `${target} 404 body is suspiciously large`);
  }
});

/* --------------------------------------- SPEC test 1: publish -> fetch -> 200 */

test('1. publish a private doc and fetch it at /a/:id -> 200', async () => {
  const html = '<!doctype html><title>hello</title><p>private body</p>';
  const res = await publish(S, 'doc1', html, { title: 'Doc One', visibility: 'private' });
  ok(res.status, 'PUT /api/a/doc1');

  const got = await raw(S, 'GET', '/a/doc1');
  assert.equal(got.status, 200);
  assert.equal(got.body, html);
  assert.match(String(got.headers['content-type']), /text\/html/);

  // filesystem is the source of truth
  assert.equal(fs.readFileSync(path.join(S.data, 'doc1', 'index.html'), 'utf8'), html);
  const meta = readMeta(S, 'doc1');
  assert.equal(meta.id, 'doc1');
  assert.equal(meta.title, 'Doc One');
  assert.equal(meta.visibility, 'private');
  assert.equal(meta.bytes, Buffer.byteLength(html));
  assert.equal(meta.sha256, sha256(Buffer.from(html)));
  assert.ok(!Number.isNaN(Date.parse(meta.created)), 'meta.created must be a timestamp');
  assert.ok(!Number.isNaN(Date.parse(meta.updated)), 'meta.updated must be a timestamp');
  // no *.tmp litter left behind by the atomic write
  assert.deepEqual(
    fs.readdirSync(path.join(S.data, 'doc1')).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('1. publish a public doc and fetch it at /p/:id -> 200 with cacheable headers', async () => {
  const html = '<h1>public</h1>';
  ok((await publish(S, 'pub1', html, { visibility: 'public' })).status, 'PUT pub1');
  const got = await raw(S, 'GET', '/p/pub1');
  assert.equal(got.status, 200);
  assert.equal(got.body, html);
  assert.match(String(got.headers['cache-control']), /max-age=300/);
  assert.match(String(got.headers['cache-control']), /public/);
});

test('1. publish a shared doc and fetch it at /t/:id -> 200', async () => {
  const html = '<h1>shared</h1>';
  ok((await publish(S, 'shr1', html, { visibility: 'shared' })).status, 'PUT shr1');
  const got = await raw(S, 'GET', '/t/shr1');
  assert.equal(got.status, 200);
  assert.equal(got.body, html);
});

test('1. PUT replaces an existing doc in place', async () => {
  ok((await publish(S, 'rep1', '<p>v1</p>', { visibility: 'public' })).status, 'PUT v1');
  const first = readMeta(S, 'rep1');
  await sleep(5);
  ok((await publish(S, 'rep1', '<p>v2 longer</p>', { visibility: 'public' })).status, 'PUT v2');
  const got = await raw(S, 'GET', '/p/rep1');
  assert.equal(got.body, '<p>v2 longer</p>');
  const meta = readMeta(S, 'rep1');
  assert.equal(meta.bytes, Buffer.byteLength('<p>v2 longer</p>'));
  assert.equal(meta.created, first.created, 'created must be preserved across a replace');
  assert.equal((await listDocs(S)).filter((d) => d.id === 'rep1').length, 1);
});

test('GET a doc that does not exist -> 404 at every prefix', async () => {
  for (const p of ['p', 't', 'a']) {
    const res = await raw(S, 'GET', `/${p}/nosuchdoc`);
    assert.equal(res.status, 404, `/${p}/nosuchdoc -> ${res.status}`);
  }
});

/* ------------------------------------------ PATCH / metadata / listing (8) */

test('PATCH updates title, visibility and sandbox and moves the doc prefix', async () => {
  ok((await publish(S, 'mv1', '<p>move me</p>', { visibility: 'private' })).status, 'PUT mv1');
  assert.equal((await raw(S, 'GET', '/a/mv1')).status, 200);

  const res = await patch(S, 'mv1', { title: 'Moved', visibility: 'public' });
  ok(res.status, 'PATCH mv1');

  assert.equal((await raw(S, 'GET', '/p/mv1')).status, 200, 'now public at /p/');
  assert.equal((await raw(S, 'GET', '/a/mv1')).status, 404, 'no longer private at /a/');
  const meta = readMeta(S, 'mv1');
  assert.equal(meta.visibility, 'public');
  assert.equal(meta.title, 'Moved');

  ok((await patch(S, 'mv1', { shared_with: ['a@b.com'], sandbox: false })).status, 'PATCH mv1 #2');
  const meta2 = readMeta(S, 'mv1');
  assert.deepEqual(meta2.shared_with, ['a@b.com']);
  assert.equal(meta2.sandbox, false);
  assert.equal(meta2.title, 'Moved', 'PATCH must not clobber untouched fields');
});

test('PATCH on a missing doc -> 404', async () => {
  assert.equal((await patch(S, 'ghostdoc', { title: 'x' })).status, 404);
});

test('GET /api/a lists docs with their metadata', async () => {
  ok((await publish(S, 'listed1', '<p>a</p>', { title: 'L1', visibility: 'public' })).status, 'PUT');
  const docs = await listDocs(S);
  const doc = docs.find((d) => d.id === 'listed1');
  assert.ok(doc, 'published doc must appear in /api/a');
  assert.equal(doc.title, 'L1');
  assert.equal(doc.visibility, 'public');
  assert.equal(doc.bytes, Buffer.byteLength('<p>a</p>'));
  assert.ok(!('html' in doc), 'the list is metadata only');
});

/* ------------------------------------- SPEC test 8: delete + list reflects it */

test('8. DELETE removes the doc directory and the listing reflects it', async () => {
  ok((await publish(S, 'gone1', '<p>bye</p>', { visibility: 'public' })).status, 'PUT gone1');
  const dir = path.join(S.data, 'gone1');
  assert.ok(fs.existsSync(dir));
  assert.ok((await listDocs(S)).some((d) => d.id === 'gone1'));

  const res = await del(S, 'gone1');
  assert.ok([200, 202, 204].includes(res.status), `DELETE -> ${res.status}`);

  assert.equal(fs.existsSync(dir), false, 'doc directory must be gone from disk');
  assert.equal((await raw(S, 'GET', '/p/gone1')).status, 404);
  assert.equal((await listDocs(S)).some((d) => d.id === 'gone1'), false);
});

test('8. DELETE of a missing doc -> 404 and other docs survive', async () => {
  ok((await publish(S, 'keep1', '<p>keep</p>', { visibility: 'public' })).status, 'PUT keep1');
  assert.equal((await del(S, 'neverexisted')).status, 404);
  assert.equal((await raw(S, 'GET', '/p/keep1')).status, 200);
  assert.equal((await del(S, 'keep1')).status < 400, true);
  assert.equal((await del(S, 'keep1')).status, 404, 'second delete -> 404');
});

/* --------------------------------------------- SPEC test 7: oversize -> 413 */

test('7. body larger than FOLIO_MAX_BYTES -> 413 and nothing is stored', async () => {
  const big = 'x'.repeat(MAX + 1);
  const res = await publish(S, 'big1', big);
  assert.equal(res.status, 413, `${MAX + 1} bytes must be rejected with 413`);
  assert.equal(fs.existsSync(path.join(S.data, 'big1')), false, 'oversize doc must not be stored');
  assert.equal((await raw(S, 'GET', '/a/big1')).status, 404);
});

test('7. a much larger body -> 413', async () => {
  const res = await publish(S, 'big2', 'y'.repeat(MAX * 4));
  assert.equal(res.status, 413);
  assert.equal(fs.existsSync(path.join(S.data, 'big2')), false);
});

test('7. oversize chunked body (no Content-Length) -> 413', async () => {
  const chunk = Buffer.alloc(16 * 1024, 0x7a);
  const res = await raw(S, 'PUT', '/api/a/big3', {
    headers: { ...auth, 'content-type': 'text/html' },
    chunks: [chunk, chunk, chunk, chunk, chunk, chunk], // 96 KiB > MAX
  });
  assert.equal(res.status, 413, 'the limit must not be bypassable with chunked encoding');
  assert.equal(fs.existsSync(path.join(S.data, 'big3')), false);
});

test('7. a body at the limit is accepted and the server still works after a 413', async () => {
  const atLimit = 'z'.repeat(MAX);
  const res = await publish(S, 'atlimit', atLimit, { visibility: 'public' });
  ok(res.status, `${MAX} bytes (exactly the limit) must be accepted`);
  const got = await raw(S, 'GET', '/p/atlimit');
  assert.equal(got.status, 200);
  assert.equal(got.body.length, MAX);
});

/* ------------------------------------- SPEC test 9: index page escapes HTML */

test('9. index page escapes <script> and other markup in doc titles', async () => {
  const xss = "<script>alert('xss')</script>";
  const img = '<img src=x onerror=alert(1)>';
  ok((await publish(S, 'xss1', '<p>x</p>', { title: xss, visibility: 'public' })).status, 'PUT xss1');
  ok((await publish(S, 'xss2', '<p>x</p>', { title: img, visibility: 'private' })).status, 'PUT xss2');

  const res = await raw(S, 'GET', '/');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);

  assert.ok(!res.body.includes(xss), 'raw <script> from a title must never reach the index');
  assert.ok(!res.body.includes('<script>alert'), 'script payload must be escaped');
  assert.ok(!res.body.includes(img), 'raw <img onerror> from a title must be escaped');
  assert.ok(!res.body.includes('<img src=x'), 'img payload must be escaped');
  assert.match(res.body, /&(?:lt|#0*60|#x0*3c);\s*script/i, 'the title should appear HTML-escaped');
  assert.ok(res.body.includes('xss1') && res.body.includes('xss2'), 'index lists the docs');
});

test('9. index page carries the strict CSP and no external requests', async () => {
  const res = await raw(S, 'GET', '/');
  const csp = String(res.headers['content-security-policy'] || '');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.ok(!/sandbox/.test(csp), 'the index itself is not sandboxed');
  // no external subresources: nothing loaded over http(s) or protocol-relative
  assert.ok(!/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(res.body),
    'index must not load external resources');
  assert.ok(!/@import/i.test(res.body), 'index must not @import a stylesheet');
});
