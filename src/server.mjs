import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, THUMB_DIR, DOWNLOADS_DIR, SKIP_FILES, ensureDirs } from './config.mjs';
import { refresh, watchAll, fullStatus } from './indexer.mjs';
import { searchFiles, getFile, setStar, setTags, stats, deleteRow } from './queries.mjs';
import { getRoots, addRoot, removeRoot, setRootActive } from './roots.mjs';
import { createPlan, applyPlan, undoBatch, history } from './organize.mjs';
import { thumbnail } from './thumbs.mjs';
import { moveToTrash } from './trash.mjs';
import { findUnnamed, startNaming, getJob, cancelJob, planFromProposals, cleanName } from './naming.mjs';
import { LABELS, reveal, openPath, pickFolder } from './platform/index.mjs';

// The Windows background service has no terminal; it writes its log to a file instead.
if (process.env.SECONDBRAIN_LOG) {
  const log = fs.createWriteStream(process.env.SECONDBRAIN_LOG, { flags: 'a' });
  const write = (...a) => log.write(`${new Date().toISOString()} ${a.map(String).join(' ')}\n`);
  console.log = write; console.error = write;
  process.on('uncaughtException', (e) => { write('Crashed:', e?.stack || e); log.end(() => process.exit(1)); });
}
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  avif: 'image/avif', ico: 'image/x-icon', pdf: 'application/pdf', json: 'application/json', md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
};

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
async function readJson(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('Body too large'); }
  return s ? JSON.parse(s) : {};
}

