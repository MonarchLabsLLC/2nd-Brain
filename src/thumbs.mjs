// Thumbnails, shared by the web app and the naming engine.
import fs from 'node:fs';
import path from 'node:path';
import { THUMB_DIR, ensureDirs } from './config.mjs';
import { makeThumbnail } from './platform/index.mjs';

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
  const png = out.replace(/\.jpg$/, '.png');
  if (fs.existsSync(png)) return png; // a preview that came out as PNG last time
  const p = limit(() => makeThumbnail(f, out, { alpha, size: 480 })).finally(() => inflight.delete(out));
  inflight.set(out, p);
  return p;
}

