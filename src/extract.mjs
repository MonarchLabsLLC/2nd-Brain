// Text from .docx, .odt, .rtf and .html files, with no external tools.
// Used on Windows, where macOS textutil is not available.
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

const MAX_UNZIPPED = 50 * 1024 * 1024; // guards against zip bombs

/** Read one entry from a zip file. Returns a Buffer, or null if the entry is missing. */
export function unzipEntry(zip, wanted) {
  // The end-of-central-directory record sits in the last 64 KB.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (size > MAX_UNZIPPED) throw new Error('Entry too large');
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED });
      throw new Error(`Unsupported zip method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export function docxText(xml) {
  return tidy(decodeEntities(xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:(br|cr)\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')));
}

export function odtText(xml) {
  return tidy(decodeEntities(xml
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<\/text:(p|h)>/g, '\n')
    .replace(/<[^>]+>/g, '')));
}

export function htmlText(html) {
  return tidy(decodeEntities(html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote|\/pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')));
}

// Windows-1252 bytes 0x80-0x9f, which RTF writes as \'hh.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
export function rtfText(rtf) {
  let s = rtf
    // groups that hold no visible text: fonts, colors, styles, pictures, metadata
    .replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '')
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict|header|footer)[^{}]*(\{[^{}]*(\{[^{}]*\}[^{}]*)*\}[^{}]*)*\}/g, '')
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => { const c = parseInt(h, 16); return c >= 0x80 && c <= 0x9f ? CP1252[c - 0x80] : String.fromCharCode(c); })
    .replace(/\\(par|line|row)\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\([{}\\])/g, (_, c) => `\u0000${c.charCodeAt(0)}\u0000`)
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, c) => String.fromCharCode(Number(c)));
  return tidy(s);
}

/** Text of a .docx, .odt, .rtf, .html or .htm file. Old .doc files are not supported (returns null). */
export async function extractText(file, ext) {
  if (ext === 'docx' || ext === 'odt') {
    const zip = await fsp.readFile(file);
    const xml = unzipEntry(zip, ext === 'docx' ? 'word/document.xml' : 'content.xml');
    if (!xml) return null;
    return ext === 'docx' ? docxText(xml.toString('utf8')) : odtText(xml.toString('utf8'));
  }
  if (ext === 'rtf') return rtfText((await fsp.readFile(file)).toString('latin1'));
  if (ext === 'html' || ext === 'htm') return htmlText((await fsp.readFile(file)).toString('utf8'));
  return null;
}
