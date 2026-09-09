// folio — filesystem document store.
//
// The filesystem is the source of truth:
//   $FOLIO_DATA/<id>/index.html
//   $FOLIO_DATA/<id>/meta.json
//   $FOLIO_DATA/<id>/assets/...
//
// SECURITY: every path handed to the filesystem is built from validated
// segments, resolved, and then verified to stay inside the document
// directory (and the document directory inside the doc root). Symlinks are
// defeated by re-checking the realpath before any read.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** SECURITY CRITICAL: the only ids we ever touch the filesystem with. */
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const VISIBILITIES = Object.freeze(['public', 'shared', 'private']);
export const DEFAULT_VISIBILITY = 'private';

/** URL prefix -> the visibility a document MUST have to be served there. */
export const PREFIX_TO_VISIBILITY = Object.freeze({
  p: 'public',
  t: 'shared',
  a: 'private',
});

/** Visibility -> the single URL prefix it is served at. */
export const VISIBILITY_TO_PREFIX = Object.freeze({
  public: 'p',
  shared: 't',
  private: 'a',
});

export const MAX_TITLE_LENGTH = 300;
export const MAX_SHARED_WITH = 128;
export const MAX_SHARED_WITH_LENGTH = 320;

const CONTROL_CHARS = new RegExp('[\\x00-\\x1F\\x7F]', 'g');
const NUL = String.fromCharCode(0);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class StoreError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

const notFound = (msg = 'not found') => new StoreError('not_found', 404, msg);

/**
 * Classify an id. Returns null when valid, otherwise:
 *  - 'traversal' : the id tries to leave its directory (separators, NUL, . / ..)
 *  - 'invalid'   : merely malformed (uppercase, too long, bad characters)
 * Callers map these to different status codes.
 */
export function idProblem(id) {
  if (typeof id !== 'string' || id.length === 0) return 'invalid';
  if (id.includes('/') || id.includes('\\') || id.includes(NUL)) return 'traversal';
  if (id === '.' || id === '..') return 'traversal';
  if (!ID_RE.test(id)) return 'invalid';
  return null;
}

export function isValidId(id) {
  return idProblem(id) === null;
}

export function isVisibility(v) {
  return typeof v === 'string' && VISIBILITIES.includes(v);
}

/**
 * SECURITY CRITICAL: assert that `target` lives strictly under `base`.
 * Both are resolved first; `base` itself is not an acceptable target.
 */
export function assertContained(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  if (t === b || !t.startsWith(prefix)) {
    throw new StoreError('path_escape', 404, 'path escapes its directory');
  }
  return t;
}

const EXT_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.zip': 'application/zip',
}));

export function contentTypeFor(filePath) {
  return EXT_TYPES.get(path.extname(String(filePath)).toLowerCase()) || 'application/octet-stream';
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Atomic write: temp file in the same directory, fsync, rename. */
async function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', FILE_MODE);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, file);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  // Best effort: persist the rename itself.
  try {
    const dh = await fs.open(dir, 'r');
    await dh.sync().catch(() => {});
    await dh.close();
  } catch {
    /* directory fsync is best effort */
  }
}

function clampTitle(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(CONTROL_CHARS, ' ').trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, MAX_TITLE_LENGTH);
}

function cleanSharedWith(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry.replace(CONTROL_CHARS, '').trim();
    if (!cleaned) continue;
    out.push(cleaned.slice(0, MAX_SHARED_WITH_LENGTH));
    if (out.length >= MAX_SHARED_WITH) break;
  }
  return out;
}

/**
 * Normalise whatever was on disk into a trustworthy meta object.
 * Fails closed: an unrecognised visibility becomes `private`.
 */
export function normalizeMeta(raw, id) {
  const meta = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const now = new Date().toISOString();
  return {
    id,
    title: clampTitle(meta.title, id),
    visibility: isVisibility(meta.visibility) ? meta.visibility : DEFAULT_VISIBILITY,
    shared_with: cleanSharedWith(meta.shared_with, []),
    sandbox: meta.sandbox === false ? false : true,
    created: typeof meta.created === 'string' ? meta.created : now,
    updated: typeof meta.updated === 'string' ? meta.updated : now,
    bytes: Number.isFinite(meta.bytes) && meta.bytes >= 0 ? Math.floor(meta.bytes) : 0,
    sha256: typeof meta.sha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.sha256) ? meta.sha256 : '',
  };
}

/** Files inside a doc dir that are never served over HTTP. */
function isServableName(name) {
  if (name === 'meta.json') return false;
  if (name.endsWith('.tmp')) return false;
  return true;
}

export class Store {
  constructor(root) {
    if (typeof root !== 'string' || root.length === 0) {
      throw new TypeError('Store requires a root directory');
    }
    this.root = path.resolve(root);
  }

