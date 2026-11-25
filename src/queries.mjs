import { getDb } from './db.mjs';
import { CATEGORY_LABELS, IMAGE_SUB_LABELS } from './classify.mjs';
import { getRoots, activeRootPaths } from './roots.mjs';
import { DOWNLOADS_DIR } from './config.mjs';

const LIST_COLS = `f.id, f.path, f.root, f.rel_path, f.name, f.ext, f.folder, f.is_bundle, f.size, f.mtime, f.birthtime,
  f.category, f.subcategory, f.width, f.height, f.has_alpha, f.source_url, f.starred, f.tags, f.dataless`;

/** Turn free text into a safe FTS5 query: every word must match, as a prefix. */
export function ftsQuery(q) {
  const tokens = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.slice(0, 12).map((t) => `"${t}"*`).join(' ');
}

function parseTags(s) { return s ? s.split(',').filter(Boolean) : []; }
function shape(r) { return r && { ...r, tags: parseTags(r.tags), starred: !!r.starred, is_bundle: !!r.is_bundle, dataless: !!r.dataless, has_alpha: r.has_alpha == null ? null : !!r.has_alpha }; }

/**
 * @param {object} o
 * @param {string} [o.q] free-text search over name, path, source URL, tags and content
 * @param {string} [o.category] image|markdown|text|pdf|office|data|code|video|audio|archive|installer|font|other
 * @param {string} [o.subcategory] for images: logo|screenshot|photo|graphic
 * @param {string} [o.root] limit to one indexed location (absolute path)
 * @param {string} [o.folder] top-level subfolder name, or "__loose" for files directly in Downloads
 * @param {string} [o.ext]
 * @param {string} [o.tag]
 * @param {boolean} [o.starred]
 * @param {number} [o.since] epoch ms, modified on or after
 * @param {'relevance'|'newest'|'oldest'|'name'|'largest'} [o.sort]
 */
export function searchFiles(o = {}) {
  const db = getDb();
  const where = []; const args = [];
  const fts = ftsQuery(o.q);
  if (o.root) { where.push('f.root = ?'); args.push(o.root); } // an explicit location always shows
  else { const act = activeRootPaths(); where.push(`f.root IN (${act.map(() => '?').join(',') || 'NULL'})`); args.push(...act); }
  if (o.category) { where.push('f.category = ?'); args.push(o.category); }
  if (o.subcategory) { where.push('f.subcategory = ?'); args.push(o.subcategory); }
  if (o.folder === '__loose') where.push('f.folder IS NULL');
  else if (o.folder) { where.push('f.folder = ?'); args.push(o.folder); }
  if (o.ext) { where.push('f.ext = ?'); args.push(String(o.ext).replace(/^\./, '').toLowerCase()); }
  if (o.tag) { where.push("(',' || f.tags || ',') LIKE ?"); args.push(`%,${String(o.tag).toLowerCase()},%`); }
  if (o.starred) where.push('f.starred = 1');
  if (o.since) { where.push('f.mtime >= ?'); args.push(Number(o.since)); }
  const limit = Math.min(Math.max(Number(o.limit) || 60, 1), 500);
  const offset = Math.max(Number(o.offset) || 0, 0);
  const sort = o.sort || (fts ? 'relevance' : 'newest');
  const order = {
    relevance: fts ? 'rank' : 'f.mtime DESC',
    newest: 'f.mtime DESC', oldest: 'f.mtime ASC', name: 'f.name COLLATE NOCASE ASC', largest: 'f.size DESC',
  }[sort] || 'f.mtime DESC';

  let sql; let countSql;
  const w = where.length ? `AND ${where.join(' AND ')}` : '';
  if (fts) {
    sql = `SELECT ${LIST_COLS}, bm25(files_fts, 10.0, 4.0, 2.0, 8.0, 1.0) AS rank,
             snippet(files_fts, 4, '«', '»', '…', 14) AS snippet
           FROM files_fts JOIN files f ON f.id = files_fts.rowid
           WHERE files_fts MATCH ? ${w} ORDER BY ${order} LIMIT ? OFFSET ?`;
    countSql = `SELECT count(*) n FROM files_fts JOIN files f ON f.id = files_fts.rowid WHERE files_fts MATCH ? ${w}`;
    args.unshift(fts);
  } else {
    sql = `SELECT ${LIST_COLS} FROM files f WHERE 1=1 ${w} ORDER BY ${order} LIMIT ? OFFSET ?`;
    countSql = `SELECT count(*) n FROM files f WHERE 1=1 ${w}`;
  }
  const total = db.prepare(countSql).get(...args).n;
  const items = db.prepare(sql).all(...args, limit, offset).map((r) => {
    const s = shape(r);
    if (s.snippet && !s.snippet.includes('«')) delete s.snippet;
    delete s.rank;
    return s;
  });
  return { total, items };
}

