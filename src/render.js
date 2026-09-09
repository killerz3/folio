// folio — server-rendered index page.
//
// No frameworks, no client JS, no external requests. Every interpolated
// value is attacker-influenced text and goes through escapeHtml().

import { VISIBILITY_TO_PREFIX } from './store.js';

/** Escape for both element text and quoted attribute values. */
export function escapeHtml(value) {
  const s = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '&': out += '&amp;'; break;
      case '<': out += '&lt;'; break;
      case '>': out += '&gt;'; break;
      case '"': out += '&quot;'; break;
      case "'": out += '&#39;'; break;
      case '`': out += '&#96;'; break;
      default: out += ch;
    }
  }
  return out;
}

export function formatBytes(n) {
  const bytes = Number.isFinite(n) && n >= 0 ? n : 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

export function docPath(meta) {
  const prefix = VISIBILITY_TO_PREFIX[meta?.visibility] || 'a';
  return `/${prefix}/${meta?.id ?? ''}`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b66; --line: #e3e3df;
  --card: #ffffff; --accent: #2f5bd8;
  --pub-bg: #e3f4e6; --pub-fg: #1c5b2c;
  --sha-bg: #fdf0d9; --sha-fg: #7a4a06;
  --pri-bg: #ececf3; --pri-fg: #40405a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181c; --fg: #e8e8e6; --muted: #9a9a95; --line: #2b2f36;
    --card: #1d2026; --accent: #8fb0ff;
    --pub-bg: #17331f; --pub-fg: #8fd6a2;
    --sha-bg: #3a2c11; --sha-fg: #e8c07a;
    --pri-bg: #24262f; --pri-fg: #b6b8cc;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 62rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: 1.75rem; }
h1 { font-size: 1.4rem; margin: 0; letter-spacing: -0.01em; }
.count { color: var(--muted); font-size: .875rem; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .625rem; }
li {
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: .875rem 1rem;
}
.row { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem .75rem; }
a.title { color: var(--fg); text-decoration: none; font-weight: 600; }
a.title:hover { color: var(--accent); text-decoration: underline; }
.id { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; }
.badge {
  font-size: .6875rem; text-transform: uppercase; letter-spacing: .04em;
  padding: .125rem .4rem; border-radius: 999px; font-weight: 600;
}
.badge.public { background: var(--pub-bg); color: var(--pub-fg); }
.badge.shared { background: var(--sha-bg); color: var(--sha-fg); }
.badge.private { background: var(--pri-bg); color: var(--pri-fg); }
.meta { color: var(--muted); font-size: .8125rem; margin-top: .3rem; display: flex; flex-wrap: wrap; gap: .75rem; }
.empty { color: var(--muted); border: 1px dashed var(--line); border-radius: 10px; padding: 2rem; text-align: center; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
footer { margin-top: 2.5rem; color: var(--muted); font-size: .8125rem; }
`.trim();

function renderItem(meta) {
  const visibility = ['public', 'shared', 'private'].includes(meta.visibility) ? meta.visibility : 'private';
  const href = escapeHtml(docPath({ ...meta, visibility }));
  const title = escapeHtml(meta.title || meta.id);
  const id = escapeHtml(meta.id);
  const badge = escapeHtml(visibility);
  const updated = escapeHtml(formatDate(meta.updated));
  const size = escapeHtml(formatBytes(meta.bytes));
  const shared = Array.isArray(meta.shared_with) ? meta.shared_with.length : 0;
  const sharedBit = shared > 0 ? `<span>shared with ${escapeHtml(String(shared))}</span>` : '';
  const sandboxBit = meta.sandbox === false ? '<span>sandbox off</span>' : '';
  return [
    '    <li>',
    '      <div class="row">',
    `        <a class="title" href="${href}">${title}</a>`,
    `        <span class="badge ${badge}">${badge}</span>`,
    `        <span class="id">${id}</span>`,
    '      </div>',
    '      <div class="meta">',
    `        <span>${updated}</span>`,
    `        <span>${size}</span>`,
    `        <span><code>${href}</code></span>`,
    sharedBit ? `        ${sharedBit}` : '',
    sandboxBit ? `        ${sandboxBit}` : '',
    '      </div>',
    '    </li>',
  ].filter(Boolean).join('\n');
}

/** Full HTML document for GET / . */
export function renderIndex(docs = [], { title = 'folio' } = {}) {
  const list = Array.isArray(docs) ? docs : [];
  const body = list.length === 0
    ? '  <p class="empty">No documents yet. Publish one with <code>folio publish &lt;file&gt;</code>.</p>'
    : `  <ul>\n${list.map(renderItem).join('\n')}\n  </ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="count">${escapeHtml(String(list.length))} document${list.length === 1 ? '' : 's'}</span>
</header>
${body}
<footer>Served by folio.</footer>
</main>
</body>
</html>
`;
}

export default { renderIndex, escapeHtml, formatBytes, formatDate, docPath };
