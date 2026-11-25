// Image width, height and transparency read from the file header, with no external tools.
// Used on Windows, where macOS sips is not available. Reads only a small part of each file.
import fsp from 'node:fs/promises';

const HEAD = 64 * 1024;

/** @returns {Promise<{width:number|null, height:number|null, hasAlpha:0|1|null}|null>} null if unknown format */
export async function readImageInfo(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(HEAD);
    const { bytesRead } = await fh.read(head, 0, HEAD, 0);
    const b = head.subarray(0, bytesRead);
    if (b.length < 24) return null;
    if (b.readUInt32BE(0) === 0x89504e47) return png(b);
    if (b[0] === 0xff && b[1] === 0xd8) return await jpeg(fh); // await: the file closes in finally
    if (b.toString('ascii', 0, 4) === 'GIF8') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), hasAlpha: null };
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return webp(b);
    if (b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)), hasAlpha: null };
    if (b.readUInt32LE(0) === 0x00010000) return { width: b[6] || 256, height: b[7] || 256, hasAlpha: 1 }; // .ico
    return null;
  } finally { await fh.close(); }
}

function png(b) {
  const width = b.readUInt32BE(16); const height = b.readUInt32BE(20);
  const colorType = b[25];
  let hasAlpha = colorType === 4 || colorType === 6 ? 1 : 0;
  // A tRNS chunk before the image data also means transparency.
  for (let o = 8; !hasAlpha && o + 8 <= b.length;) {
    const len = b.readUInt32BE(o); const type = b.toString('ascii', o + 4, o + 8);
    if (type === 'tRNS') hasAlpha = 1;
    if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return { width, height, hasAlpha };
}

function webp(b) {
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), hasAlpha: b[20] & 0x10 ? 1 : 0 };
  }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), hasAlpha: (bits >> 28) & 1 };
  }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, hasAlpha: 0 };
  return null;
}

// JPEG: walk the segments until a start-of-frame marker. Metadata can push it far into the file.
async function jpeg(fh) {
  let pos = 2;
  const buf = Buffer.alloc(10);
  for (let i = 0; i < 500; i++) {
    const { bytesRead } = await fh.read(buf, 0, 10, pos);
    if (bytesRead < 4 || buf[0] !== 0xff) return null;
    const marker = buf[1];
    if (marker === 0xff) { pos++; continue; } // padding
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    const len = buf.readUInt16BE(2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (bytesRead < 9) return null;
      return { width: buf.readUInt16BE(7), height: buf.readUInt16BE(5), hasAlpha: 0 };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or image data without a frame header
    pos += 2 + len;
  }
  return null;
}