export function getFile(id, { withContent = false } = {}) {
  const r = getDb().prepare(`SELECT ${LIST_COLS}${withContent ? ', f.content' : ''} FROM files f WHERE f.id = ?`).get(Number(id));
  return shape(r) || null;
}

export function getFileByPath(p) {
  const r = getDb().prepare(`SELECT ${LIST_COLS} FROM files f WHERE f.path = ?`).get(p);
  return shape(r) || null;
}

export function setStar(id, starred) {
  getDb().prepare('UPDATE files SET starred = ? WHERE id = ?').run(starred ? 1 : 0, Number(id));
  return getFile(id);
}

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase().replace(/[,\s]+/g, '-')).filter(Boolean))].slice(0, 30);
}

export function setTags(id, tags) {
  getDb().prepare('UPDATE files SET tags = ? WHERE id = ?').run(normalizeTags(tags).join(','), Number(id));
  return getFile(id);
}

export function addTags(id, tags) {
  const f = getFile(id);
  if (!f) return null;
  return setTags(id, [...f.tags, ...normalizeTags(tags)]);
}

export function deleteRow(id) {
  getDb().prepare('DELETE FROM files WHERE id = ?').run(Number(id));
}

/** @param {string} [folderRoot] location whose top-level folders are listed (default Downloads) */
export function stats(folderRoot = DOWNLOADS_DIR) {
  const db = getDb();
  const act = activeRootPaths();
  const inAct = `root IN (${act.map(() => '?').join(',') || 'NULL'})`;
  const cats = db.prepare(`SELECT category, count(*) n, sum(size) bytes FROM files WHERE ${inAct} GROUP BY category ORDER BY category = 'other', n DESC`).all(...act);
  const subs = db.prepare(`SELECT subcategory, count(*) n FROM files WHERE category = 'image' AND ${inAct} GROUP BY subcategory`).all(...act);
  const folders = db.prepare('SELECT folder, count(*) n FROM files WHERE root = ? AND folder IS NOT NULL GROUP BY folder ORDER BY folder COLLATE NOCASE').all(folderRoot);
  const t = db.prepare(`SELECT count(*) n, sum(size) bytes, sum(folder IS NULL AND root = ?) loose, sum(starred) starred FROM files WHERE ${inAct}`).get(DOWNLOADS_DIR, ...act);
  const perRoot = new Map(db.prepare('SELECT root, count(*) n FROM files GROUP BY root').all().map((r) => [r.root, r.n]));
  const roots = getRoots().map((r) => ({ ...r, n: perRoot.get(r.path) || 0 }));
  const tags = db.prepare(`SELECT tags FROM files WHERE tags != '' AND ${inAct}`).all(...act);
  const tagCounts = {};
  for (const r of tags) for (const tg of r.tags.split(',')) tagCounts[tg] = (tagCounts[tg] || 0) + 1;
  return {
    total: t.n, bytes: t.bytes || 0, loose: t.loose || 0, starred: t.starred || 0,
    categories: cats.map((c) => ({ ...c, label: CATEGORY_LABELS[c.category] || c.category })),
    imageSubs: subs.map((s) => ({ ...s, label: IMAGE_SUB_LABELS[s.subcategory] || s.subcategory })),
    folders, folderRoot, roots,
    tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([tag, n]) => ({ tag, n })),
  };
}
