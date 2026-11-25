// Indexed locations. Downloads is always first and is the only one Organize changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, getMeta, setMeta } from './db.mjs';
import { DOWNLOADS_DIR } from './config.mjs';
import { IS_WIN, samePath, isInsideOrSame } from './paths.mjs';

const BLOCKED = IS_WIN
  ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.ProgramData || 'C:\\ProgramData']
  : ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/opt', '/cores', '/dev'];

function label(p) {
  return p === DOWNLOADS_DIR ? 'Downloads' : path.basename(p);
}

function stored() {
  try { return JSON.parse(getMeta('roots') || '[]').filter((p) => typeof p === 'string'); } catch { return []; }
}

function inactive() {
  try { return new Set(JSON.parse(getMeta('inactive_roots') || '[]')); } catch { return new Set(); }
}

/** @returns {{path:string, label:string, organize:boolean, missing:boolean, active:boolean}[]} */
export function getRoots() {
  const list = [DOWNLOADS_DIR, ...stored().filter((p) => p !== DOWNLOADS_DIR)];
  const off = inactive();
  return list.map((p) => ({ path: p, label: label(p), organize: p === DOWNLOADS_DIR, missing: !fs.existsSync(p), active: !off.has(p) }));
}

/** Paths whose files appear in search. A switched-off location stays indexed but hidden. */
export function activeRootPaths() {
  return getRoots().filter((r) => r.active).map((r) => r.path);
}

export function setRootActive(p, active) {
  const all = getRoots();
  const hit = all.find((r) => samePath(r.path, p));
  if (!hit) throw new Error('This folder is not in the list.');
  p = hit.path;
  const off = inactive();
  if (active) off.delete(p); else off.add(p);
  setMeta('inactive_roots', JSON.stringify([...off]));
  return getRoots();
}

const inside = isInsideOrSame;

/** Check a folder before it is added. Returns the clean absolute path. */
export function validateRoot(input) {
  let p = String(input || '').trim();
  if (!p) throw new Error('Choose a folder.');
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  p = path.resolve(p); // resolve() already drops a trailing slash
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`This is not a folder: ${p}`);
  if (IS_WIN) p = fs.realpathSync.native(p); // the real upper/lower case, so one folder is never added twice
  if (path.parse(p).root === p || samePath(p, os.homedir())) throw new Error('This folder is too large. Choose a folder inside it, such as Desktop or Documents.');
  if (BLOCKED.some((b) => inside(p, b))) throw new Error('System folders cannot be added.');
  for (const r of getRoots()) {
    if (inside(p, r.path)) throw new Error(`This folder is already included in ${r.label}.`);
    if (inside(r.path, p)) throw new Error(`This folder contains ${r.label}, which is already added. Remove ${r.label} first, or choose another folder.`);
  }
  return p;
}

export function addRoot(input) {
  const p = validateRoot(input);
  setMeta('roots', JSON.stringify([...stored(), p]));
  return getRoots();
}

/** Stop indexing a location. Files on disk are not touched. */
export function removeRoot(p) {
  if (samePath(p, DOWNLOADS_DIR)) throw new Error('Downloads cannot be removed.');
  const hit = stored().find((x) => samePath(x, p));
  if (!hit) throw new Error('This folder is not in the list.');
  p = hit;
  setMeta('roots', JSON.stringify(stored().filter((x) => x !== p)));
  setMeta('inactive_roots', JSON.stringify([...inactive()].filter((x) => x !== p)));
  getDb().prepare('DELETE FROM files WHERE root = ?').run(p);
  return getRoots();
}
