#!/usr/bin/env node
// folio — HTTP origin.
//
// Routes (see SPEC.md):
//   GET    /                      index page
//   GET    /healthz               liveness, unauthenticated, unlogged
//   GET    /p/:id /t/:id /a/:id   document (prefix MUST match stored visibility)
//   GET    /p/:id/* ...           asset inside the document directory
//   GET    /api/a                 list metadata
//   PUT    /api/a/:id             publish / replace (raw HTML body)
//   PATCH  /api/a/:id             update metadata (JSON body)
//   DELETE /api/a/:id             remove document
//
// Clients never see stack traces; errors go to stderr as one-line JSON.

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AccessVerifier, AuthError, checkBearer, isLoopback, TEAM_RE } from './auth.js';
import { renderIndex } from './render.js';
import {
  PREFIX_TO_VISIBILITY,
  Store,
  StoreError,
  VISIBILITIES,
  idProblem,
  isVisibility,
} from './store.js';

const NUL = String.fromCharCode(0);
const DEFAULT_MAX_BYTES = 10485760;
const MAX_JSON_BYTES = 65536;
const SHUTDOWN_GRACE_MS = 10000;

const SANDBOX_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals; worker-src 'none'";
const NO_SANDBOX_CSP = "worker-src 'none'";
const INDEX_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const API_CSP = "default-src 'none'";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- logging --

function log(level, fields) {
  let line;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, ...fields });
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), level, msg: 'unserialisable log record' });
  }
  process.stderr.write(line + '\n');
}

// ----------------------------------------------------------------- config --

export function loadConfig(env = process.env) {
  const errors = [];

  const addr = typeof env.FOLIO_ADDR === 'string' && env.FOLIO_ADDR.length > 0 ? env.FOLIO_ADDR : '127.0.0.1';

  let port = 8082;
  if (env.FOLIO_PORT !== undefined && env.FOLIO_PORT !== '') {
    port = Number(env.FOLIO_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      errors.push(`FOLIO_PORT must be an integer between 0 and 65535 (got ${JSON.stringify(env.FOLIO_PORT)})`);
      port = 8082;
    }
  }

  const data = path.resolve(
    typeof env.FOLIO_DATA === 'string' && env.FOLIO_DATA.length > 0 ? env.FOLIO_DATA : '/srv/folio/docs',
  );

  const token = typeof env.FOLIO_TOKEN === 'string' ? env.FOLIO_TOKEN : '';
  if (token.length === 0) {
    errors.push('FOLIO_TOKEN is required (bearer secret for /api/*)');
  } else if (token.length < 16) {
    errors.push('FOLIO_TOKEN must be at least 16 characters');
  }

  let maxBytes = DEFAULT_MAX_BYTES;
  if (env.FOLIO_MAX_BYTES !== undefined && env.FOLIO_MAX_BYTES !== '') {
    maxBytes = Number(env.FOLIO_MAX_BYTES);
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      errors.push(`FOLIO_MAX_BYTES must be a positive integer (got ${JSON.stringify(env.FOLIO_MAX_BYTES)})`);
      maxBytes = DEFAULT_MAX_BYTES;
    }
  }

  let accessTeam = null;
  if (typeof env.FOLIO_ACCESS_TEAM === 'string' && env.FOLIO_ACCESS_TEAM.length > 0) {
    if (!TEAM_RE.test(env.FOLIO_ACCESS_TEAM)) {
      errors.push('FOLIO_ACCESS_TEAM must be a lowercase Cloudflare team name');
    } else {
      accessTeam = env.FOLIO_ACCESS_TEAM;
    }
  }
  const accessAud = typeof env.FOLIO_ACCESS_AUD === 'string' && env.FOLIO_ACCESS_AUD.length > 0
    ? env.FOLIO_ACCESS_AUD
    : null;

  return { config: { addr, port, data, token, maxBytes, accessTeam, accessAud }, errors };
}

export async function checkDataDir(dir) {
  const errors = [];
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    errors.push(`FOLIO_DATA is not accessible: ${dir}`);
    return errors;
  }
  if (!stat.isDirectory()) {
    errors.push(`FOLIO_DATA is not a directory: ${dir}`);
    return errors;
  }
  try {
    await fs.access(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    errors.push(`FOLIO_DATA is not readable/writable: ${dir}`);
  }
  return errors;
}

// ---------------------------------------------------------------- helpers --

function baseHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  };
}

