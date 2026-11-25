// Find files with meaningless names and ask Claude Code (the `claude` CLI) for good ones.
// Claude only sees small thumbnails and document text; it cannot touch the files.
// Renames happen later, through a reviewed plan that can be undone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from './db.mjs';
import { THUMB_DIR, PARTIAL_SUFFIXES } from './config.mjs';
import { looksSecret } from './indexer.mjs';
import { thumbnail } from './thumbs.mjs';

const run = promisify(execFile);

// ---------- what counts as a junk name ----------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const GENERIC = /^(screen ?shot|screen recording|cleanshot|snagit|capture|snapshot|scan|scanned|image|img|imgur|photo|pic|picture|pxl|dsc|dscn|dcim|mvimg|untitled|unnamed|no name|noname|new document|document|doc|file|download|downloaded|copy of untitled|chatgpt image|gemini[_ ]generated[_ ]image|generated[-_ ]image|dall[-·_ ]?e|midjourney|grok[-_ ]image|ideogram|flux|whatsapp image|telegram|signal|attachment|output|export|frame|clip|test)(?=$|[\s_\-.(\d])/i;
const FILLER = new Set(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'copy', 'design', 'image', 'generated', 'final', 'edit', 'edited', 'version', 'from', 'with', 'large', 'small', 'medium', 'original', 'scaled']);

/** True when a file name (without extension) says nothing about the content. */
export function isJunkName(base) {
  const b = String(base).trim();
  if (!b) return true;
  if (UUID.test(b)) return true;
  if (/^[0-9a-f]{16,}$/i.test(b)) return true; // hashes
  if (/^\d{5,}([\s_\-()\d]*)$/.test(b)) return true; // 1778294885971, 20260219_001
  if (/^\d{4}-\d{2}-\d{2}[ _T]\d{2}[-.:_]\d{2}/.test(b)) return true; // 2026-03-07_13-16-35
  const m = b.match(GENERIC);
  if (m) {
    const rest = b.slice(m[0].length);
    const words = (rest.match(/[a-z]{4,}/gi) || []).filter((w) => !FILLER.has(w.toLowerCase()) && /[aeiou]/i.test(w));
    // "Gemini_Generated_Image_k3j9x2m1" ends in one random token that mixes letters and digits
    const randomTail = /^[_\s-]*(?=[a-z0-9]*\d)[a-z0-9]{6,24}$/i.test(rest);
    if (!words.length || randomTail) return true;
  }
  // random tokens like "a8F3kd92LmQ0zx": long, no spaces or separators, many digits
  if (/^[A-Za-z0-9]{12,}$/.test(b)) {
    const digits = (b.match(/\d/g) || []).length;
    if (digits / b.length >= 0.25 && !/[a-z]{5,}/i.test(b)) return true;
  }
  return false;
}

// Claude can name these: images through a thumbnail, documents through their text (or a page preview).
const IMAGE_OK = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif']);
const DOC_OK = new Set(['md', 'markdown', 'txt', 'rtf', 'pdf', 'doc', 'docx', 'pages', 'csv', 'json', 'html']);
const PROJECT_MARKERS = ['package.json', '.git', 'node_modules', 'index.html', 'Cargo.toml', 'pyproject.toml', 'composer.json', 'Gemfile', 'go.mod', 'manifest.json'];

/** Files inside a code project or website folder keep their names, so nothing breaks. */
function insideProject(file, root, cache) {
  let dir = path.dirname(file);
  while (dir.startsWith(root + path.sep)) {
    if (!cache.has(dir)) cache.set(dir, PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m))));
    if (cache.get(dir)) return true;
    dir = path.dirname(dir);
  }
  return false;
}

/**
 * Files with junk names.
 * @param {{root?: string, folder?: string|null, limit?: number}} scope
 *   folder: a top-level folder of root, or null for loose files only, or undefined for everything in root.
 */
export function findUnnamed({ root, folder, limit = 500 } = {}) {
  const where = ['is_bundle = 0']; const args = [];
  if (root) { where.push('root = ?'); args.push(root); }
  if (folder === null) where.push('folder IS NULL');
  else if (folder) { where.push('folder = ?'); args.push(folder); }
  where.push('dataless = 0'); // never make the cloud provider download online-only files
  const rows = getDb().prepare(`SELECT id, path, root, rel_path, name, ext, category, subcategory, size, mtime, width, height, has_alpha, dataless,
      substr(content, 1, 1500) AS excerpt FROM files WHERE ${where.join(' AND ')} ORDER BY mtime DESC`).all(...args);
  const cache = new Map(); const out = [];
  let skippedProject = 0;
  for (const r of rows) {
    if (!(IMAGE_OK.has(r.ext) || DOC_OK.has(r.ext))) continue;
    if (looksSecret(r.name) || PARTIAL_SUFFIXES.some((s) => r.name.toLowerCase().endsWith(s))) continue;
    const base = r.name.slice(0, r.name.length - (r.ext ? r.ext.length + 1 : 0));
    if (!isJunkName(base)) continue;
    if (insideProject(r.path, r.root, cache)) { skippedProject++; continue; }
    out.push(r);
    if (out.length >= limit) break;
  }
  return { files: out, skippedProject };
}

// ---------- asking Claude ----------
export function claudeBin() {
  const candidates = [process.env.SECONDBRAIN_CLAUDE, path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || 'claude';
}

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: { names: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id', 'name'] } } },
  required: ['names'],
});

