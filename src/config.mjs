import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const home = os.homedir();
const IS_WIN = process.platform === 'win32';

/** Windows lets people move Downloads (often into OneDrive). The real place is in the registry. */
function windowsDownloads() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v', '{374DE290-123F-4565-9164-39C4925E467B}'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/m);
    if (m) {
      const p = m[1].trim().replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all);
      if (path.isAbsolute(p) && fs.existsSync(p)) return p;
    }
  } catch { /* fall back to the usual place */ }
  return path.join(home, 'Downloads');
}

function defaultDataDir() {
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), '2ndBrain');
  return path.join(home, 'Library', 'Application Support', '2ndBrain');
}

export const DOWNLOADS_DIR = path.resolve(process.env.SECONDBRAIN_DOWNLOADS || (IS_WIN ? windowsDownloads() : path.join(home, 'Downloads')));
export const DATA_DIR = path.resolve(process.env.SECONDBRAIN_DATA || defaultDataDir());
export const DB_PATH = path.join(DATA_DIR, 'index.sqlite');
export const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
// Optional personal settings, for example your own Organize folder names. See README.
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
export const PORT = Number(process.env.SECONDBRAIN_PORT || 4321);
export const HOST = '127.0.0.1';

// Folders never descended into while indexing.
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.venv', 'venv', '__pycache__', '.next', '.cache',
  '.turbo', '.parcel-cache', '.idea', '.vscode', 'Pods', 'DerivedData',
  '$RECYCLE.BIN', 'System Volume Information',
]);
// System files that are never indexed and do not count when deciding whether a folder is empty (lower case).
export const SKIP_FILES = new Set(['.ds_store', 'desktop.ini', 'thumbs.db', 'ehthumbs.db']);
// Folder suffixes indexed as one item (macOS bundles).
export const BUNDLE_SUFFIXES = ['.app', '.bundle', '.framework', '.photoslibrary', '.fcpbundle', '.fcproj', '.rtfd', '.pages', '.numbers', '.key', '.xcodeproj'];
export const MAX_DEPTH = 8;
export const MAX_TEXT_BYTES = 200_000;
export const PARTIAL_SUFFIXES = ['.crdownload', '.download', '.part', '.partial', '.tmp'];
// Files changed this recently are left alone by Organize.
export const ORGANIZE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

let settingsCache = { mtime: -1, value: {} };
/** Read settings.json from the data folder. Returns {} if it is missing or not valid JSON. */
export function loadSettings() {
  try {
    const mtime = fs.statSync(SETTINGS_PATH).mtimeMs;
    if (mtime !== settingsCache.mtime) settingsCache = { mtime, value: JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) || {} };
  } catch { settingsCache = { mtime: -1, value: {} }; }
  return settingsCache.value;
}