function sendText(res, status, text, extra = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(String(text).endsWith('\n') ? String(text) : `${text}\n`, 'utf8');
  res.writeHead(status, baseHeaders({
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'content-security-policy': API_CSP,
    ...extra,
  }));
  if (res.req?.method === 'HEAD') return void res.end();
  res.end(body);
}

function sendJson(res, status, value, extra = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value) + '\n', 'utf8');
  res.writeHead(status, baseHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'content-security-policy': API_CSP,
    ...extra,
  }));
  if (res.req?.method === 'HEAD') return void res.end();
  res.end(body);
}

const sendError = (res, status, code, message) =>
  sendJsonOrText(res, status, code, message);

function sendJsonOrText(res, status, code, message) {
  // /api/* callers get JSON, browsers get plain text. Never a stack trace.
  const wantsJson = typeof res.req?.url === 'string' && res.req.url.startsWith('/api/');
  if (wantsJson) return sendJson(res, status, { error: code, message });
  return sendText(res, status, message || code);
}

/**
 * Split a request path into decoded segments.
 *
 * SECURITY CRITICAL: this deliberately does NOT use the WHATWG URL parser for
 * the path, because that silently collapses "." / ".." segments — turning a
 * traversal attempt into an innocent-looking path. We parse the raw request
 * target and flag every dot segment, encoded or not.
 *
 * `badIndex` is the first segment that is malformed or a traversal attempt.
 */
export function parsePath(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
  let target = rawUrl;

  // absolute-form request target (RFC 9112 3.2.2), e.g. "http://host/path"
  if (!target.startsWith('/')) {
    const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*(\/[^\s]*)?$/.exec(target);
    if (!m) return null;
    target = m[1] || '/';
  }

  const hash = target.indexOf('#');
  if (hash >= 0) target = target.slice(0, hash);
  const mark = target.indexOf('?');
  const pathname = mark >= 0 ? target.slice(0, mark) : target;
  const query = new URLSearchParams(mark >= 0 ? target.slice(mark + 1) : '');

  const segments = [];
  let badIndex = -1;
  const flag = () => { if (badIndex < 0) badIndex = segments.length; };
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      flag();
      segments.push(raw);
      continue;
    }
    if (
      raw === '.' || raw === '..'
      || decoded === '.' || decoded === '..'
      || decoded.includes('/') || decoded.includes('\\') || decoded.includes(NUL)
    ) {
      flag();
    }
    segments.push(decoded);
  }
  return { segments, badIndex, query };
}

/**
 * SECURITY CRITICAL — the single most important check in this service.
 *
 * A document is served at exactly one prefix, determined by the visibility
 * stored on disk. Anything else (unknown prefix, missing/garbled metadata,
 * mismatched visibility) is a hard no. Defaults to `false` for every input
 * that is not an exact, expected match.
 */
export function visibilityMatchesPrefix(meta, prefix) {
  if (typeof prefix !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(PREFIX_TO_VISIBILITY, prefix)) return false;
  const required = PREFIX_TO_VISIBILITY[prefix];
  if (typeof required !== 'string' || !VISIBILITIES.includes(required)) return false;
  if (!meta || typeof meta !== 'object') return false;
  const actual = meta.visibility;
  if (typeof actual !== 'string' || !VISIBILITIES.includes(actual)) return false;
  return actual === required;
}

function docResponseHeaders(meta) {
  return baseHeaders({
    'content-security-policy': meta.sandbox === false ? NO_SANDBOX_CSP : SANDBOX_CSP,
    'cache-control': meta.visibility === 'public' ? 'public, max-age=300' : 'no-store',
  });
}

/**
 * Read a request body, refusing oversize input *while* it streams: nothing
 * beyond the limit is ever buffered.
 *
 * Once over the limit the remainder is drained and discarded (bounded by
 * `drainMs` / `drainBytes`) rather than the socket being reset immediately,
 * so the client reliably receives the 413 instead of a connection error.
 */