  /** SECURITY CRITICAL: id -> absolute doc dir, verified inside the root. */
  docDir(id) {
    const problem = idProblem(id);
    if (problem) {
      throw new StoreError(
        problem === 'traversal' ? 'path_escape' : 'bad_id',
        problem === 'traversal' ? 404 : 400,
        'invalid document id',
      );
    }
    const dir = path.resolve(this.root, id);
    assertContained(this.root, dir);
    // Belt and braces: the resolved directory must be exactly root/<id>.
    if (path.dirname(dir) !== this.root || path.basename(dir) !== id) {
      throw new StoreError('path_escape', 404, 'path escapes doc root');
    }
    return dir;
  }

  /**
   * SECURITY CRITICAL: doc-relative segments -> absolute path inside the doc dir.
   * `segments` must already be percent-decoded by the caller.
   */
  resolveInDoc(id, segments) {
    const dir = this.docDir(id);
    if (!Array.isArray(segments) || segments.length === 0) {
      throw notFound();
    }
    for (const seg of segments) {
      if (typeof seg !== 'string' || seg.length === 0) throw notFound();
      if (seg === '.' || seg === '..') throw new StoreError('path_escape', 404, 'traversal');
      if (seg.includes('/') || seg.includes('\\') || seg.includes(NUL)) {
        throw new StoreError('path_escape', 404, 'traversal');
      }
      if (seg.length > 255) throw notFound();
    }
    if (!isServableName(segments[segments.length - 1])) throw notFound();
    const target = path.resolve(dir, ...segments);
    assertContained(dir, target);
    return { dir, target };
  }

  /**
   * Resolve + stat a file for serving. Re-verifies containment against the
   * *real* (symlink-resolved) paths before the caller opens anything.
   * `segments === null` means the document's own index.html.
   */
  async statForServe(id, segments) {
    const dir = this.docDir(id);
    const target = segments === null
      ? path.join(dir, 'index.html')
      : this.resolveInDoc(id, segments).target;
    assertContained(dir, target);

    let realDir;
    let realTarget;
    try {
      realDir = await fs.realpath(dir);
      realTarget = await fs.realpath(target);
    } catch {
      throw notFound();
    }
    assertContained(this.root, realDir);
    assertContained(realDir, realTarget);
    if (!isServableName(path.basename(realTarget))) throw notFound();

    const stat = await fs.stat(realTarget).catch(() => null);
    if (!stat || !stat.isFile()) throw notFound();
    return { path: realTarget, size: stat.size, mtime: stat.mtime, type: contentTypeFor(realTarget) };
  }

  async readMeta(id) {
    const dir = this.docDir(id);
    let raw;
    try {
      raw = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt metadata must never become a public document.
      return normalizeMeta(null, id);
    }
    return normalizeMeta(parsed, id);
  }

  async exists(id) {
    return (await this.readMeta(id)) !== null;
  }

  async list() {
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const docs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isValidId(entry.name)) continue;
      const meta = await this.readMeta(entry.name).catch(() => null);
      if (meta) docs.push(meta);
    }
    docs.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : 1));
    return docs;
  }

  /** Create or replace a document's HTML plus metadata. */
  async put(id, html, opts = {}) {
    const dir = this.docDir(id);
    const body = Buffer.isBuffer(html) ? html : Buffer.from(String(html), 'utf8');
    const prev = await this.readMeta(id);
    const now = new Date().toISOString();

    const meta = normalizeMeta({
      id,
      title: opts.title !== undefined ? opts.title : prev?.title ?? id,
      visibility: opts.visibility !== undefined ? opts.visibility : prev?.visibility ?? DEFAULT_VISIBILITY,
      shared_with: opts.shared_with !== undefined ? opts.shared_with : prev?.shared_with ?? [],
      sandbox: opts.sandbox !== undefined ? opts.sandbox : prev?.sandbox ?? true,
      created: prev?.created ?? now,
      updated: now,
      bytes: body.length,
      sha256: sha256Hex(body),
    }, id);

    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await writeFileAtomic(path.join(dir, 'index.html'), body);
    await writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    return { meta, created: prev === null };
  }

  /** Update metadata only. Returns null when the doc does not exist. */
  async patch(id, changes = {}) {
    const dir = this.docDir(id);
    const prev = await this.readMeta(id);
    if (!prev) return null;
    const next = normalizeMeta({
      ...prev,
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.visibility !== undefined ? { visibility: changes.visibility } : {}),
      ...(changes.shared_with !== undefined ? { shared_with: changes.shared_with } : {}),
      ...(changes.sandbox !== undefined ? { sandbox: changes.sandbox } : {}),
      updated: new Date().toISOString(),
    }, id);
    await writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  /** Remove a document directory. Returns false when it did not exist. */
  async remove(id) {
    const dir = this.docDir(id);
    // Re-verify against the real path so a symlinked doc dir cannot make us
    // delete something outside the root.
    let real;
    try {
      real = await fs.realpath(dir);
    } catch {
      return false;
    }
    assertContained(this.root, real);
    await fs.rm(real, { recursive: true, force: true });
    return true;
  }
}

export default Store;
