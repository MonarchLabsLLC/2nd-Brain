// Cross-platform helpers: path rules, image headers, document text, download marks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { samePath, isWithin, isInsideOrSame, relInfo, baseName } from '../src/paths.mjs';
import { readImageInfo } from '../src/imagesize.mjs';
import { extractText, rtfText, htmlText, unzipEntry } from '../src/extract.mjs';
import { parseZoneIdentifier } from '../src/platform/win32.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '2ndbrain-platform-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('path rules', () => {
  const root = path.join(tmp, 'Downloads');
  assert.ok(isWithin(path.join(root, 'a', 'b.png'), root));
  assert.ok(!isWithin(root, root));
  assert.ok(!isWithin(root + '-old', root), 'a sibling with the same prefix is not inside');
  assert.ok(isInsideOrSame(root, root));
  const driveRoot = path.parse(tmp).root; // "/" or "C:\"
  assert.ok(isWithin(tmp, driveRoot));
  assert.deepEqual(relInfo(path.join(root, 'Kit', 'x', 'a.svg'), root), { rel: 'Kit/x/a.svg', folder: 'Kit' });
  assert.deepEqual(relInfo(path.join(root, 'a.svg'), root), { rel: 'a.svg', folder: null });
  assert.equal(baseName('C:\\Users\\me\\Downloads\\'), 'Downloads');
  assert.equal(baseName('/Users/me/Brand'), 'Brand');
  if (process.platform === 'win32') {
    assert.ok(samePath('C:\\Users\\Me\\Downloads', 'c:\\users\\me\\downloads'));
    assert.ok(isWithin('c:\\users\\me\\downloads\\x.png', 'C:\\Users\\Me\\Downloads'));
  } else {
    assert.ok(!samePath('/Users/Me', '/users/me'));
  }
});

function pngHeader(w, h, colorType, extraChunk) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([sig, chunk('IHDR', ihdr), ...(extraChunk ? [chunk(extraChunk, Buffer.alloc(2))] : []), chunk('IDAT', Buffer.alloc(8))]);
}

test('image sizes are read from file headers', async () => {
  const write = (name, buf) => { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; };
  assert.deepEqual(await readImageInfo(write('a.png', pngHeader(384, 124, 6))), { width: 384, height: 124, hasAlpha: 1 });
  assert.deepEqual(await readImageInfo(write('b.png', pngHeader(800, 600, 2))), { width: 800, height: 600, hasAlpha: 0 });
  assert.deepEqual(await readImageInfo(write('c.png', pngHeader(10, 10, 3, 'tRNS'))), { width: 10, height: 10, hasAlpha: 1 });
  // JPEG: an APP1 segment, then the frame header with height 3000 and width 4000.
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x03, ...Array(9).fill(0)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(40)]);
  assert.deepEqual(await readImageInfo(write('d.jpg', jpg)), { width: 4000, height: 3000, hasAlpha: 0 });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(30)]);
  assert.deepEqual(await readImageInfo(write('e.gif', gif)), { width: 320, height: 240, hasAlpha: null });
  // WebP with VP8X header: alpha flag set, canvas 1200x630.
  const vp8x = Buffer.alloc(30); vp8x.write('RIFF', 0); vp8x.write('WEBP', 8); vp8x.write('VP8X', 12);
  vp8x[20] = 0x10; vp8x.writeUIntLE(1199, 24, 3); vp8x.writeUIntLE(629, 27, 3);
  assert.deepEqual(await readImageInfo(write('f.webp', vp8x)), { width: 1200, height: 630, hasAlpha: 1 });
  assert.equal(await readImageInfo(write('g.png', Buffer.from('not an image at all, just text'))), null);
});

/** Smallest valid zip with deflated entries. */
function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = zlib.deflateRawSync(Buffer.from(text)); const n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(text), 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(text), 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('document text without external tools', async () => {
  const docx = path.join(tmp, 'brief.docx');
  fs.writeFileSync(docx, zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Launch &amp; brief</w:t></w:r></w:p><w:p><w:r><w:t>Zebra</w:t><w:tab/><w:t>campaign</w:t></w:r></w:p></w:body></w:document>',
  }));
  assert.equal(await extractText(docx, 'docx'), 'Launch & brief\nZebra\tcampaign');
  assert.equal(unzipEntry(fs.readFileSync(docx), 'missing.xml'), null);
  const odt = path.join(tmp, 'notes.odt');
  fs.writeFileSync(odt, zip({ 'content.xml': '<office:text><text:h>Title</text:h><text:p>Body text</text:p></office:text>' }));
  assert.equal(await extractText(odt, 'odt'), 'Title\nBody text');
  assert.equal(rtfText('{\\rtf1\\ansi{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs24 Hello \\b world\\b0\\par Caf\\\'e9 \\{x\\}}'), 'Hello world\nCafé {x}');
  assert.equal(htmlText('<html><head><style>p{}</style><script>x()</script></head><body><h1>Title</h1><p>One &amp; two</p></body></html>'), 'Title\nOne & two');
});

test('download links from the Windows Zone.Identifier mark', () => {
  const zone = '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/press\r\nHostUrl=https://cdn.example.com/logo.png\r\n';
  assert.deepEqual(parseZoneIdentifier(zone), ['https://cdn.example.com/logo.png', 'https://example.com/press']);
  assert.deepEqual(parseZoneIdentifier('[ZoneTransfer]\nZoneId=3\nHostUrl=about:internet\n'), []);
});
