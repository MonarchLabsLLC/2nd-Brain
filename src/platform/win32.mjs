// Windows: File Explorer, the Recycle Bin, NTFS download marks and the Windows Shell's own previews.
// Thumbnails, file attributes and the Recycle Bin go through one long-running PowerShell helper
// (win-helper.ps1), so each call does not pay PowerShell's start-up time.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readImageInfo } from '../imagesize.mjs';
import { extractText } from '../extract.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYSROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const EXPLORER = path.join(SYSROOT, 'explorer.exe');

export const LABELS = {
  os: 'windows',
  fileManager: 'File Explorer',
  trash: 'Recycle Bin',
  trashLong: 'the Recycle Bin',
  putBack: 'You can restore it from the Recycle Bin.',
};

// ---------- the PowerShell helper ----------
let helper = null;
function startHelper() {
  const child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'win-helper.ps1')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 1; let stderr = '';
  const h = { child, pending, ready: null };
  let markReady;
  h.ready = new Promise((resolve, reject) => { markReady = { resolve, reject }; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === 0) { markReady.resolve(); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'Windows helper failed'));
  });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  const fail = (why) => {
    if (helper === h) helper = null;
    const err = new Error(`Windows helper stopped: ${why}${stderr ? ` (${stderr.trim()})` : ''}`);
    markReady.reject(err);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  };
  child.on('exit', (code) => fail(`exit code ${code}`));
  child.on('error', (e) => fail(e.message));
  h.ready.catch(() => {});
  h.call = async (cmd, args, timeout = 60_000) => {
    await h.ready;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Windows helper timed out on ${cmd}`));
        child.kill(); // a stuck request blocks the ones behind it; start fresh next time
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  };
  // Do not keep a CLI command (npm run index) alive just for the helper.
  child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); child.stdin.unref?.();
  return h;
}
function call(cmd, args, timeout) {
  if (!helper) helper = startHelper();
  return helper.call(cmd, args, timeout);
}
// Keep the event loop alive only while a request is waiting.
async function busy(fn) {
  const keep = setInterval(() => {}, 1 << 30);
  try { return await fn(); } finally { clearInterval(keep); }
}

// ---------- image size ----------
export async function imageInfo(paths) {
  const res = new Map();
  await Promise.all(paths.map(async (p) => {
    try { const info = await readImageInfo(p); if (info) res.set(p, info); } catch { /* unreadable: skip */ }
  }));
  return res;
}

// ---------- online-only cloud files ----------
// OneDrive, Dropbox and iCloud placeholders. Opening them makes the provider download them.
const FILE_ATTRIBUTE_OFFLINE = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000;
const CLOUD_ONLY = FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

/**
 * Paths that are online-only. If the attributes cannot be read, every path is treated as online-only:
 * indexing by name only is safe, while reading a placeholder would download it.
 */
export async function onlineOnlySet(paths) {
  const out = new Set();
  if (!paths.length) return out;
  let attrs;
  try { attrs = await busy(() => call('attrs', { paths }, 120_000)); } catch { return new Set(paths); }
  paths.forEach((p, i) => { const a = Number(attrs?.[i] ?? -1); if (a !== -1 && (a & CLOUD_ONLY)) out.add(p); });
  return out;
}

// ---------- download links ----------
/** Parse an NTFS Zone.Identifier stream: browsers write HostUrl (the file) and ReferrerUrl (the page). */
export function parseZoneIdentifier(text) {
  const get = (k) => text.match(new RegExp(`^${k}=(.+)$`, 'mi'))?.[1].trim();
  return [get('HostUrl'), get('ReferrerUrl')].filter((u) => u && /^https?:/i.test(u));
}

export async function downloadSources(paths) {
  const res = new Map();
  await Promise.all(paths.map(async (p) => {
    try {
      const buf = await fsp.readFile(`${p}:Zone.Identifier`);
      const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
      const urls = [...new Set(parseZoneIdentifier(text))];
      if (urls.length) res.set(p, urls.join(' '));
    } catch { /* no mark: not downloaded by a browser, or not NTFS */ }
  }));
  return res;
}

// ---------- document text ----------
export async function extractRichText(full, ext) {
  const t = await extractText(full, ext);
  if (t == null) throw new Error('Unsupported document');
  return t;
}

// ---------- previews ----------
export async function makeThumbnail(f, out, { size = 480 }) {
  await busy(() => call('thumb', { path: f.path, out, size }, 30_000));
  return out;
}

// ---------- Recycle Bin ----------
export async function moveToTrash(list, timeout) {
  const failed = await busy(() => call('recycle', { paths: list }, timeout));
  if (failed?.length) {
    const err = new Error(`Could not move to the Recycle Bin: ${failed.join('; ')}`);
    err.stderr = failed.join('\n');
    throw err;
  }
}

// ---------- File Explorer ----------
// explorer.exe needs the exact form /select,"path", so the arguments are passed as written.
// Windows paths cannot contain double quotes, so this quoting is safe. It also exits with
// code 1 when it worked, so its exit code is ignored.
function explorer(args) {
  return new Promise((resolve) => {
    execFile(EXPLORER, args, { windowsVerbatimArguments: true, windowsHide: false }, () => resolve());
  });
}
const quoted = (p) => `"${path.resolve(p).replace(/"/g, '')}"`;
export async function reveal(p) { await explorer([`/select,${quoted(p)}`]); }
export async function openPath(p) { await explorer([quoted(p)]); }

/** Show the Windows folder picker. Returns the chosen path, or null if cancelled. */
export async function pickFolder() {
  const script = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
$d = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = 'Choose a folder for 2nd Brain to search'; ShowNewFolderButton = $false }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }`;
  try {
    const { stdout } = await run(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 10 * 60 * 1000, windowsHide: true });
    return stdout.trim() || null;
  } catch { return null; }
}

// ---------- Claude Code ----------
function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir.replace(/^"|"$/g, ''), name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * How to start the claude CLI: { file, args, promptOnStdin }.
 * The prompt goes on stdin because Windows limits a command line to 32,767 characters.
 * An npm-installed claude.cmd cannot be started without a shell, so its JavaScript entry is run with node instead.
 */
export function claudeCommand() {
  const fromCmd = (cmd) => {
    const cli = path.join(path.dirname(cmd), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    return fs.existsSync(cli) ? { file: process.execPath, args: [cli], promptOnStdin: true } : null;
  };
  const env = process.env.SECONDBRAIN_CLAUDE;
  if (env && fs.existsSync(env)) {
    if (/\.(cmd|bat)$/i.test(env)) { const c = fromCmd(env); if (c) return c; } else return { file: env, args: [], promptOnStdin: true };
  }
  const exe = [path.join(os.homedir(), '.local', 'bin', 'claude.exe')].find((p) => fs.existsSync(p)) || onPath('claude.exe');
  if (exe) return { file: exe, args: [], promptOnStdin: true };
  const cmd = onPath('claude.cmd');
  return (cmd && fromCmd(cmd)) || { file: 'claude.exe', args: [], promptOnStdin: true };
}