export function readBody(req, maxBytes, { drainMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let oversize = Number.isFinite(declared) && declared > maxBytes;
    const drainBytes = Math.max(maxBytes, 1048576);
    const chunks = [];
    let size = 0;
    let drained = 0;
    let settled = false;
    let timer = null;

    const tooLarge = () => new HttpError(413, 'payload_too_large', 'request body too large');
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      if (err) reject(err);
      else resolve(value);
    };
    const startDrain = () => {
      if (timer) return;
      timer = setTimeout(() => {
        finish(tooLarge());
        req.destroy();
      }, drainMs);
      if (typeof timer.unref === 'function') timer.unref();
    };
    const onData = (chunk) => {
      if (oversize) {
        drained += chunk.length;
        if (drained > drainBytes) {
          finish(tooLarge());
          req.destroy();
        }
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        oversize = true;
        chunks.length = 0;
        size = 0;
        startDrain();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => (oversize ? finish(tooLarge()) : finish(null, Buffer.concat(chunks, size)));
    const onError = () => finish(new HttpError(400, 'bad_request', 'request stream error'));
    const onAborted = () => finish(oversize ? tooLarge() : new HttpError(400, 'bad_request', 'client aborted request'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    if (oversize) startDrain();
  });
}

function parseBoolean(value) {
  if (value === undefined || value === null) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return null; // explicit "invalid"
}

/** Metadata options for PUT: query string plus an optional X-Folio-Meta JSON header. */
function putOptions(query, headers) {
  const opts = {};
  const header = headers['x-folio-meta'];
  if (typeof header === 'string' && header.trim().length > 0) {
    let parsed;
    try {
      parsed = JSON.parse(header);
    } catch {
      throw new HttpError(400, 'bad_request', 'X-Folio-Meta must be JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'bad_request', 'X-Folio-Meta must be a JSON object');
    }
    Object.assign(opts, applyMetaChanges(parsed));
  }

  const title = query.get('title');
  if (title !== null) opts.title = title;

  const visibility = query.get('visibility');
  if (visibility !== null) {
    if (!isVisibility(visibility)) {
      throw new HttpError(400, 'bad_request', `visibility must be one of ${VISIBILITIES.join(', ')}`);
    }
    opts.visibility = visibility;
  }

  const sandbox = query.get('sandbox');
  if (sandbox !== null) {
    const parsed = parseBoolean(sandbox);
    if (parsed === null) throw new HttpError(400, 'bad_request', 'sandbox must be true or false');
    opts.sandbox = parsed;
  }
  return opts;
}

/** Validate a JSON metadata patch. Throws HttpError(400) on anything odd. */
function applyMetaChanges(body) {
  const changes = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw new HttpError(400, 'bad_request', 'title must be a string');
    changes.title = body.title;
  }
  if (body.visibility !== undefined) {
    if (!isVisibility(body.visibility)) {
      throw new HttpError(400, 'bad_request', `visibility must be one of ${VISIBILITIES.join(', ')}`);
    }
    changes.visibility = body.visibility;
  }
  if (body.shared_with !== undefined) {
    if (!Array.isArray(body.shared_with) || body.shared_with.some((v) => typeof v !== 'string')) {
      throw new HttpError(400, 'bad_request', 'shared_with must be an array of strings');
    }
    changes.shared_with = body.shared_with;
  }
  if (body.sandbox !== undefined) {
    if (typeof body.sandbox !== 'boolean') throw new HttpError(400, 'bad_request', 'sandbox must be a boolean');
    changes.sandbox = body.sandbox;
  }
  return changes;
}

// ------------------------------------------------------------ the handler --

export function createApp(config, deps = {}) {
  const store = deps.store || new Store(config.data);
  const accessVerifier = deps.accessVerifier !== undefined
    ? deps.accessVerifier
    : (config.accessTeam ? new AccessVerifier({ team: config.accessTeam, aud: config.accessAud }) : null);
  const state = { shuttingDown: false, inFlight: 0 };

  async function requireAccess(req) {
    if (!accessVerifier) return;
    await accessVerifier.check(req); // throws AuthError
  }

  function requireBearer(req) {
    if (!checkBearer(req.headers.authorization, config.token)) {
      throw new HttpError(401, 'unauthorized', 'valid bearer token required');
    }
  }

  function sendFile(req, res, file, headers) {
    const head = {
      ...headers,
      'content-type': file.type,
      'content-length': file.size,
      'last-modified': file.mtime instanceof Date ? file.mtime.toUTCString() : new Date(0).toUTCString(),
    };
    res.writeHead(200, head);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file.path);
    stream.on('error', (err) => {
      log('error', { msg: 'stream error', code: err?.code || 'unknown' });
      res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  // ---- GET /p/:id, /t/:id, /a/:id (+ assets)
  async function handleDoc(req, res, prefix, segments, badIndex) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    // Any traversal or malformed segment anywhere in a read path: 404, never a hint.
    if (badIndex >= 0) throw new HttpError(404, 'not_found', 'not found');

    const id = segments[1];
    const problem = idProblem(id);
    if (problem === 'traversal') throw new HttpError(404, 'not_found', 'not found');
    if (problem === 'invalid') throw new HttpError(400, 'bad_id', 'invalid document id');

    const meta = await store.readMeta(id);
    if (!meta) throw new HttpError(404, 'not_found', 'not found');

    // *** SECURITY CRITICAL *** prefix must match the stored visibility.
    if (!visibilityMatchesPrefix(meta, prefix)) throw new HttpError(404, 'not_found', 'not found');

    const rest = segments.slice(2);
    const file = await store.statForServe(id, rest.length > 0 ? rest : null);

    // Re-check immediately before anything is written to the socket. Cheap,
    // and it closes any window between the lookup and the response.
    if (!visibilityMatchesPrefix(meta, prefix)) throw new HttpError(404, 'not_found', 'not found');

    sendFile(req, res, file, docResponseHeaders(meta));
  }

  // ---- /api/a and /api/a/:id
  async function handleApi(req, res, segments, badIndex, query) {
    await requireAccess(req);
    requireBearer(req);

    if (segments.length === 2) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      }
      return sendJson(res, 200, await store.list());
    }
    if (segments.length > 3) throw new HttpError(404, 'not_found', 'not found');

    if (badIndex >= 0) throw new HttpError(400, 'bad_id', 'invalid document id');
    const id = segments[2];
    if (idProblem(id) !== null) throw new HttpError(400, 'bad_id', 'invalid document id');

    switch (req.method) {
      case 'PUT': {
        const opts = putOptions(query, req.headers);
        const body = await readBody(req, config.maxBytes);
        if (body.length === 0) throw new HttpError(400, 'bad_request', 'empty body');
        const { meta, created } = await store.put(id, body, opts);
        return sendJson(res, 200, { ok: true, created, ...meta, url: `/${prefixFor(meta.visibility)}/${meta.id}` });
      }
      case 'PATCH': {
        const raw = await readBody(req, Math.min(config.maxBytes, MAX_JSON_BYTES));
        let parsed;
        try {
          parsed = JSON.parse(raw.toString('utf8') || '{}');
        } catch {
          throw new HttpError(400, 'bad_request', 'body must be JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new HttpError(400, 'bad_request', 'body must be a JSON object');
        }
        const meta = await store.patch(id, applyMetaChanges(parsed));
        if (!meta) throw new HttpError(404, 'not_found', 'not found');
        return sendJson(res, 200, { ok: true, ...meta, url: `/${prefixFor(meta.visibility)}/${meta.id}` });
      }
      case 'DELETE': {
        const existed = await store.exists(id);
        const removed = await store.remove(id);
        if (!existed && !removed) throw new HttpError(404, 'not_found', 'not found');
        return sendJson(res, 200, { ok: true, id, deleted: true });
      }
      case 'GET':
      case 'HEAD': {
        const meta = await store.readMeta(id);
        if (!meta) throw new HttpError(404, 'not_found', 'not found');
        return sendJson(res, 200, { ...meta, url: `/${prefixFor(meta.visibility)}/${meta.id}` });
      }
      default:
        throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
  }

  async function handleIndex(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    await requireAccess(req);
    const docs = await store.list();
    const body = Buffer.from(renderIndex(docs), 'utf8');
    res.writeHead(200, baseHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'content-security-policy': INDEX_CSP,
    }));
    if (req.method === 'HEAD') return void res.end();
    res.end(body);
  }

  async function route(req, res) {
    const parsed = parsePath(req.url || '/');
    if (!parsed) throw new HttpError(400, 'bad_request', 'malformed request path');
    const { segments, badIndex, query } = parsed;

    if (segments.length === 1 && segments[0] === 'healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      }
      return sendText(res, 200, 'ok');
    }
    if (segments.length === 0) return handleIndex(req, res);
    if (segments[0] === 'api') {
      if (segments[1] !== 'a' || segments.length < 2) throw new HttpError(404, 'not_found', 'not found');
      return handleApi(req, res, segments, badIndex, query);
    }
    if (segments.length >= 2 && Object.prototype.hasOwnProperty.call(PREFIX_TO_VISIBILITY, segments[0])) {
      return handleDoc(req, res, segments[0], segments, badIndex);
    }
    throw new HttpError(404, 'not_found', 'not found');
  }

  async function handler(req, res) {
    const isHealth = typeof req.url === 'string' && (req.url === '/healthz' || req.url.startsWith('/healthz?'));
    state.inFlight += 1;
    res.on('close', () => { state.inFlight -= 1; });

    if (state.shuttingDown) {
      res.setHeader('connection', 'close');
      return sendText(res, 503, 'shutting down');
    }

    try {
      await route(req, res);
    } catch (err) {
      handleFailure(req, res, err, isHealth);
    }
  }

  function handleFailure(req, res, err, isHealth) {
    let status = 500;
    let code = 'internal_error';
    let message = 'internal error';
    let extra = {};

    if (err instanceof HttpError) {
      status = err.status;
      code = err.code;
      message = err.message;
    } else if (err instanceof StoreError) {
      status = err.status || 500;
      code = err.code;
      message = status === 500 ? 'internal error' : err.message;
    } else if (err instanceof AuthError) {
      status = err.status || 403;
      code = err.code;
      message = err.message;
    }

    if (status === 401) extra['www-authenticate'] = 'Bearer realm="folio"';
    if (status === 405) extra.allow = 'GET, HEAD, PUT, PATCH, DELETE';
    const hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
    const unconsumed = hasBody && req.readableEnded === false;
    if (unconsumed) extra.connection = 'close';

    if (status >= 500) {
      log('error', {
        msg: 'request failed',
        method: req.method,
        path: safePath(req.url),
        status,
        code,
        err: err?.message ? String(err.message).slice(0, 300) : undefined,
        stack: typeof err?.stack === 'string' ? err.stack.slice(0, 600) : undefined,
      });
    } else if (!isHealth && (status === 401 || status === 403)) {
      log('warn', { msg: 'request denied', method: req.method, path: safePath(req.url), status, code });
    }

    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    if (Object.keys(extra).length > 0) {
      for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    }
    sendError(res, status, code, message);
    if (unconsumed) {
      // Stop the client streaming the rest of a body we will not read.
      res.on('finish', () => req.destroy());
    }
  }

  handler.state = state;
  handler.store = store;
  return handler;
}

function prefixFor(visibility) {
  return visibility === 'public' ? 'p' : visibility === 'shared' ? 't' : 'a';
}

/** Path for logs: no query string (it can carry titles), length-capped. */
function safePath(url) {
  if (typeof url !== 'string') return '';
  const q = url.indexOf('?');
  return (q >= 0 ? url.slice(0, q) : url).slice(0, 200);
}

// ------------------------------------------------------------ server glue --

export function createServer(config, deps = {}) {
  const handler = createApp(config, deps);
  const server = http.createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    handler(req, res);
  });
  server.headersTimeout = 20000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  server.folio = { handler, store: handler.store };
  return server;
}

