import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb, tx, setMeta, getMeta } from './db.mjs';
import { getRoots } from './roots.mjs';
import {
  DOWNLOADS_DIR, SKIP_DIRS, SKIP_FILES, BUNDLE_SUFFIXES, MAX_DEPTH, MAX_TEXT_BYTES,
} from './config.mjs';
import {
  extOf, categoryOf, imageSubcategory, PLAIN_TEXT_EXT, TEXTUTIL_EXT, SIPS_EXT,
} from './classify.mjs';
import { relInfo } from './paths.mjs';
import { imageInfo, onlineOnlySet, downloadSources, extractRichText } from './platform/index.mjs';

const run = promisify(execFile);
const EXEC_OPTS = { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true };

export const status = { running: false, phase: 'idle', done: 0, total: 0, percent: null, etaSeconds: null, startedAt: null, lastScanAt: null, lastDurationMs: null, lastError: null, files: 0, location: null };

/** Walk Downloads and yield every indexable item. */
async function walk(root) {
  const out = [];
  async function visit(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip it
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_FILES.has(e.name.toLowerCase())) continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (BUNDLE_SUFFIXES.some((s) => e.name.toLowerCase().endsWith(s))) {
          out.push({ full, bundle: true });
          continue;
        }
        if (depth < MAX_DEPTH) await visit(full, depth + 1);
      } else if (e.isFile()) {
        out.push({ full, bundle: false });
      }
    }
  }
  await visit(root, 0);
  return out;
}


/**
 * Fast pass: stat every item, insert new rows, flag changed rows for enrichment,
 * remove rows whose file is gone.
 */
export async function scanFast(root = DOWNLOADS_DIR) {
  const db = getDb();
  const scanId = Date.now();
  const items = await walk(root);
  const existing = new Map();
  for (const r of db.prepare('SELECT id, path, size, mtime FROM files WHERE root = ?').all(root)) existing.set(r.path, r);

  const insert = db.prepare(`INSERT INTO files
    (path, root, rel_path, name, ext, folder, is_bundle, size, mtime, birthtime, category, subcategory, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE files SET size = ?, mtime = ?, enriched = 0, seen_at = ? WHERE id = ?`);
  const touch = db.prepare('UPDATE files SET seen_at = ? WHERE id = ?');

  let added = 0; let changed = 0;
  const stats = await Promise.all(items.map(async (it) => {
    try { return [it, await fsp.stat(it.full)]; } catch { return null; }
  }));

  tx(() => {
    for (const s of stats) {
      if (!s) continue;
      const [it, st] = s;
      const size = it.bundle ? 0 : st.size;
      const mtime = Math.round(st.mtimeMs);
      const prev = existing.get(it.full);
      if (!prev) {
        const name = path.basename(it.full);
        const ext = extOf(name);
        const { rel, folder } = relInfo(it.full, root);
        const category = categoryOf(ext, it.bundle);
        const sub = category === 'image' ? imageSubcategory({ name, ext }) : null;
        insert.run(it.full, root, rel, name, ext, folder, it.bundle ? 1 : 0, size, mtime,
          Math.round(st.birthtimeMs || st.mtimeMs), category, sub, scanId);
        added++;
      } else if (prev.size !== size || prev.mtime !== mtime) {
        update.run(size, mtime, scanId, prev.id);
        changed++;
      } else {
        touch.run(scanId, prev.id);
      }
    }
  });
  // Remove rows for files that are gone, but only if the folder itself is still there
  // (an unplugged drive must not wipe its stars and tags).
  const removed = fs.existsSync(root) ? db.prepare('DELETE FROM files WHERE root = ? AND seen_at < ?').run(root, scanId).changes : 0;
  setMeta('last_fast_scan', scanId);
  return { added, changed, removed, total: stats.filter(Boolean).length };
}

// Never store the text of files that look like secrets.
const SECRET_NAME_RE = /(^|[._\-\s])(env|secrets?|credentials?|passwords?|tokens?|api[-_ ]?keys?|private[-_ ]?key|id_rsa|id_ed25519)([._\-\s]|$)|\.(pem|key|p12|pfx|keystore)$/i;
export const looksSecret = (name) => SECRET_NAME_RE.test(name);

