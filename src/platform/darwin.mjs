// macOS: built-in tools (sips, mdls, qlmanage, textutil, trash, osascript, open).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const EXEC_OPTS = { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 };

export const LABELS = {
  os: 'mac',
  fileManager: 'Finder',
  trash: 'Trash',
  trashLong: 'the macOS Trash',
  putBack: 'You can put it back from the Trash in Finder.',
};

// ---------- image size ----------
/** Width, height and transparency for many images at once. Map of path -> {width, height, hasAlpha}. */
export async function imageInfo(paths) {
  const res = new Map();
  if (!paths.length) return res;
  try {
    const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', ...paths], EXEC_OPTS);
    let cur = null;
    for (const line of stdout.split('\n')) {
      if (!line.startsWith(' ') && line.trim()) {
        cur = { width: null, height: null, hasAlpha: null };
        res.set(line.trim(), cur);
      } else if (cur) {
        const m = line.match(/^\s+(\w+):\s*(.+)$/);
        if (!m) continue;
        if (m[1] === 'pixelWidth') cur.width = Number(m[2]) || null;
        if (m[1] === 'pixelHeight') cur.height = Number(m[2]) || null;
        if (m[1] === 'hasAlpha') cur.hasAlpha = m[2].trim() === 'yes' ? 1 : 0;
      }
    }
  } catch (e) {
    // One bad file can fail the whole batch; retry one by one.
    if (paths.length > 1) {
      for (const p of paths) for (const [k, v] of await imageInfo([p])) res.set(k, v);
    }
  }
  return res;
}

// ---------- online-only cloud files ----------
/** Online-only cloud files carry the SF_DATALESS flag (0x40000000). Reading them makes the provider download them. */
const SF_DATALESS = 0x40000000;
export async function onlineOnlySet(paths) {
  const out = new Set();
  if (!paths.length) return out;
  try {
    const { stdout } = await run('stat', ['-f', '%Xf', ...paths], EXEC_OPTS);
    stdout.trim().split('\n').forEach((hex, i) => { if (parseInt(hex, 16) & SF_DATALESS) out.add(paths[i]); });
  } catch {
    // a vanished file fails the batch; check one by one
    if (paths.length > 1) for (const p of paths) for (const x of await onlineOnlySet([p])) out.add(x);
  }
  return out;
}

// ---------- download links ----------
/** macOS records the download URL in Spotlight metadata. Map of path -> "url url". */
export async function downloadSources(paths) {
  const res = new Map();
  if (!paths.length) return res;
  try {
    const { stdout } = await run('mdls', ['-raw', '-name', 'kMDItemWhereFroms', ...paths], EXEC_OPTS);
    const values = stdout.split('\0');
    paths.forEach((p, i) => {
      const v = values[i] || '';
      const urls = [...v.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((u) => /^https?:/i.test(u));
      if (urls.length) res.set(p, urls.join(' '));
    });
  } catch { /* metadata is optional */ }
  return res;
}

// ---------- document text ----------
/** Text of rtf, doc, docx, odt and html files. */
export async function extractRichText(full) {
  const { stdout } = await run('textutil', ['-convert', 'txt', '-stdout', full], { ...EXEC_OPTS, timeout: 15_000 });
  return stdout;
}

// ---------- previews ----------
const SIPS_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif', 'ico', 'icns', 'psd']);
/** Write a preview of at most `size` px to `out`. Returns the path written (the extension may change to .png). */
export async function makeThumbnail(f, out, { alpha, size = 480 }) {
  if (f.category === 'image' && SIPS_EXT.has(f.ext)) {
    await run('sips', ['-Z', String(size), '-s', 'format', alpha ? 'png' : 'jpeg', f.path, '--out', out], { timeout: 30_000 });
    return out;
  }
  // Quick Look renders PDFs, Office files, video frames and more.
  const tmp = await fsp.mkdtemp(path.join(path.dirname(out), 'ql-'));
  try {
    await run('qlmanage', ['-t', '-s', String(size), '-o', tmp, f.path], { timeout: 30_000 });
    const made = (await fsp.readdir(tmp)).find((n) => n.endsWith('.png'));
    if (!made) throw new Error('no preview');
    const png = out.replace(/\.jpg$/, '.png');
    await fsp.rename(path.join(tmp, made), png);
    return png;
  } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
}

// ---------- Trash ----------
// macOS 14 and later ship /usr/bin/trash. Older versions fall back to asking Finder.
const HAS_TRASH_CLI = fs.existsSync('/usr/bin/trash');
/** Move one or more paths to the Trash. Throws if any of them could not be moved. */
export async function moveToTrash(list, timeout) {
  if (HAS_TRASH_CLI) {
    await run('/usr/bin/trash', list, { timeout });
    return;
  }
  const script = [
    'on run argv',
    '  set theFiles to {}',
    '  repeat with p in argv',
    '    set end of theFiles to (POSIX file (p as text)) as alias',
    '  end repeat',
    '  tell application "Finder" to delete theFiles',
    'end run',
  ].join('\n');
  await run('/usr/bin/osascript', ['-e', script, ...list], { timeout });
}

// ---------- Finder ----------
export async function reveal(p) { await run('open', ['-R', p]); }
export async function openPath(p) { await run('open', [p]); }

/** Show the standard folder picker. Returns the chosen path, or null if cancelled. */
export async function pickFolder() {
  try {
    const { stdout } = await run('osascript', ['-e', 'tell me to activate', '-e',
      'POSIX path of (choose folder with prompt "Choose a folder for 2ndBrain to search")'], { timeout: 10 * 60 * 1000 });
    return stdout.trim() || null;
  } catch { return null; } // cancelled
}

// ---------- Claude Code ----------
/** How to start the claude CLI: { file, args, promptOnStdin }. */
export function claudeCommand() {
  const candidates = [process.env.SECONDBRAIN_CLAUDE, path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean);
  return { file: candidates.find((c) => fs.existsSync(c)) || 'claude', args: [], promptOnStdin: false };
}