export function startServer(config, deps = {}) {
  const server = createServer(config, deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.addr, () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        server,
        address,
        port: typeof address === 'object' && address ? address.port : config.port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** SIGTERM: stop accepting, let in-flight requests finish, exit 0. */
export function installShutdown(server, handler) {
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (handler?.state) handler.state.shuttingDown = true;
    log('info', { msg: 'shutting down', signal });
    server.close(() => {
      log('info', { msg: 'stopped' });
      process.exit(0);
    });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    const timer = setTimeout(() => {
      log('warn', { msg: 'shutdown grace expired, closing connections' });
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  return stop;
}

export async function main(env = process.env) {
  const { config, errors } = loadConfig(env);
  errors.push(...(await checkDataDir(config.data)));
  if (errors.length > 0) {
    for (const message of errors) process.stderr.write(`folio: fatal: ${message}\n`);
    process.stderr.write('folio: refusing to start\n');
    process.exit(1);
  }

  process.on('uncaughtException', (err) => {
    log('error', { msg: 'uncaught exception', err: String(err?.message || err).slice(0, 300) });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log('error', { msg: 'unhandled rejection', err: String(reason?.message || reason).slice(0, 300) });
  });

  const { server, port } = await startServer(config);
  installShutdown(server, server.folio.handler);
  process.stdout.write(JSON.stringify({
    level: 'info',
    msg: 'listening',
    addr: config.addr,
    port,
    data: config.data,
    access: config.accessTeam ? 'cloudflare' : 'none',
  }) + '\n');
  return { server, port, config };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`folio: fatal: ${String(err?.message || err)}\n`);
    process.exit(1);
  });
}

export { HttpError };
export default createServer;