/** Clean a proposed name: no extension, no path characters, sane length. */
export function cleanName(name, ext) {
  let n = String(name || '').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (ext && n.toLowerCase().endsWith('.' + ext)) n = n.slice(0, -(ext.length + 1));
  n = n.replace(/^[.\s-]+|[.\s-]+$/g, '').slice(0, 80).trim();
  return n || null;
}

async function describeBatch(batch, model) {
  const parts = [];
  for (const f of batch) {
    const kind = f.category === 'image' ? 'image' : 'document';
    let how;
    if (kind === 'image' || (!f.excerpt && ['pdf', 'doc', 'docx', 'pages'].includes(f.ext))) {
      try {
        const t = await thumbnail(f);
        how = `Look at the preview image: ${t}`;
      } catch { how = null; }
    }
    if (!how && f.excerpt) how = `Text from the start of the file:\n<<<\n${f.excerpt.slice(0, 1500)}\n>>>`;
    if (!how) continue;
    parts.push(`### id ${f.id}\nCurrent name: ${f.name}\nType: ${kind} (.${f.ext})${f.width ? `, ${f.width}x${f.height}px` : ''}\nIn folder: ${path.dirname(f.rel_path) === '.' ? '(top level)' : path.dirname(f.rel_path)}\n${how}`);
  }
  if (!parts.length) return [];
  const prompt = `You name files in a person's Downloads folder. The files below have meaningless names (camera numbers, screenshots, IDs, "Untitled").
For each file, look at it (use the Read tool on each preview image path) or read its text, then give a short, specific, human file name.

Rules:
- 2 to 7 words, Title Case with spaces, no extension, no dates unless the date is the point of the file.
- Say what it is: include brand, product, person or topic names you can see (for example "Acme Launch Banner", "Pricing Table Screenshot", "Stripe Payout Report", "Weekly Team Meeting Notes").
- For screenshots, name what the screen shows and end with "Screenshot".
- If you truly cannot tell what a file is, return an empty name for it.
- Return one entry per id.

${parts.join('\n\n')}`;
  const { stdout } = await run(claudeBin(), [
    '-p', prompt,
    '--model', model,
    '--output-format', 'json',
    '--json-schema', SCHEMA,
    '--tools', 'Read',
    '--allowedTools', 'Read',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
  ], { cwd: THUMB_DIR, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
  const out = JSON.parse(stdout);
  if (out.is_error) throw new Error(out.result || 'Claude returned an error');
  let data = out.structured_output;
  if (!data && typeof out.result === 'string') {
    const m = out.result.match(/\{[\s\S]*\}/);
    data = m ? JSON.parse(m[0]) : null;
  }
  return Array.isArray(data?.names) ? data.names : [];
}

// ---------- naming jobs (one at a time) ----------
const jobs = new Map();
let activeJob = null;

/**
 * Start a background job that proposes names. Poll getJob(id).
 * @param {{root?: string, folder?: string|null, limit?: number, model?: string, batchSize?: number}} scope
 */
export function startNaming(scope = {}) {
  if (activeJob && jobs.get(activeJob)?.state === 'running') throw new Error('A naming job is already running. Wait for it to finish.');
  const { files, skippedProject } = findUnnamed({ ...scope, limit: scope.limit || 40 });
  const id = crypto.randomUUID();
  const job = {
    id, state: 'running', scope, total: files.length, done: 0, skippedProject,
    proposals: [], unsure: [], errors: [], startedAt: Date.now(),
  };
  jobs.set(id, job); activeJob = id;
  const size = scope.batchSize || 8;
  const model = scope.model || process.env.SECONDBRAIN_NAMING_MODEL || 'sonnet';
  (async () => {
    for (let i = 0; i < files.length; i += size) {
      if (job.state === 'cancelled') return;
      const batch = files.slice(i, i + size);
      try {
        const names = await describeBatch(batch, model);
        const byId = new Map(names.map((n) => [Number(n.id), n.name]));
        for (const f of batch) {
          const n = cleanName(byId.get(f.id), f.ext);
          if (n) job.proposals.push({ file_id: f.id, from: f.path, root: f.root, old_name: f.name, new_name: `${n}${f.ext ? '.' + f.ext : ''}`, category: f.category });
          else job.unsure.push({ file_id: f.id, name: f.name });
        }
      } catch (e) {
        job.errors.push(String(e.stderr || e.message || e).slice(0, 400));
        if (job.errors.length >= 3 && !job.proposals.length) { job.state = 'failed'; return; }
      }
      job.done = Math.min(files.length, i + size);
    }
    job.state = 'done';
  })().catch((e) => { job.state = 'failed'; job.errors.push(String(e.message || e)); });
  return job;
}

export function getJob(id) { return jobs.get(id) || null; }
export function cancelJob(id) { const j = jobs.get(id); if (j && j.state === 'running') j.state = 'cancelled'; return j; }

/** Turn approved proposals into a stored plan that applyPlan() can run and undo. */
export function planFromProposals(proposals) {
  const items = proposals.map((p) => ({
    file_id: p.file_id, name: p.old_name, from: p.from, root: p.root,
    to_dir: path.relative(p.root, path.dirname(p.from)) || '.', to_name: p.new_name,
  }));
  const id = crypto.randomUUID();
  getDb().prepare('INSERT INTO plans(id, created_at, items) VALUES (?, ?, ?)').run(id, Date.now(), JSON.stringify(items));
  return id;
}
