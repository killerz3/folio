// folio — authentication.
//
//  * Bearer token for /api/* (constant-time comparison).
//  * Optional Cloudflare Access JWT verification (RS256) with a cached JWKS.
//
// Nothing here ever logs or returns a token value.

import { createHash, createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';

export const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour, per spec
const JWKS_FETCH_TIMEOUT_MS = 5000;
const JWKS_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const MAX_JWT_BYTES = 8192;
const MAX_JWKS_KEYS = 32;
const CLOCK_SKEW_S = 60;

/** Cloudflare team names appear in a URL we fetch: keep them boring. */
export const TEAM_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class AuthError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Constant-time bearer check.
 * Both sides are SHA-256 hashed first so the buffers are always the same
 * length and no length information leaks through the comparison.
 */
export function checkBearer(authorizationHeader, expectedToken) {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) return false;
  if (typeof authorizationHeader !== 'string') return false;
  const header = authorizationHeader.trim();
  const space = header.indexOf(' ');
  if (space < 0) return false;
  if (header.slice(0, space).toLowerCase() !== 'bearer') return false;
  const presented = header.slice(space + 1).trim();
  if (presented.length === 0 || presented.length > 4096) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expectedToken, 'utf8').digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Loopback callers are the local CLI; Cloudflare Access does not front them. */
export function isLoopback(req) {
  const addr = req?.socket?.remoteAddress;
  if (typeof addr !== 'string' || addr.length === 0) return false;
  const bare = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return bare === '127.0.0.1' || bare === '::1' || bare.startsWith('127.');
}

function b64urlToBuffer(part) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]*$/.test(part)) {
    throw new AuthError('bad_jwt', 403, 'malformed token');
  }
  return Buffer.from(part, 'base64url');
}

function decodeJson(part) {
  let parsed;
  try {
    parsed = JSON.parse(b64urlToBuffer(part).toString('utf8'));
  } catch {
    throw new AuthError('bad_jwt', 403, 'malformed token');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuthError('bad_jwt', 403, 'malformed token');
  }
  return parsed;
}

/**
 * Verifies Cf-Access-Jwt-Assertion headers against the team's JWKS.
 * Only RS256 is accepted; `alg: none` and HMAC confusion are rejected outright.
 */
export class AccessVerifier {
  constructor({ team, aud = null, ttlMs = JWKS_TTL_MS, fetchImpl, now } = {}) {
    if (typeof team !== 'string' || !TEAM_RE.test(team)) {
      throw new TypeError('AccessVerifier requires a valid team name');
    }
    this.team = team;
    // Accept one AUD tag or a comma-separated list: each Cloudflare Access
    // application has its own AUD, and folio sits behind several of them.
    this.aud = (() => {
      const raw = Array.isArray(aud) ? aud : typeof aud === 'string' ? aud.split(',') : [];
      const tags = raw.map((a) => String(a).trim()).filter((a) => a.length > 0);
      return tags.length > 0 ? tags : null;
    })();
    this.ttlMs = ttlMs;
    this.issuer = `https://${team}.cloudflareaccess.com`;
    this.certsUrl = `${this.issuer}/cdn-cgi/access/certs`;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.now = now || (() => Date.now());
    this._keys = null;        // Map<kid, KeyObject>
    this._expiresAt = 0;
    this._fetchedAt = 0;
    this._inflight = null;
  }

