// folio — server-rendered pages: the /main document index and the / product
// landing page.
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

/** Shared tokens so /main and / read as one product, not two sites. */
const PALETTE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b66; --line: #e3e3df;
  --card: #ffffff; --accent: #2f5bd8; --accent-fg: #ffffff;
  --pub-bg: #e3f4e6; --pub-fg: #1c5b2c;
  --sha-bg: #fdf0d9; --sha-fg: #7a4a06;
  --pri-bg: #ececf3; --pri-fg: #40405a;
  --chip-bg: #eef1fb; --chip-fg: #2f3a66; --chip-line: #d7ddf3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181c; --fg: #e8e8e6; --muted: #9a9a95; --line: #2b2f36;
    --card: #1d2026; --accent: #8fb0ff; --accent-fg: #0b0d10;
    --pub-bg: #17331f; --pub-fg: #8fd6a2;
    --sha-bg: #3a2c11; --sha-fg: #e8c07a;
    --pri-bg: #24262f; --pri-fg: #b6b8cc;
    --chip-bg: #1f2433; --chip-fg: #aab6e8; --chip-line: #2d3550;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
a { color: inherit; }
`.trim();

// --------------------------------------------------------------- /main ----

const INDEX_STYLE = `
${PALETTE}
main { max-width: 64rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
header.top { display: flex; align-items: baseline; gap: .75rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
h1 { font-size: 1.4rem; margin: 0; letter-spacing: -0.01em; }
h1 a { text-decoration: none; }
.count { color: var(--muted); font-size: .875rem; }
.filters {
  display: flex; flex-wrap: wrap; gap: 1.5rem; margin-bottom: 1.75rem;
  padding: 1rem 1.1rem; background: var(--card); border: 1px solid var(--line); border-radius: 10px;
}
.filter-group { border: 0; margin: 0; padding: 0; min-width: 10rem; }
.filter-group legend {
  font-size: .6875rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  padding: 0; margin-bottom: .4rem; font-weight: 600;
}
.chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.chip {
  display: inline-flex; align-items: center; gap: .3rem; cursor: pointer; user-select: none;
  font-size: .8125rem; padding: .2rem .55rem; border-radius: 999px;
  background: var(--chip-bg); color: var(--chip-fg); border: 1px solid var(--chip-line);
}
.chip input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.chip input:checked + span { font-weight: 700; }
.chip:has(input:checked) { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.chip .n { opacity: .65; font-size: .75em; }
.clear-link { align-self: flex-end; font-size: .8125rem; color: var(--accent); text-decoration: none; }
.clear-link:hover { text-decoration: underline; }
ul.list { list-style: none; margin: 0; padding: 0; display: grid; gap: .625rem; }
li.doc {
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
.badge.folder { background: var(--chip-bg); color: var(--chip-fg); border: 1px solid var(--chip-line); text-transform: none; }
.tagrow { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .45rem; }
.tag {
  font-size: .75rem; color: var(--muted); background: transparent; border: 1px dashed var(--line);
  border-radius: 999px; padding: .05rem .5rem;
}
.meta { color: var(--muted); font-size: .8125rem; margin-top: .3rem; display: flex; flex-wrap: wrap; gap: .75rem; }
.empty { color: var(--muted); border: 1px dashed var(--line); border-radius: 10px; padding: 2rem; text-align: center; }
footer { margin-top: 2.5rem; color: var(--muted); font-size: .8125rem; }
footer a { color: var(--accent); }
`.trim();

/** folder/tag values are already SLUG_RE-validated by the store, but every
 * interpolation here still runs through escapeHtml — defence in depth. */
function slugClass(prefix, slug) {
  return `${prefix}-${escapeHtml(slug)}`;
}

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
  const folder = typeof meta.folder === 'string' && meta.folder ? meta.folder : null;
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const classes = ['doc', slugClass('f', folder || 'untagged'), ...tags.map((t) => slugClass('t', t))];
  const folderBadge = folder
    ? `<span class="badge folder">${escapeHtml(folder)}</span>`
    : `<span class="badge folder">untagged</span>`;
  const tagChips = tags.length
    ? `<div class="tagrow">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  return [
    `    <li class="${classes.join(' ')}">`,
    '      <div class="row">',
    `        <a class="title" href="${href}">${title}</a>`,
    `        <span class="badge ${badge}">${badge}</span>`,
    folderBadge,
    `        <span class="id">${id}</span>`,
    '      </div>',
    tagChips,
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

function count(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/** The checkbox-hack filter CSS: one AND-style hide rule per folder/tag
 * actually present in this batch of docs. No client JS, ever. */
function renderFilterCSS(folders, tags) {
  const rules = [];
  for (const f of folders.keys()) {
    const cls = slugClass('f', f);
    rules.push(`#chk-${cls}:checked ~ .list .doc:not(.${cls}) { display: none; }`);
  }
  for (const t of tags.keys()) {
    const cls = slugClass('t', t);
    rules.push(`#chk-${cls}:checked ~ .list .doc:not(.${cls}) { display: none; }`);
  }
  return rules.join('\n');
}

function renderFilterGroup(legend, map, prefix) {
  if (map.size === 0) return '';
  const chips = [...map.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([key, n]) => {
      const cls = slugClass(prefix, key);
      return [
        `      <label class="chip">`,
        `        <input type="checkbox" id="chk-${cls}">`,
        `        <span>${escapeHtml(key)} <span class="n">${n}</span></span>`,
        `      </label>`,
      ].join('\n');
    });
  return [
    `    <fieldset class="filter-group">`,
    `      <legend>${escapeHtml(legend)}</legend>`,
    `      <div class="chips">`,
    ...chips,
    `      </div>`,
    `    </fieldset>`,
  ].join('\n');
}

/** Full HTML document for GET /main — every document, folder/tag filterable
 * entirely in CSS (`:checked ~` sibling rules), no JavaScript. */
export function renderIndex(docs = [], { title = 'folio · all documents' } = {}) {
  const list = Array.isArray(docs) ? docs : [];
  const folders = new Map();
  const tags = new Map();
  for (const meta of list) {
    count(folders, (typeof meta.folder === 'string' && meta.folder) || 'untagged');
    for (const t of Array.isArray(meta.tags) ? meta.tags : []) count(tags, t);
  }
  const filterCss = renderFilterCSS(folders, tags);
  const filtersHtml = list.length === 0 ? '' : [
    '<div class="filters">',
    renderFilterGroup('Folder', folders, 'f'),
    renderFilterGroup('Tags', tags, 't'),
    '  <a class="clear-link" href="/main">Clear filters</a>',
    '</div>',
  ].filter(Boolean).join('\n');
  const body = list.length === 0
    ? '  <p class="empty">No documents yet. Publish one with <code>folio publish &lt;file&gt;</code>.</p>'
    : `${filtersHtml}\n  <ul class="list">\n${list.map(renderItem).join('\n')}\n  </ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
${INDEX_STYLE}
${filterCss}
</style>
</head>
<body>
<main>
<header class="top">
  <h1><a href="/">folio</a> · all documents</h1>
  <span class="count">${escapeHtml(String(list.length))} document${list.length === 1 ? '' : 's'}</span>
</header>
${body}
<footer>Served by folio. <a href="/">Product page</a></footer>
</main>
</body>
</html>
`;
}

// --------------------------------------------------------------- / --------

const LANDING_STYLE = `
${PALETTE}
.wrap { max-width: 56rem; margin: 0 auto; padding: 0 1.25rem; }
header.nav { border-bottom: 1px solid var(--line); padding: 1.1rem 0; }
header.nav .wrap { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.brand { font-weight: 800; font-size: 1.05rem; text-decoration: none; letter-spacing: -0.01em; }
.nav a.gh { color: var(--muted); text-decoration: none; font-size: .875rem; border: 1px solid var(--line); padding: .35rem .75rem; border-radius: 999px; }
.nav a.gh:hover { color: var(--fg); border-color: var(--accent); }
.hero { padding: 4.5rem 0 3.5rem; text-align: center; }
.eyebrow {
  display: inline-flex; align-items: center; gap: .5rem; font-size: .8125rem; color: var(--muted);
  border: 1px solid var(--line); border-radius: 999px; padding: .3rem .9rem; margin-bottom: 1.5rem;
}
h1.hero-title { font-size: clamp(2rem, 5vw, 2.9rem); line-height: 1.1; letter-spacing: -0.02em; margin: 0 0 1rem; }
.lede { font-size: 1.125rem; color: var(--muted); max-width: 38rem; margin: 0 auto 2rem; }
.cta { display: flex; gap: .75rem; justify-content: center; flex-wrap: wrap; margin-bottom: 1.25rem; }
.btn {
  display: inline-flex; align-items: center; gap: .4rem; padding: .7rem 1.3rem; border-radius: 9px;
  font-weight: 600; font-size: .9375rem; text-decoration: none; border: 1px solid transparent;
}
.btn-primary { background: var(--accent); color: var(--accent-fg); }
.btn-primary:hover { opacity: .9; }
.btn-ghost { border-color: var(--line); color: var(--fg); }
.btn-ghost:hover { border-color: var(--accent); color: var(--accent); }
.cmd {
  display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem;
  color: var(--muted); background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: .5rem .9rem;
}
.cmd .prompt { color: var(--accent); margin-right: .5rem; }
section.section { padding: 3rem 0; border-top: 1px solid var(--line); }
section.section h2 { font-size: 1.5rem; letter-spacing: -0.01em; margin: 0 0 .5rem; text-align: center; }
section.section .sub { color: var(--muted); text-align: center; max-width: 34rem; margin: 0 auto 2.25rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.4rem;
}
.card h3 { margin: 0 0 .4rem; font-size: 1.0625rem; }
.card p { margin: 0; color: var(--muted); font-size: .9rem; }
.model { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.model > div { background: var(--card); padding: 1.1rem 1.2rem; }
.model code { font-size: .8rem; color: var(--accent); }
.model .prefix { font-weight: 700; font-size: 1.05rem; }
.model .who { color: var(--muted); font-size: .875rem; margin-top: .3rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 1rem; text-align: center; }
.stat .n { font-size: 1.6rem; font-weight: 800; letter-spacing: -0.02em; }
.stat .l { color: var(--muted); font-size: .8125rem; margin-top: .25rem; }
pre.code {
  background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.2rem;
  overflow-x: auto; font-size: .8125rem; line-height: 1.6;
}
footer.site { border-top: 1px solid var(--line); padding: 2.5rem 0; color: var(--muted); font-size: .8125rem; text-align: center; }
footer.site a { color: var(--accent); text-decoration: none; }
footer.site a:hover { text-decoration: underline; }
`.trim();

const FEATURES = [
  ['Zero dependencies', 'Node 22 built-ins only. No express, no npm install, no build step — read the whole server in one sitting.'],
  ['Two independent gates', 'Cloudflare Access decides who reaches a prefix; folio re-checks that the stored visibility matches it and 404s on any mismatch. Neither layer trusts the other.'],
  ['Visibility is the URL', '/p/ public, /t/ shared with named emails, /a/ private. Change visibility and the old URL simply stops answering.'],
  ['Folder + tag browsing', 'Every document gets a folder and free-form subtags. /main filters them with CSS-only checkboxes — no client JavaScript, ever.'],
  ['Filesystem is truth', 'No database. A document is a directory: index.html, meta.json, assets/. Backup is `tar czf`.'],
  ['A CLI that fits in your head', '`folio publish`, `list`, `show`, `share`, `rm`. Six verbs, JSON output on request, never prints your token.'],
];

const MODEL = [
  ['/p/:id', 'public', 'anyone on the internet'],
  ['/t/:id', 'shared', 'the emails you listed'],
  ['/a/:id', 'private', 'you only'],
  ['/main', '—', 'the index, you only'],
];

/** Full HTML document for GET / — the public product page for folio itself.
 * Static, no store access, no document data: safe to serve to anyone. */
export function renderLanding() {
  const features = FEATURES.map(([h, p]) => `
    <div class="card">
      <h3>${escapeHtml(h)}</h3>
      <p>${escapeHtml(p)}</p>
    </div>`).join('');
  const model = MODEL.map(([prefix, vis, who]) => `
    <div>
      <div class="prefix"><code>${escapeHtml(prefix)}</code></div>
      <div class="who">${vis !== '—' ? `${escapeHtml(vis)} · ` : ''}${escapeHtml(who)}</div>
    </div>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>folio — a self-hosted host for single-page HTML documents</title>
<meta name="description" content="folio publishes one-page HTML artifacts from the command line and hands back a URL on your own domain. Zero runtime dependencies, two independent visibility gates, folder and tag browsing — no database, no client JavaScript.">
<meta name="theme-color" content="#16181c">
<meta property="og:type" content="website">
<meta property="og:site_name" content="folio">
<meta property="og:title" content="folio — publish from the command line, host it yourself">
<meta property="og:description" content="A self-hosted, zero-dependency host for single-page HTML documents. Two independent visibility gates, folder/tag browsing, no database, no client JavaScript.">
<style>
${LANDING_STYLE}
</style>
</head>
<body>
<header class="nav">
  <div class="wrap">
    <a class="brand" href="/">folio</a>
    <a class="gh" href="https://github.com/killerz3/folio">GitHub ↗</a>
  </div>
</header>

<main>
  <section class="hero wrap">
    <p class="eyebrow">Self-hosted · zero dependencies · open source</p>
    <h1 class="hero-title">Publish a page.<br>Keep the server.</h1>
    <p class="lede">folio turns a single <code>index.html</code> into a URL on your own domain — public, shared with named people, or private to you — served by code you can read end to end in one sitting.</p>
    <div class="cta">
      <a class="btn btn-primary" href="https://github.com/killerz3/folio">Get the code</a>
      <a class="btn btn-ghost" href="https://github.com/killerz3/folio#install">Read the install guide</a>
    </div>
    <code class="cmd"><span class="prompt">$</span>folio publish ./report.html --public</code>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="stats">
        <div class="stat"><div class="n">0</div><div class="l">runtime dependencies</div></div>
        <div class="stat"><div class="n">3</div><div class="l">visibility prefixes</div></div>
        <div class="stat"><div class="n">2</div><div class="l">independent auth layers</div></div>
        <div class="stat"><div class="n">MIT</div><div class="l">license</div></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <h2>One origin, three prefixes</h2>
      <p class="sub">Visibility lives on the URL, not behind a login wall that differs from what is actually enforced. The origin re-checks it on every request.</p>
      <div class="model">${model}</div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <h2>Built like infrastructure, not a side project</h2>
      <p class="sub">Every hard rule from the build spec, still true today.</p>
      <div class="grid">${features}</div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <h2>Install it on your own box</h2>
      <p class="sub">A git clone and one script. No managed service, no account, no vendor.</p>
      <pre class="code">git clone https://github.com/killerz3/folio.git ~/folio
cd ~/folio
sudo ./install.sh

folio publish ./deck.html --public
# -&gt; https://your-domain/p/deck</pre>
    </div>
  </section>
</main>

<footer class="site">
  <div class="wrap">
    Self-hosted by its own operator. <a href="https://github.com/killerz3/folio">Source on GitHub</a> · <a href="/main">Document index (owner)</a>
  </div>
</footer>
</body>
</html>
`;
}

export default { renderIndex, renderLanding, escapeHtml, formatBytes, formatDate, docPath };
