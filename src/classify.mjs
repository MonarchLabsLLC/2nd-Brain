// File type rules. Pure functions, except that Organize folder names can come from settings.json.
import { loadSettings } from './config.mjs';

const EXT = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'svg', 'bmp', 'tif', 'tiff', 'avif', 'ico', 'icns', 'psd', 'ai', 'eps', 'sketch', 'fig'],
  markdown: ['md', 'markdown', 'mdx'],
  text: ['txt', 'rtf', 'log', 'srt', 'vtt'],
  pdf: ['pdf'],
  office: ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'key', 'pages', 'numbers', 'odt', 'ods', 'odp'],
  data: ['json', 'jsonl', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'sql', 'sqlite', 'db'],
  code: ['html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'php', 'rb', 'go', 'swift', 'java', 'c', 'cpp', 'h'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff', 'aif'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz'],
  installer: ['dmg', 'pkg', 'mpkg', 'exe', 'msi', 'app'],
  font: ['ttf', 'otf', 'woff', 'woff2'],
};
const BY_EXT = new Map();
for (const [cat, exts] of Object.entries(EXT)) for (const e of exts) BY_EXT.set(e, cat);

export const CATEGORY_LABELS = {
  image: 'Images', markdown: 'Markdown', text: 'Text', pdf: 'PDF', office: 'Office', data: 'Data',
  code: 'Code & HTML', video: 'Video', audio: 'Audio', archive: 'Archives', installer: 'Installers',
  font: 'Fonts', other: 'Other',
};
export const IMAGE_SUB_LABELS = { logo: 'Logos', screenshot: 'Screenshots', photo: 'Photos', graphic: 'Other images' };

// Text we can read directly as UTF-8.
export const PLAIN_TEXT_EXT = new Set([...EXT.markdown, 'txt', 'log', 'srt', 'vtt', 'json', 'jsonl', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'sql', ...EXT.code]);
// Text we read with macOS textutil.
export const TEXTUTIL_EXT = new Set(['rtf', 'doc', 'docx', 'odt', 'html', 'htm']);
// Images that sips can measure and thumbnail.
export const SIPS_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif', 'ico', 'icns', 'psd']);

export function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

export function categoryOf(ext, isBundle = false) {
  if (isBundle) return ext === 'app' ? 'installer' : (BY_EXT.get(ext) || 'other');
  return BY_EXT.get(ext) || 'other';
}

const LOGO_RE = /(logo|brand|wordmark|lockup|favicon|icon|emblem|badge|monogram)/i;
const SCREENSHOT_RE = /(screen ?shot|screen recording|cleanshot|snagit|capture|^\d{4}-\d{2}-\d{2}[_ ]\d{2}[-.]\d{2}[-.]\d{2}|^Image \d{4}-\d{2}-\d{2})/i;
const PHOTO_RE = /^(IMG|DSC|PXL|DCIM|PHOTO)[_-]?\d/i;

/**
 * Sub-type for images. Uses the name first, then size and transparency.
 * @param {{name:string, ext:string, width?:number|null, height?:number|null, hasAlpha?:number|null}} f
 */
export function imageSubcategory(f) {
  const base = f.name.replace(/\.[^.]+$/, '');
  if (LOGO_RE.test(base)) return 'logo';
  if (['svg', 'ico', 'icns', 'ai', 'eps'].includes(f.ext)) return 'logo';
  if (SCREENSHOT_RE.test(base)) return 'screenshot';
  if (PHOTO_RE.test(base) || ['heic', 'heif'].includes(f.ext)) return 'photo';
  const maxDim = Math.max(f.width || 0, f.height || 0);
  // Unnamed logos: small, transparent-capable and wide (a typical wordmark), e.g. 384x124.
  const w = f.width || 0; const h = f.height || 0;
  if (f.hasAlpha && maxDim > 0 && maxDim <= 1000 && h > 0 && w / h >= 2.2 && ['png', 'webp', 'gif'].includes(f.ext)) return 'logo';
  if (['jpg', 'jpeg'].includes(f.ext) && maxDim >= 2000) return 'photo';
  return 'graphic';
}

/**
 * Default Organize folders, relative to Downloads. Keys are image kinds or file categories.
 * Override any of them in settings.json in the data folder, for example:
 *   { "folders": { "logo": "Images/Brand", "graphic": "Images/Misc" } }
 */
export const DEFAULT_FOLDERS = {
  logo: 'Images/Logos', screenshot: 'Images/Screenshots', photo: 'Images/Photos', graphic: 'Images/Other',
  markdown: 'Docs/Markdown', text: 'Docs/Text', pdf: 'Docs/PDF', office: 'Docs/Office',
  data: 'Data', code: 'Code', video: 'Media/Video', audio: 'Media/Audio',
  archive: 'Archives', installer: 'Installers', font: 'Fonts',
};

/** The folder map in use: defaults plus any safe overrides from settings.json. */
export function organizeFolders() {
  const custom = loadSettings().folders || {};
  const out = { ...DEFAULT_FOLDERS };
  for (const [k, v] of Object.entries(custom)) {
    if (!(k in DEFAULT_FOLDERS) || typeof v !== 'string') continue;
    const clean = v.split(/[\\/]+/).map((s) => s.trim()).filter((s) => s && s !== '.' && s !== '..').join('/');
    if (clean) out[k] = clean;
  }
  return out;
}

/** Destination folder (relative to Downloads) used by Organize. Null means "leave it". */
export function organizeTarget(f) {
  const folders = organizeFolders();
  if (f.category === 'image') return folders[f.subcategory || 'graphic'] || folders.graphic;
  return folders[f.category] || null;
}