  async _fetchKeys() {
    if (typeof this.fetchImpl !== 'function') {
      throw new AuthError('jwks_unavailable', 503, 'no fetch implementation');
    }
    let res;
    try {
      res = await this.fetchImpl(this.certsUrl, {
        signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new AuthError('jwks_unavailable', 503, 'could not fetch access certs');
    }
    if (!res || !res.ok) {
      throw new AuthError('jwks_unavailable', 503, 'could not fetch access certs');
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new AuthError('jwks_unavailable', 503, 'malformed access certs');
    }
    const keys = new Map();
    const list = Array.isArray(body?.keys) ? body.keys.slice(0, MAX_JWKS_KEYS) : [];
    for (const jwk of list) {
      if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
      if (jwk.alg && jwk.alg !== 'RS256') continue;
      try {
        const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
        keys.set(typeof jwk.kid === 'string' ? jwk.kid : `k${keys.size}`, key);
      } catch {
        /* skip unusable key */
      }
    }
    if (keys.size === 0) {
      throw new AuthError('jwks_unavailable', 503, 'no usable access certs');
    }
    this._keys = keys;
    this._fetchedAt = this.now();
    this._expiresAt = this._fetchedAt + this.ttlMs;
    return keys;
  }

  async keys({ force = false } = {}) {
    const now = this.now();
    if (!force && this._keys && now < this._expiresAt) return this._keys;
    if (force && this._keys && now - this._fetchedAt < JWKS_REFRESH_MIN_INTERVAL_MS) {
      return this._keys; // do not let unknown kids become a fetch amplifier
    }
    if (!this._inflight) {
      this._inflight = this._fetchKeys().finally(() => {
        this._inflight = null;
      });
    }
    return this._inflight;
  }

  /** Returns the verified payload, or throws AuthError. */
  async verify(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_JWT_BYTES) {
      throw new AuthError('bad_jwt', 403, 'missing or oversized token');
    }
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('bad_jwt', 403, 'malformed token');
    const [rawHeader, rawPayload, rawSignature] = parts;

    const header = decodeJson(rawHeader);
    if (header.alg !== 'RS256') throw new AuthError('bad_jwt', 403, 'unsupported algorithm');

    const signature = b64urlToBuffer(rawSignature);
    if (signature.length === 0) throw new AuthError('bad_jwt', 403, 'malformed token');
    const signed = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');

    let keys = await this.keys();
    let key = typeof header.kid === 'string' ? keys.get(header.kid) : undefined;
    if (!key && typeof header.kid === 'string') {
      keys = await this.keys({ force: true });
      key = keys.get(header.kid);
    }
    const candidates = key ? [key] : [...keys.values()];

    let ok = false;
    for (const candidate of candidates) {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(signed);
      verifier.end();
      try {
        if (verifier.verify(candidate, signature)) {
          ok = true;
          break;
        }
      } catch {
        /* try next key */
      }
    }
    if (!ok) throw new AuthError('bad_jwt', 403, 'signature verification failed');

    const payload = decodeJson(rawPayload);
    const nowS = Math.floor(this.now() / 1000);

    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      throw new AuthError('bad_jwt', 403, 'token has no expiry');
    }
    if (nowS > payload.exp + CLOCK_SKEW_S) throw new AuthError('bad_jwt', 403, 'token expired');
    if (typeof payload.nbf === 'number' && nowS + CLOCK_SKEW_S < payload.nbf) {
      throw new AuthError('bad_jwt', 403, 'token not yet valid');
    }
    if (typeof payload.iat === 'number' && nowS + CLOCK_SKEW_S < payload.iat) {
      throw new AuthError('bad_jwt', 403, 'token issued in the future');
    }
    if (typeof payload.iss === 'string' && payload.iss !== this.issuer) {
      throw new AuthError('bad_jwt', 403, 'unexpected issuer');
    }
    if (this.aud) {
      const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!auds.some((a) => typeof a === 'string' && this.aud.includes(a))) {
        throw new AuthError('bad_jwt', 403, 'unexpected audience');
      }
    }
    return payload;
  }

  /**
   * Request-level gate. Loopback requests (the local CLI) are exempt.
   * Returns { ok: true, identity } or throws AuthError.
   */
  async check(req) {
    if (isLoopback(req)) return { ok: true, identity: 'loopback', exempt: true };
    const token = req?.headers?.['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length === 0) {
      throw new AuthError('missing_access_jwt', 403, 'missing Cf-Access-Jwt-Assertion');
    }
    const payload = await this.verify(token);
    const identity = typeof payload.email === 'string' ? payload.email : (typeof payload.sub === 'string' ? payload.sub : null);
    return { ok: true, identity, exempt: false };
  }
}

export default { checkBearer, isLoopback, AccessVerifier, AuthError };
