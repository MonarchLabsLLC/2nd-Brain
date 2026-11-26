import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// "Include subfolders" off: search and the left-column counts keep only the top level.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), '2ndbrain-subs-')));
const root = path.join(tmp, 'Downloads');
process.env.SECONDBRAIN_DATA = path.join(tmp, 'data');
process.env.SECONDBRAIN_DOWNLOADS = root;

const { refresh } = await import('../src/indexer.mjs');
const { searchFiles, stats, setStar, getFileByPath } = await import('../src/queries.mjs');

function make(rel, content = 'x') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

make('2026-11-26-shot.jpg');
make('notes.md', '# zebra');
make('report.pdf', '%PDF-1.4');
make('Work/plan.md', '# zebra plan');
make('Work/slides.pdf', '%PDF-1.4');
make('Work/Assets/logo.svg', '<svg/>');
make('Work/Assets/Deep/zebra.md', '# deep zebra');
make('Review/draft.pdf', '%PDF-1.4');

test('search: top level of a location or folder only', async () => {
  await refresh(root);
  assert.equal(searchFiles({ root }).total, 8);

  const top = searchFiles({ root, subfolders: '0' });
  assert.equal(top.total, 3);
  assert.equal(top.hidden, 5);

  // In a folder: only files directly in Work, not in Work/Assets.
  const work = searchFiles({ root, folder: 'Work', subfolders: false });
  assert.deepEqual(work.items.map((f) => f.name).sort(), ['plan.md', 'slides.pdf']);
  assert.equal(work.hidden, 2);

  // Text search follows the switch too.
  assert.equal(searchFiles({ q: 'zebra' }).total, 3);
  const z = searchFiles({ q: 'zebra', subfolders: '0' });
  assert.equal(z.total, 1);
  assert.equal(z.hidden, 2);

  // Loose files are top level already; nothing is hidden.
  assert.equal(searchFiles({ folder: '__loose', subfolders: '0' }).hidden, 0);
  assert.equal(searchFiles({ root }).hidden, 0);
});

test('left-column counts follow the switch and keep empty types listed', () => {
  setStar(getFileByPath(path.join(root, 'Work', 'slides.pdf')).id, true);

  const on = stats(root);
  assert.equal(on.subfolders, true);
  assert.equal(on.total, 8);
  assert.equal(on.starred, 1);
  assert.equal(on.roots.find((r) => r.path === root).n, 8);
  assert.equal(on.folders.find((f) => f.folder === 'Work').n, 4);

  const off = stats(root, { subfolders: '0' });
  assert.equal(off.subfolders, false);
  assert.equal(off.total, 3);
  assert.equal(off.loose, 3);
  assert.equal(off.starred, 0);
  assert.equal(off.roots.find((r) => r.path === root).n, 3);
  assert.equal(off.folders.find((f) => f.folder === 'Work').n, 2);
  assert.equal(off.folders.find((f) => f.folder === 'Review').n, 1);
  // Every type stays in the list, in the same order, even when its count drops to 0.
  assert.deepEqual(off.categories.map((c) => c.category), on.categories.map((c) => c.category));
  const n = (s, cat) => s.categories.find((c) => c.category === cat).n;
  assert.equal(n(on, 'pdf'), 3);
  assert.equal(n(off, 'pdf'), 1);
  assert.equal(n(off, 'image'), 1);
});
