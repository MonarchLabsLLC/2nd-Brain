import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const home = os.homedir();

export const DOWNLOADS_DIR = path.resolve(process.env.SECONDBRAIN_DOWNLOADS || path.join(home, 'Downloads'));
export const DATA_DIR = path.resolve(
  process.env.SECONDBRAIN_DATA || path.join(home, 'Library', 'Application Support', '2ndBrain'),
);
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
]);
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