async function readText(full, ext, size) {
  if (looksSecret(path.basename(full))) return null;
  try {
    if (PLAIN_TEXT_EXT.has(ext) && !TEXTUTIL_EXT.has(ext)) {
      const fh = await fsp.open(full, 'r');
      try {
        const buf = Buffer.alloc(Math.min(size, MAX_TEXT_BYTES));
        await fh.read(buf, 0, buf.length, 0);
        const s = buf.toString('utf8');
        if (s.includes('\u0000')) return null; // binary
        return s;
      } finally { await fh.close(); }
    }
    if (ext === 'pdf' && size < 100 * 1024 * 1024) {
      const { stdout } = await run('pdftotext', ['-l', '5', '-q', full, '-'], { ...EXEC_OPTS, timeout: 15_000 });
      return stdout.slice(0, MAX_TEXT_BYTES);
    }
    if (TEXTUTIL_EXT.has(ext) && size < 50 * 1024 * 1024) {
      return (await extractRichText(full, ext)).slice(0, MAX_TEXT_BYTES);
    }
  } catch { /* unreadable: index by name only */ }
  return null;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

/** Slow pass: image size, download URL and text content for new or changed files. */
export async function enrich({ onProgress } = {}) {
  const db = getDb();
  const rows = db.prepare('SELECT id, path, name, ext, size, category, is_bundle FROM files WHERE enriched = 0 ORDER BY folder IS NOT NULL, mtime DESC').all();
  const upd = db.prepare(`UPDATE files SET width = ?, height = ?, has_alpha = ?, subcategory = ?,
    source_url = ?, content = ?, dataless = ?, enriched = 1 WHERE id = ?`);
  let done = 0;
  const BATCH = 150;
  for (let b = 0; b < rows.length; b += BATCH) {
    const all = rows.slice(b, b + BATCH);
    const offline = await onlineOnlySet(all.filter((r) => !r.is_bundle).map((r) => r.path));
    const batch = all.filter((r) => !offline.has(r.path));
    const imgPaths = batch.filter((r) => r.category === 'image' && SIPS_EXT.has(r.ext)).map((r) => r.path);
    const [dims, froms] = await Promise.all([imageInfo(imgPaths), downloadSources(batch.map((r) => r.path))]);
    const texts = new Map();
    await pool(batch.filter((r) => !r.is_bundle), 6, async (r) => {
      const t = await readText(r.path, r.ext, r.size);
      if (t) texts.set(r.id, t.replace(/\s+\n/g, '\n'));
    });
    tx(() => {
      for (const r of all) {
        if (offline.has(r.path)) {
          const sub = r.category === 'image' ? imageSubcategory({ name: r.name, ext: r.ext }) : null;
          upd.run(null, null, null, sub, null, null, 1, r.id);
          continue;
        }
        const d = dims.get(r.path) || {};
        const sub = r.category === 'image'
          ? imageSubcategory({ name: r.name, ext: r.ext, width: d.width, height: d.height, hasAlpha: d.hasAlpha })
          : null;
        upd.run(d.width ?? null, d.height ?? null, d.hasAlpha ?? null, sub, froms.get(r.path) ?? null, texts.get(r.id) ?? null, 0, r.id);
      }
    });
    done += all.length;
    onProgress?.(done, rows.length);
  }
  return { enriched: rows.length };
}

let current = null; let again = false;
/** Full refresh: fast scan, then enrichment. Only one runs at a time per process. */
export function refresh(only) {
  if (current) { again = true; return current; } // run once more when this scan ends
  const roots = only ? [only] : getRoots().filter((r) => !r.missing).map((r) => r.path);
  current = (async () => {
    status.running = true; status.lastError = null; status.startedAt = Date.now();
    try {
      status.phase = 'scanning'; status.done = 0; status.total = 0; status.percent = null; status.etaSeconds = null;
      const r = { total: 0, added: 0, changed: 0, removed: 0 };
      for (const root of roots) {
        status.location = path.basename(root);
        const x = await scanFast(root);
        for (const k of Object.keys(r)) r[k] += x[k];
      }
      status.phase = 'enriching'; status.location = null;
      const t0 = Date.now();
      await enrich({ onProgress: (d, t) => {
        status.done = d; status.total = t;
        status.percent = t ? Math.round((d / t) * 100) : 100;
        const rate = d / Math.max(1, Date.now() - t0); // files per ms
        status.etaSeconds = rate > 0 ? Math.round((t - d) / rate / 1000) : null;
      } });
      status.lastScanAt = Date.now();
      status.lastDurationMs = status.lastScanAt - status.startedAt;
      status.files = r.total;
      setMeta('last_full_scan', status.lastScanAt);
      return r;
    } catch (e) {
      status.lastError = String(e?.message || e);
      throw e;
    } finally {
      status.running = false; status.phase = 'idle'; status.percent = null; status.etaSeconds = null; current = null;
      if (again) { again = false; setTimeout(() => refresh().catch(() => {}), 0); }
    }
  })();
  return current;
}

/** Status plus what is still waiting to be read (0 means fully indexed). */
export function fullStatus() {
  const db = getDb();
  const pending = db.prepare('SELECT count(*) n FROM files WHERE enriched = 0').get().n;
  const files = db.prepare('SELECT count(*) n FROM files').get().n;
  const lastScanAt = status.lastScanAt || Number(getMeta('last_full_scan') || 0) || null;
  return { ...status, files, pending, lastScanAt };
}

/** Refresh only if the last scan is older than maxAgeMs. Used by the MCP server. */
export async function ensureFresh(maxAgeMs = 60_000) {
  const last = Number(getMeta('last_full_scan') || 0);
  if (Date.now() - last > maxAgeMs) await refresh();
}

/** Watch every location and refresh shortly after changes. Call again after the list changes. */
let watchers = []; let interval = null; let timer = null;
export function watchAll({ debounceMs = 3000, onChange } = {}) {
  for (const w of watchers) w.close();
  watchers = [];
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { refresh().then(() => onChange?.()).catch(() => {}); }, debounceMs);
  };
  for (const r of getRoots()) {
    if (r.missing) continue;
    try {
      watchers.push(fs.watch(r.path, { recursive: true }, (_ev, name) => {
        if (name && name.split(path.sep).some((p) => p.startsWith('.') || SKIP_DIRS.has(p))) return;
        trigger();
      }));
    } catch { /* folder not watchable; the 10-minute rescan still covers it */ }
  }
  clearInterval(interval);
  interval = setInterval(trigger, 10 * 60 * 1000); // safety net
}
