import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, tx } from './db.mjs';
import { DOWNLOADS_DIR, ORGANIZE_MIN_AGE_MS, PARTIAL_SUFFIXES } from './config.mjs';
import { organizeTarget } from './classify.mjs';

/**
 * Build a move plan for loose files directly in Downloads. Nothing moves here.
 * Subfolders stay as they are; their files are indexed but not moved.
 */
export function createPlan({ root = DOWNLOADS_DIR, now = Date.now() } = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT id, path, name, category, subcategory, mtime, size, is_bundle
    FROM files WHERE root = ? AND folder IS NULL ORDER BY category, subcategory, name COLLATE NOCASE`).all(root);
  const items = []; const skipped = [];
  for (const r of rows) {
    const lower = r.name.toLowerCase();
    if (PARTIAL_SUFFIXES.some((s) => lower.endsWith(s))) { skipped.push({ file_id: r.id, name: r.name, reason: 'partial download' }); continue; }
    if (r.is_bundle && r.category !== 'installer') { skipped.push({ file_id: r.id, name: r.name, reason: 'bundle' }); continue; }
    if (now - r.mtime < ORGANIZE_MIN_AGE_MS) { skipped.push({ file_id: r.id, name: r.name, reason: 'changed in the last 24 hours' }); continue; }
    const target = organizeTarget(r);
    if (!target) { skipped.push({ file_id: r.id, name: r.name, reason: 'unknown type' }); continue; }
    items.push({ file_id: r.id, name: r.name, from: r.path, to_dir: target, category: r.category, subcategory: r.subcategory, size: r.size });
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO plans(id, created_at, items) VALUES (?, ?, ?)').run(id, now, JSON.stringify(items));
  const groups = {};
  for (const it of items) groups[it.to_dir] = (groups[it.to_dir] || 0) + 1;
  return {
    plan_id: id, root, count: items.length,
    groups: Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([to_dir, n]) => ({ to_dir, n })),
    items, skipped,
  };
}

function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name); const base = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 10_000; i++) {
    dest = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
  throw new Error(`No free name for ${name}`);
}

function updatePath(fileId, newPath, fallbackRoot) {
  // Each file keeps the location (root) it was indexed under.
  const root = getDb().prepare('SELECT root FROM files WHERE id = ?').get(fileId)?.root || fallbackRoot;
  const rel = path.relative(root, newPath);
  const parts = rel.split(path.sep);
  getDb().prepare('UPDATE files SET path = ?, rel_path = ?, name = ?, folder = ? WHERE id = ?')
    .run(newPath, rel, path.basename(newPath), parts.length > 1 ? parts[0] : null, fileId);
}

/**
 * Apply a plan. Moves files only; never deletes or overwrites.
 * @param {string} planId
 * @param {{exclude?: number[], overrides?: Record<string,string>, root?: string}} opts
 *   overrides maps file_id to a folder relative to Downloads.
 */
export async function applyPlan(planId, { exclude = [], overrides = {}, root = DOWNLOADS_DIR } = {}) {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) throw new Error('Plan not found. Make a new plan.');
  if (plan.applied_batch) throw new Error('This plan was already applied.');
  const skip = new Set(exclude.map(Number));
  const items = JSON.parse(plan.items).filter((it) => !skip.has(it.file_id));
  const batchId = crypto.randomUUID();
  const logMove = db.prepare('INSERT INTO moves(batch_id, file_id, from_path, to_path, moved_at) VALUES (?, ?, ?, ?, ?)');
  const moved = []; const failed = [];
  for (const it of items) {
    try {
      const itemRoot = it.root || root;
      const toDirRel = overrides[it.file_id] ?? it.to_dir;
      const toDir = path.resolve(itemRoot, toDirRel);
      if (toDir !== itemRoot && !toDir.startsWith(itemRoot + path.sep)) throw new Error('Target must be inside the same location');
      if (!fs.existsSync(it.from)) throw new Error('File no longer exists');
      await fsp.mkdir(toDir, { recursive: true });
      const newName = it.to_name || path.basename(it.from);
      if (path.join(toDir, newName) === it.from) continue; // nothing to do
      const dest = uniqueDest(toDir, newName);
      await fsp.rename(it.from, dest);
      tx(() => {
        logMove.run(batchId, it.file_id, it.from, dest, Date.now());
        updatePath(it.file_id, dest, root);
      });
      moved.push({ file_id: it.file_id, from: it.from, to: dest });
    } catch (e) {
      failed.push({ file_id: it.file_id, from: it.from, error: String(e.message || e) });
    }
  }
  db.prepare('UPDATE plans SET applied_batch = ? WHERE id = ?').run(batchId, planId);
  return { batch_id: batchId, moved: moved.length, failed, moves: moved };
}

/** Put every file of a batch back where it was. */
export async function undoBatch(batchId, { root = DOWNLOADS_DIR } = {}) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM moves WHERE batch_id = ? AND undone_at IS NULL ORDER BY id DESC').all(batchId);
  if (!rows.length) throw new Error('Nothing to undo for this batch.');
  const mark = db.prepare('UPDATE moves SET undone_at = ? WHERE id = ?');
  let restored = 0; const failed = [];
  const touchedDirs = new Set();
  for (const m of rows) {
    try {
      if (!fs.existsSync(m.to_path)) throw new Error('File is no longer at its new place');
      const dest = fs.existsSync(m.from_path) ? uniqueDest(path.dirname(m.from_path), path.basename(m.from_path)) : m.from_path;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(m.to_path, dest);
      touchedDirs.add(path.dirname(m.to_path));
      tx(() => {
        mark.run(Date.now(), m.id);
        if (m.file_id) updatePath(m.file_id, dest, root);
      });
      restored++;
    } catch (e) {
      failed.push({ from: m.to_path, error: String(e.message || e) });
    }
  }
  // Remove folders that Organize made and that are now empty (only empty ones).
  const roots = getDb().prepare('SELECT DISTINCT root FROM files').all().map((r) => r.root).concat(root);
  for (let dir of touchedDirs) {
    const top = roots.find((r) => dir.startsWith(r + path.sep));
    while (top && dir.startsWith(top + path.sep)) {
      try {
        const left = (await fsp.readdir(dir)).filter((n) => n !== '.DS_Store');
        if (left.length) break;
        await fsp.rm(path.join(dir, '.DS_Store'), { force: true });
        await fsp.rmdir(dir);
      } catch { break; }
      dir = path.dirname(dir);
    }
  }
  return { batch_id: batchId, restored, failed };
}

export function history(limit = 20) {
  return getDb().prepare(`SELECT batch_id, min(moved_at) moved_at, count(*) n,
      sum(undone_at IS NOT NULL) undone
    FROM moves GROUP BY batch_id ORDER BY moved_at DESC LIMIT ?`).all(limit)
    .map((r) => ({ ...r, can_undo: r.undone < r.n }));
}