async function sendFile(res, file, type, cache = 'private, max-age=3600') {
  const st = await fsp.stat(file);
  res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const m = p.match(/^\/api\/files\/(\d+)(?:\/(\w+))?$/);

  if (p === '/api/stats') return send(res, 200, { ...stats(url.searchParams.get('root') || DOWNLOADS_DIR, { subfolders: url.searchParams.get('subfolders') }), status: fullStatus(), downloads: DOWNLOADS_DIR, platform: LABELS });
  if (p === '/api/roots' && req.method === 'GET') return send(res, 200, getRoots());
  if (p === '/api/roots/pick' && req.method === 'POST') {
    // Show the system folder picker. null means cancelled.
    return send(res, 200, { path: await pickFolder() });
  }
  if (p === '/api/roots' && req.method === 'POST') {
    const b = await readJson(req);
    try {
      const roots = addRoot(b.path);
      watchAll(); refresh().catch(() => {});
      return send(res, 200, roots);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/roots/active' && req.method === 'POST') {
    const b = await readJson(req);
    try { return send(res, 200, setRootActive(b.path, !!b.active)); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/roots/remove' && req.method === 'POST') {
    const b = await readJson(req);
    try { const roots = removeRoot(b.path); watchAll(); return send(res, 200, roots); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/status') return send(res, 200, fullStatus());
  if (p === '/api/files') {
    const q = Object.fromEntries(url.searchParams);
    return send(res, 200, searchFiles({ ...q, starred: q.starred === '1' }));
  }
  if (m) {
    const f = getFile(m[1], { withContent: !m[2] });
    if (!f) return send(res, 404, { error: 'This file is not in the index. It may have moved. Reindex and try again.' });
    const action = m[2];
    if (!action && req.method === 'GET') {
      if (f.content) f.content = f.content.slice(0, 20_000);
      return send(res, 200, f);
    }
    if (action === 'thumb') {
      if (f.ext === 'svg') return sendFile(res, f.path, MIME.svg);
      try { const t = await thumbnail(f); return sendFile(res, t, t.endsWith('.png') ? MIME.png : MIME.jpg); } catch { return send(res, 404, { error: 'No preview' }); }
    }
    if (action === 'raw' && f.dataless) return send(res, 409, { error: `This file is online-only. Open it in ${LABELS.fileManager} to download it first.` });
    if (action === 'raw') {
      if (!fs.existsSync(f.path)) return send(res, 404, { error: 'File not found on disk' });
      return sendFile(res, f.path, MIME[f.ext]);
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
    const body = await readJson(req);
    if (action === 'star') return send(res, 200, setStar(f.id, !!body.starred));
    if (action === 'tags') return send(res, 200, setTags(f.id, body.tags || []));
    if (action === 'reveal') { await reveal(f.path); return send(res, 200, { ok: true }); }
    if (action === 'open') { await openPath(f.path); return send(res, 200, { ok: true }); }
    if (action === 'trash') {
      // The Trash or Recycle Bin, so the file can be put back. Never a permanent delete.
      if (fs.existsSync(f.path)) {
        try { await moveToTrash(f.path, 30_000); } catch (e) {
          return send(res, 500, { error: `Could not move the file to the ${LABELS.trash}: ${String(e.stderr || e.message).trim()}` });
        }
      }
      deleteRow(f.id);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Unknown action' });
  }
  // ---------- naming ----------
  const scopeOf = (o) => ({ root: o.root || DOWNLOADS_DIR, folder: o.folder === '__loose' ? null : (o.folder || undefined) });
  if (p === '/api/naming/count') {
    const r = findUnnamed({ ...scopeOf(Object.fromEntries(url.searchParams)), limit: 100000 });
    return send(res, 200, { count: r.files.length, skippedProject: r.skippedProject });
  }
  if (p === '/api/naming/start' && req.method === 'POST') {
    const b = await readJson(req);
    try { return send(res, 200, startNaming({ ...scopeOf(b), limit: Math.min(Number(b.limit) || 40, 200) })); } catch (e) { return send(res, 409, { error: e.message }); }
  }
  const nj = p.match(/^\/api\/naming\/([0-9a-f-]{36})(\/cancel)?$/);
  if (nj) {
    const job = nj[2] ? cancelJob(nj[1]) : getJob(nj[1]);
    return job ? send(res, 200, job) : send(res, 404, { error: 'This naming job is gone. Start a new one.' });
  }
  if (p === '/api/naming/apply' && req.method === 'POST') {
    const b = await readJson(req);
    const job = getJob(b.job_id);
    if (!job) return send(res, 404, { error: 'This naming job is gone. Start a new one.' });
    const wanted = new Map((b.renames || []).map((r) => [Number(r.file_id), r.new_name]));
    const chosen = [];
    for (const pr of job.proposals) {
      if (!wanted.has(pr.file_id)) continue;
      const ext = path.extname(pr.old_name).slice(1);
      const n = cleanName(wanted.get(pr.file_id), ext);
      if (n) chosen.push({ ...pr, new_name: `${n}${ext ? '.' + ext : ''}` });
    }
    if (!chosen.length) return send(res, 400, { error: 'No names chosen.' });
    const r = await applyPlan(planFromProposals(chosen));
    refresh().catch(() => {});
    return send(res, 200, r);
  }

  // ---------- folders ----------
  if (p.startsWith('/api/folders/')) {
    const o = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJson(req);
    const roots = getRoots();
    const root = roots.find((r) => r.path === o.root);
    if (!root || !o.folder || o.folder === '__loose' || /[\\/]/.test(o.folder) || o.folder.startsWith('.')) return send(res, 400, { error: 'Choose a folder from the list.' });
    const dir = path.join(root.path, o.folder);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 404, { error: 'This folder no longer exists. Reindex and try again.' });
    if (p === '/api/folders/info') {
      const children = fs.readdirSync(dir).filter((n) => n !== '.DS_Store');
      const { getDb } = await import('./db.mjs');
      const agg = getDb().prepare('SELECT count(*) n, sum(size) bytes, sum(starred) starred FROM files WHERE root = ? AND folder = ?').get(root.path, o.folder);
      return send(res, 200, { path: dir, name: o.folder, children: children.length, files: agg.n, bytes: agg.bytes || 0, starred: agg.starred || 0 });
    }
    if (p === '/api/folders/reveal' && req.method === 'POST') { await reveal(dir); return send(res, 200, { ok: true }); }
    if (p === '/api/folders/trash-contents' && req.method === 'POST') {
      if (o.confirm !== o.folder) return send(res, 400, { error: 'Type the folder name exactly to confirm.' });
      const children = fs.readdirSync(dir).filter((n) => !SKIP_FILES.has(n.toLowerCase())).map((n) => path.join(dir, n));
      let moved = 0; const failed = [];
      for (let i = 0; i < children.length; i += 50) {
        const chunk = children.slice(i, i + 50);
        try { await moveToTrash(chunk); moved += chunk.length; } catch (e) {
          // retry one by one so one locked file does not stop the rest
          for (const c of chunk) { try { await moveToTrash(c); moved++; } catch (e2) { failed.push(path.basename(c)); } }
        }
      }
      refresh().catch(() => {});
      return send(res, 200, { moved, failed });
    }
    return send(res, 404, { error: 'Unknown folder action' });
  }

  // ---------- bulk ----------
  if (p === '/api/bulk' && req.method === 'POST') {
    const b = await readJson(req);
    const ids = [...new Set((b.ids || []).map(Number))].slice(0, 5000);
    let done = 0; const failed = [];
    for (const id of ids) {
      const f = getFile(id);
      if (!f) continue;
      if (b.action === 'star' || b.action === 'unstar') { setStar(id, b.action === 'star'); done++; }
      else if (b.action === 'trash') {
        try { if (fs.existsSync(f.path)) await moveToTrash(f.path, 30_000); deleteRow(id); done++; } catch { failed.push(f.name); }
      } else return send(res, 400, { error: 'Unknown action' });
    }
    return send(res, 200, { done, failed });
  }

  if (p === '/api/reindex' && req.method === 'POST') { refresh().catch(() => {}); return send(res, 202, fullStatus()); }
  if (p === '/api/organize/plan' && req.method === 'POST') { await refresh(); return send(res, 200, createPlan()); }
  if (p === '/api/organize/apply' && req.method === 'POST') {
    const b = await readJson(req);
    const r = await applyPlan(b.plan_id, { exclude: b.exclude || [], overrides: b.overrides || {} });
    refresh().catch(() => {});
    return send(res, 200, r);
  }
  if (p === '/api/organize/undo' && req.method === 'POST') {
    const b = await readJson(req);
    const r = await undoBatch(b.batch_id);
    refresh().catch(() => {});
    return send(res, 200, r);
  }
  if (p === '/api/organize/history') return send(res, 200, history());

  // static files
  const rel = p === '/' ? 'index.html' : p.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return sendFile(res, file, MIME[path.extname(file).slice(1)], 'no-cache'); // app files: always check for updates
  }
  return send(res, 404, { error: 'Not found' });
}

ensureDirs();
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, { error: String(e.message || e) }));
});
server.listen(PORT, HOST, () => {
  console.log(`2ndBrain is running at http://localhost:${PORT}  (indexing ${getRoots().map((r) => r.path).join(', ')})`);
  refresh().then((r) => console.log(`Indexed ${r.total} items`)).catch((e) => console.error('Index failed:', e.message));
  watchAll();
  // Folders can also be added from Claude Code (another process). Pick up list changes.
  let known = JSON.stringify(getRoots().map((r) => r.path));
  setInterval(() => {
    const now = JSON.stringify(getRoots().map((r) => r.path));
    if (now !== known) { known = now; watchAll(); refresh().catch(() => {}); }
  }, 30_000);
});
