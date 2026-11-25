// Thumbnails, shared by the web app and the naming engine.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { THUMB_DIR, ensureDirs } from './config.mjs';
import { SIPS_EXT } from './classify.mjs';

const run = promisify(execFile);
ensureDirs();

let active = 0; const waiting = [];
async function limit(fn) {
  if (active >= 3) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}
const inflight = new Map();
/** Returns the path of a cached PNG/JPG preview (max 480 px). */
export async function thumbnail(f) {
  if (f.dataless) throw new Error('Online-only file: no preview, so the cloud provider does not download it');
  const alpha = f.has_alpha || ['png', 'webp', 'gif'].includes(f.ext);
  const out = path.join(THUMB_DIR, `${f.id}-${f.mtime}.${alpha ? 'png' : 'jpg'}`);
  if (fs.existsSync(out)) return out;
  if (inflight.has(out)) return inflight.get(out);
  const p = limit(async () => {
    if (f.category === 'image' && SIPS_EXT.has(f.ext)) {
      await run('sips', ['-Z', '480', '-s', 'format', alpha ? 'png' : 'jpeg', f.path, '--out', out], { timeout: 30_000 });
    } else {
      // Quick Look renders PDFs, Office files, video frames and more.
      const tmp = await fsp.mkdtemp(path.join(THUMB_DIR, 'ql-'));
      try {
        await run('qlmanage', ['-t', '-s', '480', '-o', tmp, f.path], { timeout: 30_000 });
        const made = (await fsp.readdir(tmp)).find((n) => n.endsWith('.png'));
        if (!made) throw new Error('no preview');
        await fsp.rename(path.join(tmp, made), out.replace(/\.jpg$/, '.png'));
        return out.replace(/\.jpg$/, '.png');
      } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
    }
    return out;
  }).finally(() => inflight.delete(out));
  inflight.set(out, p);
  return p;
}

