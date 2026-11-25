import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '2ndbrain-test-'));
const root = path.join(tmp, 'Downloads');
process.env.SECONDBRAIN_DATA = path.join(tmp, 'data');
process.env.SECONDBRAIN_DOWNLOADS = root;

const { refresh } = await import('../src/indexer.mjs');
const { createPlan, applyPlan, undoBatch } = await import('../src/organize.mjs');
const { searchFiles, getFileByPath } = await import('../src/queries.mjs');
const { imageSubcategory } = await import('../src/classify.mjs');

const old = new Date(Date.now() - 7 * 86400000);
function make(rel, content = 'x', when = old) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  fs.utimesSync(p, when, when);
  return p;
}

make('brand-logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
make('notes.md', '# Launch brief\nThe zebra campaign starts Monday.');
make('Screenshot 2026-01-01 at 10.00.00.png', 'notpng');
make('report.pdf', '%PDF-1.4');
make('fresh.md', '# just downloaded', new Date());
make('song.mp3.crdownload', 'partial');
make('Project/keep.md', '# stays in its folder');
make('Images/Logos/brand-logo.svg', '<svg/>'); // name clash target

test('indexes files and searches text inside them', async () => {
  const r = await refresh(root);
  assert.equal(r.total, 8);
  const hits = searchFiles({ q: 'zebra' });
  assert.equal(hits.total, 1);
  assert.equal(hits.items[0].name, 'notes.md');
  assert.ok(hits.items[0].snippet.includes('«zebra»'));
  assert.equal(searchFiles({ folder: 'Project' }).total, 1);
});

test('secret-looking files are indexed by name only', async () => {
  const { looksSecret } = await import('../src/indexer.mjs');
  for (const n of ['_env.txt', '.env.local', 'stripe-secret.txt', 'api_keys.md', 'server.pem', 'my tokens.txt']) assert.ok(looksSecret(n), n);
  for (const n of ['environment-notes.md', 'notes.md', 'keynote.txt', 'tokenomics.pdf']) assert.ok(!looksSecret(n), n);
});

test('image rules', () => {
  assert.equal(imageSubcategory({ name: 'Acme Logo.png', ext: 'png' }), 'logo');
  assert.equal(imageSubcategory({ name: 'x.png', ext: 'png', width: 384, height: 124, hasAlpha: 1 }), 'logo');
  assert.equal(imageSubcategory({ name: 'x.png', ext: 'png', width: 800, height: 600, hasAlpha: 1 }), 'graphic');
  assert.equal(imageSubcategory({ name: '2026-03-07_13-16-35.png', ext: 'png' }), 'screenshot');
});

test('plan moves only old, loose, known files and never touches subfolders', () => {
  const plan = createPlan({ root });
  const names = plan.items.map((i) => i.name).sort();
  assert.deepEqual(names, ['Screenshot 2026-01-01 at 10.00.00.png', 'brand-logo.svg', 'notes.md', 'report.pdf']);
  const reasons = plan.skipped.map((s) => s.reason).sort();
  assert.deepEqual(reasons, ['changed in the last 24 hours', 'partial download']);
});

test('apply moves files without overwriting, and undo puts them back', async () => {
  const plan = createPlan({ root });
  const notesId = plan.items.find((i) => i.name === 'notes.md').file_id;
  const r = await applyPlan(plan.plan_id, { root, exclude: [notesId] });
  assert.equal(r.moved, 3);
  assert.deepEqual(r.failed, []);
  assert.ok(fs.existsSync(path.join(root, 'Images/Logos/brand-logo (2).svg')), 'clash gets a new name');
  assert.ok(fs.existsSync(path.join(root, 'Images/Logos/brand-logo.svg')), 'existing file kept');
  assert.ok(fs.existsSync(path.join(root, 'Docs/PDF/report.pdf')));
  assert.ok(fs.existsSync(path.join(root, 'notes.md')), 'excluded file stays');
  assert.ok(getFileByPath(path.join(root, 'Docs/PDF/report.pdf')), 'index follows the move');
  await assert.rejects(applyPlan(plan.plan_id, { root }), /already applied/);

  const u = await undoBatch(r.batch_id, { root });
  assert.equal(u.restored, 3);
  assert.ok(fs.existsSync(path.join(root, 'brand-logo.svg')));
  assert.ok(fs.existsSync(path.join(root, 'report.pdf')));
  assert.ok(!fs.existsSync(path.join(root, 'Docs')), 'empty folders made by Organize are removed');
  assert.ok(fs.existsSync(path.join(root, 'Images/Logos/brand-logo.svg')), 'pre-existing file untouched');
  await assert.rejects(undoBatch(r.batch_id, { root }), /Nothing to undo/);
});

test('extra folders are indexed, searchable by location, and removable', async () => {
  const { addRoot, removeRoot, getRoots, validateRoot } = await import('../src/roots.mjs');
  const extra = path.join(tmp, 'Brand');
  fs.mkdirSync(path.join(extra, 'Kit'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'Kit', 'acme-logo.svg'), '<svg/>');
  addRoot(extra);
  assert.equal(getRoots().length, 2);
  await refresh();
  const hits = searchFiles({ q: 'acme' });
  assert.equal(hits.total, 1);
  assert.equal(hits.items[0].root, extra);
  assert.equal(hits.items[0].folder, 'Kit');
  assert.equal(searchFiles({ root: root, q: 'acme' }).total, 0);
  assert.throws(() => validateRoot(path.join(extra, 'Kit')), /already included/);
  assert.throws(() => validateRoot(tmp), /contains/);
  assert.throws(() => validateRoot('/'), /too large/);
  assert.throws(() => validateRoot('/System/Library'), /System folders/);
  assert.throws(() => removeRoot(root), /cannot be removed/);
  // A location that is switched off is left out of search, unless asked for by name.
  const { setRootActive } = await import('../src/roots.mjs');
  setRootActive(extra, false);
  assert.equal(searchFiles({ q: 'acme' }).total, 0);
  assert.equal(searchFiles({ root: extra, q: 'acme' }).total, 1);
  setRootActive(extra, true);
  assert.equal(searchFiles({ q: 'acme' }).total, 1);
  // Organize never touches other locations.
  assert.ok(createPlan({ root }).items.every((i) => i.from.startsWith(root + path.sep)));
  removeRoot(extra);
  assert.equal(searchFiles({ q: 'acme' }).total, 0);
  assert.ok(fs.existsSync(path.join(extra, 'Kit', 'acme-logo.svg')), 'files stay on disk');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('settings.json can rename Organize folders, but not escape Downloads', async () => {
  const { organizeTarget, DEFAULT_FOLDERS } = await import('../src/classify.mjs');
  const { SETTINGS_PATH } = await import('../src/config.mjs');
  assert.equal(organizeTarget({ category: 'image', subcategory: 'logo' }), DEFAULT_FOLDERS.logo);
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ folders: { logo: 'Images/Brand', pdf: '../../etc/PDFs', bogus: 'X' } }));
  try {
    assert.equal(organizeTarget({ category: 'image', subcategory: 'logo' }), 'Images/Brand');
    assert.equal(organizeTarget({ category: 'pdf' }), 'etc/PDFs');
    assert.equal(organizeTarget({ category: 'markdown' }), 'Docs/Markdown');
  } finally { fs.rmSync(SETTINGS_PATH); }
  assert.equal(organizeTarget({ category: 'image', subcategory: 'logo' }), DEFAULT_FOLDERS.logo);
});
