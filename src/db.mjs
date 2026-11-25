import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DOWNLOADS_DIR, ensureDirs } from './config.mjs';

let db;

export function getDb(dbPath = DB_PATH) {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      root TEXT,                -- the indexed location this file belongs to
      rel_path TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      folder TEXT,              -- top-level subfolder of Downloads, NULL for loose files
      is_bundle INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      birthtime INTEGER NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      width INTEGER,
      height INTEGER,
      has_alpha INTEGER,
      source_url TEXT,
      content TEXT,
      enriched INTEGER NOT NULL DEFAULT 0,
      starred INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '',
      seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_category ON files(category, subcategory);
    CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime);
    CREATE INDEX IF NOT EXISTS files_folder ON files(folder);

    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      name, rel_path, source_url, tags, content,
      content='files', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, name, rel_path, source_url, tags, content)
      VALUES (new.id, new.name, new.rel_path, new.source_url, new.tags, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, name, rel_path, source_url, tags, content)
      VALUES ('delete', old.id, old.name, old.rel_path, old.source_url, old.tags, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, name, rel_path, source_url, tags, content)
      VALUES ('delete', old.id, old.name, old.rel_path, old.source_url, old.tags, old.content);
      INSERT INTO files_fts(rowid, name, rel_path, source_url, tags, content)
      VALUES (new.id, new.name, new.rel_path, new.source_url, new.tags, new.content);
    END;

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      items TEXT NOT NULL,      -- JSON array of {file_id, from, to}
      applied_batch TEXT
    );
    CREATE TABLE IF NOT EXISTS moves (
      id INTEGER PRIMARY KEY,
      batch_id TEXT NOT NULL,
      file_id INTEGER,
      from_path TEXT NOT NULL,
      to_path TEXT NOT NULL,
      moved_at INTEGER NOT NULL,
      undone_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS moves_batch ON moves(batch_id);

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  // Migration: indexes made before multi-folder support have no root column.
  const cols = db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
  if (!cols.includes('root')) {
    db.exec('ALTER TABLE files ADD COLUMN root TEXT');
  }
  if (!cols.includes('dataless')) {
    // Cloud "online-only" files (Dropbox, iCloud). Never read, or the provider downloads them.
    db.exec('ALTER TABLE files ADD COLUMN dataless INTEGER NOT NULL DEFAULT 0');
  }
  db.prepare('UPDATE files SET root = ? WHERE root IS NULL').run(DOWNLOADS_DIR);
  db.exec('CREATE INDEX IF NOT EXISTS files_root ON files(root, folder)');
  return db;
}

/** Close the database. Windows cannot delete a database file that is still open. */
export function closeDb() {
  if (db) { db.close(); db = undefined; }
}

export function getMeta(key) {
  return getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}
export function setMeta(key, value) {
  getDb().prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}
