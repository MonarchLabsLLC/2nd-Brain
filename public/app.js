const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE = 80;

const state = {
  q: '', root: '', category: '', subcategory: '', folder: '', starred: false, since: 0,
  sort: '', tag: '', view: '', sel: new Set(), offset: 0, items: [], total: 0, selected: null, folderFilter: '',
};

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function bytes(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function ago(ms) {
  const d = (Date.now() - ms) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)} days ago`;
  return fmtDate(ms);
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2400);
}
const hasThumb = (f) => !f.dataless && (f.category === 'image' || ['pdf', 'video', 'office'].includes(f.category));
const snippetHtml = (s) => esc(s).replace(/«/g, '<mark>').replace(/»/g, '</mark>');
function highlight(text) {
  const words = (state.q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1);
  let out = esc(text);
  for (const w of words) out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  return out;
}

// Words that differ by system: Finder and Trash on a Mac, File Explorer and Recycle Bin on Windows.
const MAC_WORDS = { os: 'mac', fileManager: 'Finder', trash: 'Trash', trashLong: 'the macOS Trash', putBack: 'You can put it back from the Trash in Finder.' };
const W = () => statsCache?.platform || MAC_WORDS;
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();

function rootLabel(root) {
  return (statsCache?.roots || []).find((r) => r.path === root)?.label || baseName(root) || 'Downloads';
}
function whereLabel(f) {
  return [rootLabel(f.root), ...f.rel_path.split('/').slice(0, -1)].join(' / ');
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: t });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

// ---------- rail ----------
let statsCache = null;
async function loadStats() {
  const fr = state.root || '';
  statsCache = await api(`/api/stats${fr ? `?root=${encodeURIComponent(fr)}` : ''}`);
  $('#root-path').textContent = statsCache.downloads.replace(/^\/Users\/[^/]+/, '~');
  renderRail();
  renderStatus(statsCache.status);
}

function navBtn({ label, n, active, attrs, cls = '' }) {
  return `<button class="nav-item ${cls}" ${attrs} aria-current="${active}"><span class="nav-label">${esc(label)}</span>${n != null ? `<span class="n">${n.toLocaleString()}</span>` : ''}</button>`;
}

function renderRail() {
  const s = statsCache; if (!s) return;
  const isAll = !state.category && !state.folder && !state.starred && !state.since && !state.root && !state.tag;
  const dl = s.downloads;
  const weekAgo = Date.now() - 7 * 86400000;
  let html = `<div class="group">
    ${navBtn({ label: 'Everything', n: s.total, active: isAll, attrs: 'data-nav="all"' })}
    ${navBtn({ label: 'Starred', n: s.starred, active: state.starred, attrs: 'data-nav="starred"' })}
    ${navBtn({ label: 'Last 7 days', active: !!state.since, attrs: `data-nav="recent" data-since="${weekAgo}"` })}
    ${navBtn({ label: 'Loose in Downloads', n: s.loose, active: state.folder === '__loose', attrs: `data-folder="__loose" data-root="${esc(dl)}"` })}
  </div>
  <div class="group"><h2>Locations</h2>
    ${s.roots.map((r) => `<div class="loc ${r.active ? '' : 'off'}">
      <label class="switch" title="${r.active ? 'On: included in search. Click to turn off.' : 'Off: left out of search. Click to turn on.'}"><input type="checkbox" data-toggle-root="${esc(r.path)}" ${r.active ? 'checked' : ''} aria-label="Include ${esc(r.label)} in search"><span></span></label>
      ${navBtn({ label: r.label + (r.missing ? ' (not found)' : ''), n: r.n, active: state.root === r.path && !state.folder, attrs: `data-root="${esc(r.path)}" title="${esc(r.path)}"` })}${r.organize ? '' : `<button class="loc-remove" data-remove-root="${esc(r.path)}" aria-label="Stop searching ${esc(r.label)}" title="Remove from the list">×</button>`}</div>`).join('')}
    <button class="nav-item add-loc" id="add-root">Add folder…</button>
  </div>
  <div class="group"><h2>Types</h2>`;
  for (const c of s.categories) {
    html += navBtn({ label: c.label, n: c.n, active: state.category === c.category && !state.subcategory, attrs: `data-cat="${c.category}"` });
    if (c.category === 'image') {
      for (const sub of [...s.imageSubs].sort((a, b) => b.n - a.n)) {
        html += navBtn({ label: sub.label, n: sub.n, active: state.subcategory === sub.subcategory, attrs: `data-cat="image" data-sub="${sub.subcategory}"`, cls: 'sub' });
      }
    }
  }
  html += '</div>';
  if (s.tags.length) {
    html += '<div class="group"><h2>Tags</h2>';
    for (const t of s.tags.slice(0, 20)) html += navBtn({ label: t.tag, n: t.n, active: state.tag === t.tag, attrs: `data-tag="${esc(t.tag)}"` });
    html += '</div>';
  }
  const folders = s.folders.filter((f) => f.folder.toLowerCase().includes(state.folderFilter.toLowerCase()));
  const folderRootLabel = (s.roots.find((r) => r.path === s.folderRoot) || {}).label || 'Downloads';
  html += `<div class="group"><h2>Folders in ${esc(folderRootLabel)}</h2>
    <input class="folder-filter" id="folder-filter" placeholder="Filter ${s.folders.length} folders" value="${esc(state.folderFilter)}" aria-label="Filter folders">
    <div class="folders">${folders.map((f) => navBtn({ label: f.folder, n: f.n, active: state.folder === f.folder, attrs: `data-folder="${esc(f.folder)}" data-root="${esc(s.folderRoot)}"` })).join('')}</div></div>`;
  $('#rail-nav').innerHTML = html;
  const ff = $('#folder-filter');
  ff.addEventListener('input', () => {
    state.folderFilter = ff.value;
    const pos = ff.selectionStart; renderRail();
    const nf = $('#folder-filter'); nf.focus(); nf.setSelectionRange(pos, pos);
  });
}

$('#rail-nav').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('[data-folder]');
  if (!b || b.dataset.folder === '__loose') return;
  e.preventDefault();
  openFolderMenu(e.clientX, e.clientY, b.dataset.root, b.dataset.folder);
});

$('#rail-nav').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-toggle-root]'); if (!t) return;
  try {
    await api('/api/roots/active', { method: 'POST', body: { path: t.dataset.toggleRoot, active: t.checked } });
    toast(`${t.closest('.loc').querySelector('.nav-label').textContent} is ${t.checked ? 'on' : 'off'} in search`);
    await loadStats(); loadFiles();
  } catch (err) { toast(err.message); t.checked = !t.checked; }
});

$('#rail-nav').addEventListener('click', async (e) => {
  if (e.target.closest('.switch')) return;
  const rm = e.target.closest('[data-remove-root]');
  if (rm) return removeRoot(rm.dataset.removeRoot);
  if (e.target.closest('#add-root')) return pickRoot();
  const b = e.target.closest('.nav-item'); if (!b) return;
  Object.assign(state, { root: b.dataset.root || '', category: '', subcategory: '', folder: '', starred: false, since: 0 });
  if (b.dataset.nav === 'starred') state.starred = true;
  if (b.dataset.nav === 'recent') state.since = Number(b.dataset.since);
  if (b.dataset.cat) state.category = b.dataset.cat;
  if (b.dataset.sub) state.subcategory = b.dataset.sub;
  if (b.dataset.folder) state.folder = b.dataset.folder;
  if (b.dataset.tag) { state.q = ''; $('#q').value = ''; state.tag = b.dataset.tag; } else state.tag = '';
  if (b.dataset.root !== undefined) await loadStats(); else renderRail();
  loadFiles();
});

async function pickRoot() {
  const btn = $('#add-root'); btn.textContent = 'Choose a folder in the window that opened…';
  try {
    const { path } = await api('/api/roots/pick', { method: 'POST', body: {} });
    if (!path) { toast('No folder added'); return; }
    await api('/api/roots', { method: 'POST', body: { path } });
    toast(`Added ${baseName(path)}. Indexing now.`);
    wasRunning = true; pollStatus();
  } catch (e) { toast(e.message); } finally { await loadStats(); }
}

async function removeRoot(path) {
  const name = baseName(path);
  if (!window.confirm(`Stop searching "${name}"? Your files stay where they are. Only the search index forgets them.`)) return;
  try {
    await api('/api/roots/remove', { method: 'POST', body: { path } });
    if (state.root === path) Object.assign(state, { root: '', folder: '' });
    toast(`Stopped searching ${name}`);
    await loadStats(); loadFiles();
  } catch (e) { toast(e.message); }
}

// ---------- results ----------
function currentView() {
  if (state.view) return state.view;
  return state.category === 'image' ? 'grid' : 'list';
}

let reqId = 0;
async function loadFiles({ append = false } = {}) {
  const id = ++reqId;
  if (!append) state.offset = 0;
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  for (const k of ['root', 'category', 'subcategory', 'folder', 'sort', 'tag']) if (state[k]) p.set(k, state[k]);
  if (state.starred) p.set('starred', '1');
  if (state.since) p.set('since', state.since);
  p.set('limit', PAGE); p.set('offset', state.offset);
  const data = await api(`/api/files?${p}`);
  if (id !== reqId) return;
  state.total = data.total;
  state.items = append ? [...state.items, ...data.items] : data.items;
  if (!append) state.sel.clear();
  renderResults();
}

function renderResults() {
  const view = currentView();
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  $('#result-count').textContent = `${state.total.toLocaleString()} ${state.total === 1 ? 'file' : 'files'}`;
  const el = $('#results');
  if (!state.items.length) {
    const indexing = statsCache?.status?.running;
    el.innerHTML = `<div class="empty"><h3>${indexing ? 'Indexing your Downloads' : 'No files match'}</h3>
      <p>${indexing ? 'Results appear as the index fills. This takes about a minute the first time.' : 'Try fewer words, or choose Everything in the left column.'}</p></div>`;
    $('#more').hidden = true;
    return;
  }
  if (view === 'grid') {
    el.innerHTML = `<div class="grid">${state.items.map((f) => `
      <div class="tile-wrap"><button class="star-toggle" data-star="${f.id}" aria-pressed="${f.starred}" aria-label="${f.starred ? 'Unstar' : 'Star'} ${esc(f.name)}" title="${f.starred ? 'Starred. Click to unstar' : 'Star'}">${f.starred ? '★' : '☆'}</button>
      <button class="tile" data-id="${f.id}" aria-selected="${state.selected === f.id}" data-sel="${state.sel.has(f.id)}">
        <span class="frame">${hasThumb(f) ? `<img loading="lazy" src="/api/files/${f.id}/thumb?v=${f.mtime}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ext',textContent:'${esc(f.ext || 'file')}'}))">` : `<span class="ext">${esc(f.ext || 'file')}</span>`}</span>
        <span class="name">${highlight(f.name)}</span>
        <span class="meta">${f.width ? `${f.width}×${f.height} ` : ''}${ago(f.mtime)}</span>
      </button></div>`).join('')}</div>`;
  } else {
    el.innerHTML = `<div class="list">${state.items.map((f) => `
      <div class="row-wrap"><button class="star-toggle" data-star="${f.id}" aria-pressed="${f.starred}" aria-label="${f.starred ? 'Unstar' : 'Star'} ${esc(f.name)}" title="${f.starred ? 'Starred. Click to unstar' : 'Star'}">${f.starred ? '★' : '☆'}</button>
      <button class="row" data-id="${f.id}" aria-selected="${state.selected === f.id}" data-sel="${state.sel.has(f.id)}">
        <span class="badge">${f.category === 'image' && !f.dataless ? `<img loading="lazy" src="/api/files/${f.id}/thumb?v=${f.mtime}" alt="" onerror="this.remove()">` : ''}${f.category === 'image' && !f.dataless ? '' : esc((f.ext || 'file').slice(0, 5))}</span>
        <span style="min-width:0">
          <span class="title">${highlight(f.name)}</span>
          <span class="where">${esc(whereLabel(f))}${f.tags.length ? `, tagged ${f.tags.map(esc).join(', ')}` : ''}</span>
          ${f.snippet ? `<span class="snip">${snippetHtml(f.snippet)}</span>` : ''}
        </span>
        <span class="size">${bytes(f.size)}</span>
        <span class="date">${ago(f.mtime)}</span>
      </button></div>`).join('')}</div>`;
  }
  $('#more').hidden = state.items.length >= state.total;
  renderBulk();
}

$('#results').addEventListener('click', async (e) => {
  const st = e.target.closest('[data-star]');
  if (st) {
    const id = Number(st.dataset.star); const f = state.items.find((x) => x.id === id);
    const r = await api(`/api/files/${id}/star`, { method: 'POST', body: { starred: !f.starred } });
    toast(r.starred ? 'Starred' : 'Star removed'); refreshAfterEdit(r);
    if (state.selected === id) { const sb = $('#star'); if (sb) { sb.setAttribute('aria-pressed', r.starred); sb.textContent = r.starred ? 'Starred' : 'Star'; } }
    return;
  }
  const b = e.target.closest('[data-id]'); if (!b) return;
  if (dragJustEnded) return;
  const id = Number(b.dataset.id);
  if (e.metaKey || e.ctrlKey) { toggleSel(id); return; }
  if (e.shiftKey) { rangeSel(id); return; }
  if (state.sel.size) { clearSel(); }
  lastClicked = id;
  openDrawer(id);
});
$('#more').addEventListener('click', () => { state.offset += PAGE; loadFiles({ append: true }); });
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; renderResults(); }));
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; loadFiles(); });

let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = e.target.value.trim(); state.tag = ''; loadFiles(); }, 160);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'Escape' && !$('#drawer').hidden && !$('#organize').open) closeDrawer();
});

// ---------- drawer ----------
function closeDrawer() {
  $('#drawer').hidden = true; state.selected = null;
  document.querySelectorAll('[aria-selected="true"]').forEach((x) => x.setAttribute('aria-selected', 'false'));
}

function previewHtml(f) {
  const raw = `/api/files/${f.id}/raw`;
  if (f.dataless) return '<span class="muted">Online-only file. No preview, so it is not downloaded. Use Open or Show in ' + esc(W().fileManager) + ' to get it.</span>';
  if (f.category === 'image') {
    const src = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(f.ext) ? raw : `/api/files/${f.id}/thumb`;
    return `<img src="${src}" alt="Preview of ${esc(f.name)}">`;
  }
  if (f.category === 'video' && ['mp4', 'mov', 'webm', 'm4v'].includes(f.ext)) return `<video src="${raw}" controls preload="metadata"></video>`;
  if (f.category === 'audio') return `<audio src="${raw}" controls preload="metadata"></audio>`;
  if (f.content) return `<pre>${esc(f.content.slice(0, 6000))}</pre>`;
  if (hasThumb(f)) return `<img src="/api/files/${f.id}/thumb" alt="Preview of ${esc(f.name)}" onerror="this.replaceWith('No preview')">`;
  return '<span class="muted">No preview for this file type</span>';
}

async function openDrawer(id) {
  state.selected = id;
  document.querySelectorAll('[data-id]').forEach((x) => x.setAttribute('aria-selected', String(Number(x.dataset.id) === id)));
  const f = await api(`/api/files/${id}`);
  const d = $('#drawer');
  d.hidden = false;
  d.innerHTML = `
    <div class="drawer-head"><span class="muted small">${esc(f.category)}${f.subcategory ? ` / ${esc(f.subcategory)}` : ''}</span>
      <button class="icon-btn" id="close-drawer" aria-label="Close details">✕</button></div>
    <div class="preview">${previewHtml(f)}</div>
    <div class="drawer-body">
      <h3>${esc(f.name)}</h3>
      <div class="actions">
        <button class="btn btn-quiet star-btn" id="star" aria-pressed="${f.starred}">${f.starred ? 'Starred' : 'Star'}</button>
        <button class="btn btn-quiet" id="copy">Copy path</button>
        <button class="btn btn-quiet" id="reveal">Show in ${W().fileManager}</button>
        <button class="btn btn-quiet" id="open">Open</button>
        <button class="btn btn-danger" id="trash">Move to ${W().trash}</button>
      </div>
      <div id="trash-confirm" class="confirm" hidden>
        <p>Move this file to the ${W().trash}? ${W().putBack}</p>
        <div class="actions"><button class="btn btn-danger-solid" id="trash-yes">Move to ${W().trash}</button><button class="btn btn-quiet" id="trash-no">Cancel</button></div>
      </div>
      <dl class="facts">
        <dt>Folder</dt><dd>${esc(whereLabel(f))}</dd>
        <dt>Size</dt><dd>${bytes(f.size)}${f.width ? `, ${f.width}×${f.height} px` : ''}${f.has_alpha ? ', transparent' : ''}</dd>
        <dt>Modified</dt><dd>${fmtDate(f.mtime)}</dd>
        <dt>Added</dt><dd>${fmtDate(f.birthtime)}</dd>
        ${f.source_url ? `<dt>Downloaded from</dt><dd>${f.source_url.split(' ').map((u) => `<a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(u.length > 70 ? u.slice(0, 70) + '…' : u)}</a>`).join('<br>')}</dd>` : ''}
      </dl>
      <div class="tags-field">
        <label for="tags">Tags (separate with commas, press Return to save)</label>
        <input id="tags" value="${esc(f.tags.join(', '))}" placeholder="for example: client, logo, brief">
      </div>
    </div>`;
  $('#close-drawer').onclick = closeDrawer;
  $('#star').onclick = async () => {
    const r = await api(`/api/files/${id}/star`, { method: 'POST', body: { starred: !f.starred } });
    f.starred = r.starred; $('#star').setAttribute('aria-pressed', r.starred); $('#star').textContent = r.starred ? 'Starred' : 'Star';
    toast(r.starred ? 'Starred' : 'Star removed'); refreshAfterEdit(r);
  };
  $('#copy').onclick = async () => { await copyText(f.path); toast('Path copied'); };
  $('#trash').onclick = () => { $('#trash-confirm').hidden = false; $('#trash-yes').focus(); };
  $('#trash-no').onclick = () => { $('#trash-confirm').hidden = true; $('#trash').focus(); };
  $('#trash-yes').onclick = async () => {
    $('#trash-yes').disabled = true; $('#trash-yes').textContent = 'Moving…';
    try {
      await api(`/api/files/${id}/trash`, { method: 'POST', body: {} });
      state.items = state.items.filter((x) => x.id !== id); state.total = Math.max(0, state.total - 1);
      closeDrawer(); renderResults(); loadStats();
      toast(`Moved to ${W().trash}`);
    } catch (e) { toast(e.message); $('#trash-yes').disabled = false; $('#trash-yes').textContent = `Move to ${W().trash}`; }
  };
  $('#reveal').onclick = () => api(`/api/files/${id}/reveal`, { method: 'POST', body: {} }).catch((e) => toast(e.message));
  $('#open').onclick = () => api(`/api/files/${id}/open`, { method: 'POST', body: {} }).catch((e) => toast(e.message));
  $('#tags').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const r = await api(`/api/files/${id}/tags`, { method: 'POST', body: { tags: e.target.value.split(',') } });
    e.target.value = r.tags.join(', '); toast('Tags saved'); refreshAfterEdit(r);
  });
}

function refreshAfterEdit(updated) {
  const i = state.items.findIndex((x) => x.id === updated.id);
  if (i >= 0) state.items[i] = { ...state.items[i], ...updated };
  renderResults(); loadStats();
}

// ---------- index status ----------
function eta(sec) {
  if (sec == null) return '';
  if (sec < 60) return 'less than a minute left';
  const m = Math.round(sec / 60);
  return `about ${m} ${m === 1 ? 'minute' : 'minutes'} left`;
}
function renderStatus(s) {
  const el = $('#index-status');
  let dot; let title; let detail = ''; let bar = '';
  if (s.lastError) {
    dot = 'err'; title = 'Index error'; detail = esc(s.lastError);
  } else if (s.running && s.phase === 'scanning') {
    dot = 'busy'; title = 'Indexing'; detail = `Checking ${s.location ? esc(s.location) : 'folders'} for new and changed files…`;
    bar = '<div class="bar indeterminate"><span></span></div>';
  } else if (s.running) {
    dot = 'busy'; title = `Indexing ${s.percent ?? 0}%`;
    detail = `Reading ${s.done.toLocaleString()} of ${s.total.toLocaleString()} new files${s.etaSeconds != null ? `, ${eta(s.etaSeconds)}` : ''}`;
    bar = `<div class="bar"><span style="width:${s.percent ?? 0}%"></span></div>`;
  } else if (s.pending) {
    dot = 'busy'; title = 'Waiting to index'; detail = `${s.pending.toLocaleString()} files not read yet. They are read at the next scan.`;
  } else {
    dot = 'ok'; title = 'Up to date';
    const when = s.lastScanAt ? new Date(s.lastScanAt) : null;
    detail = `${(s.files || 0).toLocaleString()} files indexed${when ? `, last checked ${ago(s.lastScanAt) === 'today' ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ago(s.lastScanAt)}` : ''}. Watching for changes.`;
  }
  el.innerHTML = `<div class="st-line"><span class="st-dot ${dot}" aria-hidden="true"></span><strong>${title}</strong></div>${bar}<p class="muted small">${detail}</p>`;
}
let wasRunning = false;
async function pollStatus() {
  try {
    const s = await api('/api/status');
    renderStatus(s);
    if (wasRunning && !s.running) { await loadStats(); loadFiles(); }
    wasRunning = s.running;
  } catch { /* server restarting */ }
  setTimeout(pollStatus, wasRunning ? 1500 : 8000);
}
$('#name-btn').addEventListener('click', () => {
  const root = state.root || statsCache.downloads;
  if (state.folder) openNaming(state.folder === '__loose' ? statsCache.downloads : root, state.folder);
  else openNaming(root, undefined);
});
$('#reindex-btn').addEventListener('click', async () => { await api('/api/reindex', { method: 'POST', body: {} }); wasRunning = true; toast('Reindexing'); pollStatus(); });

// ---------- organize ----------
const dlg = $('#organize');
let plan = null; const excluded = new Set();

$('#organize-btn').addEventListener('click', async () => {
  excluded.clear(); plan = null;
  dlg.innerHTML = `<div class="sheet-inner"><div class="sheet-head"><h2 id="organize-title">Organize Downloads</h2><p>Making a plan. Nothing moves yet.</p></div></div>`;
  dlg.showModal();
  try {
    const [p, hist] = await Promise.all([api('/api/organize/plan', { method: 'POST', body: {} }), api('/api/organize/history')]);
    plan = p; renderPlan(hist);
  } catch (e) {
    dlg.querySelector('.sheet-head p').outerHTML = `<div class="error-note">Could not make a plan: ${esc(e.message)}</div>`;
  }
});

function renderPlan(hist = []) {
  const byDir = {};
  for (const it of plan.items) (byDir[it.to_dir] ||= []).push(it);
  const moving = plan.items.length - excluded.size;
  dlg.innerHTML = `<div class="sheet-inner">
    <div class="sheet-head"><h2 id="organize-title">Organize Downloads</h2>
      <p>${plan.count ? `${plan.count} loose files can go into folders. Untick any file to leave it where it is. Files in your subfolders stay where they are.` : 'All loose files are already in folders.'}</p></div>
    <div class="sheet-body">
      ${Object.entries(byDir).sort((a, b) => b[1].length - a[1].length).map(([dir, items]) => `
        <details class="dest"><summary><span class="path">Downloads / ${esc(dir.replace(/\//g, ' / '))}</span><span class="n">${items.filter((i) => !excluded.has(i.file_id)).length} of ${items.length}</span></summary>
          <ul>${items.map((it) => `<li class="${excluded.has(it.file_id) ? 'off' : ''}"><label><input type="checkbox" data-fid="${it.file_id}" ${excluded.has(it.file_id) ? '' : 'checked'}><span class="fname">${esc(it.name)}</span></label></li>`).join('')}</ul>
        </details>`).join('')}
      ${plan.skipped.length ? `<p class="skipped">${plan.skipped.length} files stay where they are: ${summarizeSkips(plan.skipped)}.</p>` : ''}
      ${hist.length ? `<h3 style="font-size:15px;margin:18px 0 6px">Past runs</h3><ul class="history">${hist.map((h) => `<li><span>${new Date(h.moved_at).toLocaleString()}: ${h.n} files moved${h.undone ? `, ${h.undone} put back` : ''}</span>${h.can_undo ? `<button class="btn btn-quiet" data-undo="${h.batch_id}">Undo this run</button>` : ''}</li>`).join('')}</ul>` : ''}
      <div id="org-result"></div>
    </div>
    <div class="sheet-foot">
      <button class="btn btn-quiet" id="org-cancel">Close</button>
      ${plan.count ? `<button class="btn btn-marker" id="org-apply" ${moving ? '' : 'disabled'}>Move ${moving} files</button>` : ''}
    </div></div>`;
  wireSheet();
}

function summarizeSkips(sk) {
  const c = {}; for (const s of sk) c[s.reason] = (c[s.reason] || 0) + 1;
  return Object.entries(c).map(([r, n]) => `${n} ${r}`).join(', ');
}

function wireSheet() {
  $('#org-cancel').onclick = () => dlg.close();
  dlg.querySelectorAll('[data-fid]').forEach((cb) => cb.addEventListener('change', () => {
    const id = Number(cb.dataset.fid);
    cb.checked ? excluded.delete(id) : excluded.add(id);
    cb.closest('li').classList.toggle('off', !cb.checked);
    const det = cb.closest('details'); const all = det.querySelectorAll('[data-fid]');
    det.querySelector('.n').textContent = `${[...all].filter((x) => x.checked).length} of ${all.length}`;
    const moving = plan.items.length - excluded.size;
    const btn = $('#org-apply'); btn.textContent = `Move ${moving} files`; btn.disabled = !moving;
  }));
  const apply = $('#org-apply');
  if (apply) apply.onclick = async () => {
    apply.disabled = true; apply.textContent = 'Moving…';
    try {
      const r = await api('/api/organize/apply', { method: 'POST', body: { plan_id: plan.plan_id, exclude: [...excluded] } });
      $('.sheet-body', dlg).innerHTML = `<div class="result-note">Moved ${r.moved} files into folders. The index is updating.</div>
        ${r.failed.length ? `<div class="error-note">${r.failed.length} files did not move: ${r.failed.slice(0, 5).map((f) => esc(baseName(f.from) + ' (' + f.error + ')')).join(', ')}</div>` : ''}
        <button class="btn btn-quiet" data-undo="${r.batch_id}">Undo this run</button>`;
      $('.sheet-foot', dlg).innerHTML = '<span></span><button class="btn btn-ink" id="org-cancel">Done</button>';
      wireSheet(); toast(`Moved ${r.moved} files`);
      setTimeout(async () => { await loadStats(); loadFiles(); }, 800);
    } catch (e) {
      $('#org-result').innerHTML = `<div class="error-note">${esc(e.message)}</div>`;
      apply.disabled = false; apply.textContent = 'Try again';
    }
  };
  dlg.querySelectorAll('[data-undo]').forEach((b) => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Putting files back…';
    try {
      const r = await api('/api/organize/undo', { method: 'POST', body: { batch_id: b.dataset.undo } });
      b.outerHTML = `<span class="result-note">Put ${r.restored} files back.${r.failed.length ? ` ${r.failed.length} could not move back.` : ''}</span>`;
      toast(`Put ${r.restored} files back`);
      setTimeout(async () => { await loadStats(); loadFiles(); }, 800);
    } catch (e) { b.outerHTML = `<span class="error-note">${esc(e.message)}</span>`; }
  });
}

// ---------- start ----------
await loadStats();
await loadFiles();
pollStatus();


// =====================================================================
// Selection: drag a box on empty space, or ⌘-click / Shift-click files
// =====================================================================
let lastClicked = null; let dragJustEnded = false;

function paintSel() {
  document.querySelectorAll('#results [data-id]').forEach((el) => el.setAttribute('data-sel', String(state.sel.has(Number(el.dataset.id)))));
  renderBulk();
}
function toggleSel(id) { state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id); lastClicked = id; paintSel(); }
function clearSel() { state.sel.clear(); paintSel(); }
function rangeSel(id) {
  const ids = state.items.map((f) => f.id);
  const a = ids.indexOf(lastClicked ?? id); const b = ids.indexOf(id);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = Math.max(lo, 0); i <= hi; i++) state.sel.add(ids[i]);
  paintSel();
}

(function marquee() {
  const area = $('.main');
  let start = null; let box = null; let base = null;
  area.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-id], button, input, select, a, .searchbar, .bulkbar')) return; // only on empty space
    start = { x: e.clientX, y: e.clientY };
    base = (e.metaKey || e.ctrlKey || e.shiftKey) ? new Set(state.sel) : new Set();
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!start) return;
    const w = Math.abs(e.clientX - start.x); const h = Math.abs(e.clientY - start.y);
    if (!box && w + h < 6) return;
    if (!box) { box = document.createElement('div'); box.className = 'marquee'; document.body.append(box); }
    const r = { left: Math.min(e.clientX, start.x), top: Math.min(e.clientY, start.y), width: w, height: h };
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const sel = new Set(base);
    document.querySelectorAll('#results [data-id]').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.right > r.left && b.left < r.left + r.width && b.bottom > r.top && b.top < r.top + r.height) sel.add(Number(el.dataset.id));
    });
    state.sel = sel; paintSel();
  });
  window.addEventListener('mouseup', () => {
    if (!start) return;
    if (box) { box.remove(); box = null; dragJustEnded = true; setTimeout(() => { dragJustEnded = false; }, 0); }
    else if (!base.size) clearSel(); // a plain click on empty space clears the selection
    start = null;
  });
})();

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (typing || $('#organize').open) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); state.items.forEach((f) => state.sel.add(f.id)); paintSel(); }
  if (e.key === 'Escape' && state.sel.size) clearSel();
});

function renderBulk() {
  const bar = $('#bulkbar');
  const n = state.sel.size;
  if (!n) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  if (bar.dataset.mode === 'confirm') return;
  bar.innerHTML = `<span class="bulk-count">${n.toLocaleString()} selected</span>
    <button class="btn btn-quiet" data-bulk="star">Star</button>
    <button class="btn btn-quiet" data-bulk="unstar">Unstar</button>
    <button class="btn btn-danger" data-bulk="trash">Move to ${W().trash}</button>
    <button class="btn btn-quiet" data-bulk="all">Select all ${state.items.length < state.total ? 'shown' : ''}</button>
    <button class="btn btn-quiet" data-bulk="clear">Clear</button>`;
}

$('#bulkbar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-bulk]'); if (!b) return;
  const bar = $('#bulkbar'); const ids = [...state.sel];
  const act = b.dataset.bulk;
  if (act === 'clear') return clearSel();
  if (act === 'all') { state.items.forEach((f) => state.sel.add(f.id)); return paintSel(); }
  if (act === 'trash') {
    bar.dataset.mode = 'confirm';
    bar.innerHTML = `<span class="bulk-count">Move ${ids.length.toLocaleString()} ${ids.length === 1 ? 'file' : 'files'} to the ${W().trash}? ${W().os === 'windows' ? 'You can restore them from the Recycle Bin.' : 'You can put them back from the Trash in Finder.'}</span>
      <button class="btn btn-danger-solid" data-bulk="trash-yes">Move to ${W().trash}</button><button class="btn btn-quiet" data-bulk="trash-no">Cancel</button>`;
    bar.querySelector('[data-bulk="trash-yes"]').focus();
    return;
  }
  if (act === 'trash-no') { delete bar.dataset.mode; return renderBulk(); }
  const action = act === 'trash-yes' ? 'trash' : act;
  b.disabled = true;
  try {
    const r = await api('/api/bulk', { method: 'POST', body: { action, ids } });
    delete bar.dataset.mode;
    if (action === 'trash') {
      const gone = new Set(ids);
      state.items = state.items.filter((f) => !gone.has(f.id)); state.total -= r.done;
      if (gone.has(state.selected)) closeDrawer();
    } else {
      state.items.forEach((f) => { if (state.sel.has(f.id)) f.starred = action === 'star'; });
    }
    state.sel.clear(); renderResults(); loadStats();
    toast(action === 'trash' ? `Moved ${r.done} to ${W().trash}${r.failed.length ? `, ${r.failed.length} failed` : ''}` : `${action === 'star' ? 'Starred' : 'Unstarred'} ${r.done}`);
  } catch (err) { toast(err.message); b.disabled = false; }
});

// =====================================================================
// Folder menu: right-click a folder in the left column
// =====================================================================
function openFolderMenu(x, y, root, folder) {
  const m = $('#ctxmenu');
  m.innerHTML = `<button role="menuitem" data-m="name">Optimize names…</button>
    <button role="menuitem" data-m="reveal">Show in ${W().fileManager}</button>
    <hr>
    <button role="menuitem" data-m="trash" class="danger">Delete all contents…</button>`;
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  m.querySelector('button').focus();
  m.onclick = (e) => {
    const it = e.target.closest('[data-m]'); if (!it) return;
    m.hidden = true;
    if (it.dataset.m === 'name') openNaming(root, folder);
    if (it.dataset.m === 'reveal') api('/api/folders/reveal', { method: 'POST', body: { root, folder } }).catch((er) => toast(er.message));
    if (it.dataset.m === 'trash') openFolderTrash(root, folder);
  };
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxmenu')) $('#ctxmenu').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#ctxmenu').hidden = true; });

async function openFolderTrash(root, folder) {
  let info;
  try { info = await api(`/api/folders/info?root=${encodeURIComponent(root)}&folder=${encodeURIComponent(folder)}`); } catch (e) { return toast(e.message); }
  dlg.innerHTML = `<div class="sheet-inner">
    <div class="sheet-head danger-head"><h2 id="organize-title">Delete all contents of “${esc(folder)}”?</h2>
      <p>This moves everything inside the folder to the ${W().trash}: ${info.children.toLocaleString()} ${info.children === 1 ? 'item' : 'items'}, ${info.files.toLocaleString()} indexed files, ${bytes(info.bytes)}. The empty folder stays.</p></div>
    <div class="sheet-body">
      <div class="warn-box">
        <p><strong>Check this carefully.</strong> ${info.starred ? `${info.starred} starred ${info.starred === 1 ? 'file is' : 'files are'} in this folder. ` : ''}Files go to ${W().trashLong}. You can put them back from the ${W().trash} until you empty it.</p>
        <p class="muted small">${esc(info.path)}</p>
      </div>
      <label class="type-confirm"><span>Type <strong>${esc(folder)}</strong> to confirm</span>
        <input id="confirm-name" autocomplete="off" spellcheck="false"></label>
      <div id="trash-result"></div>
    </div>
    <div class="sheet-foot"><button class="btn btn-quiet" id="ft-cancel">Cancel</button>
      <button class="btn btn-danger-solid" id="ft-go" disabled>Move ${info.children.toLocaleString()} items to ${W().trash}</button></div></div>`;
  dlg.showModal();
  const input = $('#confirm-name'); const go = $('#ft-go');
  input.focus();
  input.addEventListener('input', () => { go.disabled = input.value !== folder; });
  $('#ft-cancel').onclick = () => dlg.close();
  go.onclick = async () => {
    go.disabled = true; go.textContent = `Moving to ${W().trash}…`;
    try {
      const r = await api('/api/folders/trash-contents', { method: 'POST', body: { root, folder, confirm: input.value } });
      $('#trash-result').innerHTML = `<div class="result-note">Moved ${r.moved} items to the ${W().trash}.${r.failed.length ? ` ${r.failed.length} could not move: ${r.failed.slice(0, 5).map(esc).join(', ')}` : ''}</div>`;
      $('.sheet-foot', dlg).innerHTML = '<span></span><button class="btn btn-ink" id="ft-done">Done</button>';
      $('#ft-done').onclick = () => dlg.close();
      toast(`Moved ${r.moved} items to ${W().trash}`);
      setTimeout(async () => { await loadStats(); loadFiles(); }, 1500);
    } catch (e) { $('#trash-result').innerHTML = `<div class="error-note">${esc(e.message)}</div>`; go.disabled = false; go.textContent = 'Try again'; }
  };
}

// =====================================================================
// Naming: Claude looks at files with junk names and suggests real names
// =====================================================================
async function openNaming(root, folder) {
  const where = folder === '__loose' ? 'loose files in Downloads' : folder ? `“${folder}”` : `all of ${rootLabel(root)}`;
  const q = new URLSearchParams({ root }); if (folder) q.set('folder', folder);
  dlg.innerHTML = `<div class="sheet-inner"><div class="sheet-head"><h2 id="organize-title">Name unnamed files</h2><p>Looking for unclear names in ${esc(where)}…</p></div></div>`;
  dlg.showModal();
  let c;
  try { c = await api(`/api/naming/count?${q}`); } catch (e) { return toast(e.message); }
  const batch = Math.min(c.count, 40);
  dlg.innerHTML = `<div class="sheet-inner">
    <div class="sheet-head"><h2 id="organize-title">Name unnamed files</h2>
      <p>${c.count ? `${c.count.toLocaleString()} files in ${esc(where)} have unclear names, such as IDs, “Untitled” or camera numbers. Claude looks at each one and suggests a name. You check the names before anything changes.` : `Every file in ${esc(where)} already has a clear name.`}</p></div>
    <div class="sheet-body">
      <p class="muted small">Files with real names stay as they are. Files inside code projects and files that look like secrets are skipped.${c.skippedProject ? ` ${c.skippedProject} files were skipped because they are part of a project.` : ''}</p>
      <div id="name-list"></div>
    </div>
    <div class="sheet-foot"><button class="btn btn-quiet" id="nm-close">Close</button>
      ${c.count ? `<button class="btn btn-marker" id="nm-start">Suggest names for ${batch} ${batch === 1 ? 'file' : 'files'}</button>` : ''}</div></div>`;
  $('#nm-close').onclick = () => { if (namingJob) api(`/api/naming/${namingJob}/cancel`, { method: 'POST', body: {} }).catch(() => {}); namingJob = null; dlg.close(); };
  const st = $('#nm-start');
  if (st) st.onclick = () => runNaming(root, folder, batch);
}

let namingJob = null;
async function runNaming(root, folder, limit) {
  const foot = $('.sheet-foot', dlg);
  let job;
  try { job = await api('/api/naming/start', { method: 'POST', body: { root, folder, limit } }); } catch (e) { return toast(e.message); }
  namingJob = job.id;
  $('#nm-start').remove();
  foot.insertAdjacentHTML('beforeend', '<button class="btn btn-marker" id="nm-apply" disabled>Rename 0 files</button>');
  const chosen = new Map(); // file_id -> name
  const shown = new Set();
  const list = $('#name-list');
  list.innerHTML = `<p class="progress" id="nm-progress">Claude is looking at the files…</p><div class="name-rows"></div>`;
  const rows = list.querySelector('.name-rows');
  const updateApply = () => { const b = $('#nm-apply'); if (b) { b.textContent = `Rename ${chosen.size} ${chosen.size === 1 ? 'file' : 'files'}`; b.disabled = !chosen.size; } };

  while (namingJob === job.id) {
    job = await api(`/api/naming/${job.id}`);
    for (const pr of job.proposals) {
      if (shown.has(pr.file_id)) continue;
      shown.add(pr.file_id); chosen.set(pr.file_id, pr.new_name);
      const ext = pr.old_name.includes('.') ? pr.old_name.split('.').pop() : '';
      const base = ext ? pr.new_name.slice(0, -(ext.length + 1)) : pr.new_name;
      rows.insertAdjacentHTML('beforeend', `<div class="name-row" data-fid="${pr.file_id}">
        <input type="checkbox" checked aria-label="Rename ${esc(pr.old_name)}">
        <span class="name-thumb">${pr.category === 'image' || ['pdf', 'docx', 'doc'].includes(ext) ? `<img src="/api/files/${pr.file_id}/thumb" alt="">` : esc(ext)}</span>
        <span class="name-fields"><span class="old">${esc(pr.old_name)}</span>
          <span class="new"><input value="${esc(base)}" aria-label="New name for ${esc(pr.old_name)}">${ext ? `<span class="ext">.${esc(ext)}</span>` : ''}</span></span>
      </div>`);
      const row = rows.lastElementChild;
      const cb = row.querySelector('input[type=checkbox]'); const inp = row.querySelector('.new input');
      const sync = () => { if (cb.checked && inp.value.trim()) chosen.set(pr.file_id, inp.value.trim()); else chosen.delete(pr.file_id); row.classList.toggle('off', !cb.checked); updateApply(); };
      cb.onchange = sync; inp.oninput = sync;
    }
    updateApply();
    const pg = $('#nm-progress');
    if (pg) pg.textContent = job.state === 'running' ? `Claude is looking at the files: ${job.done} of ${job.total} done…`
      : job.state === 'failed' ? `Naming stopped: ${job.errors[0] || 'unknown error'}`
      : `${job.proposals.length} names suggested${job.unsure.length ? `; Claude could not tell what ${job.unsure.length} ${job.unsure.length === 1 ? 'file is' : 'files are'}` : ''}${job.errors.length ? `; ${job.errors.length} batch failed` : ''}. Edit any name, untick what you want to keep, then rename.`;
    if (job.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const apply = $('#nm-apply');
  if (apply) apply.onclick = async () => {
    apply.disabled = true; apply.textContent = 'Renaming…';
    try {
      const r = await api('/api/naming/apply', { method: 'POST', body: { job_id: job.id, renames: [...chosen].map(([file_id, base]) => ({ file_id, new_name: base })) } });
      namingJob = null;
      $('.sheet-body', dlg).innerHTML = `<div class="result-note">Renamed ${r.moved} files. The index is updating.</div>
        ${r.failed.length ? `<div class="error-note">${r.failed.length} files were not renamed: ${r.failed.slice(0, 5).map((f) => esc(baseName(f.from) + ' (' + f.error + ')')).join(', ')}</div>` : ''}
        <button class="btn btn-quiet" data-undo="${r.batch_id}">Undo these renames</button>`;
      $('.sheet-foot', dlg).innerHTML = '<span></span><button class="btn btn-ink" id="org-cancel">Done</button>';
      wireSheet(); toast(`Renamed ${r.moved} files`);
      setTimeout(async () => { await loadStats(); loadFiles(); }, 1000);
    } catch (e) { toast(e.message); apply.disabled = false; updateApply(); }
  };
}
