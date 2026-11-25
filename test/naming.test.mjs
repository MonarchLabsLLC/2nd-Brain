import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.SECONDBRAIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), '2ndbrain-naming-'));
const { isJunkName, cleanName } = await import('../src/naming.mjs');

test('junk names are found', () => {
  for (const n of [
    '036fbdbf-d74b-48f2-8e65-533de02e1b2a', '5ea652accb7eb269a13e37a78eabb47d', '1778294885971', '20260219_001',
    '2026-03-07_13-16-35', 'Screenshot 2026-01-01 at 10.00.00', 'CleanShot 2026-04-02 at 09.12.44@2x', 'IMG_4821',
    'image (3)', 'image', 'Untitled', 'Untitled 147', 'untitled-design (4)', 'Untitled design', 'download (2)',
    'ChatGPT Image Mar 3, 2026, 10_12_55 AM', 'Gemini_Generated_Image_k3j9x2m1p0q7', 'PXL_20260101_123456789',
    'unnamed', 'document (1)', 'photo_2026-05-01 12.00.00', 'a8F3kd92LmQ0zx71',
  ]) assert.ok(isJunkName(n), n);
});

test('real names are kept', () => {
  for (const n of [
    'Acme Logo', 'Contract Strategy Comparison', '27-key-questions-about-public-speaking',
    '1756222833_logoacme', 'acme-logo', 'download-instructions', 'Image Gallery Mockup', 'screenshot-tool-review',
    'photo_booth_banner', 'test-results', 'testimonials', 'document-signing-guide', '50× Customer Spotlight',
    'Outreach-Agent-User-Guide', 'pricing-base', '0630-transcript', '01-video-editing-training',
    'Untitled Goose Game Notes', 'ui-icons_ffffff_256x240',
  ]) assert.ok(!isJunkName(n), n);
});

test('proposed names are cleaned', () => {
  assert.equal(cleanName('Acme Launch Banner.png', 'png'), 'Acme Launch Banner');
  assert.equal(cleanName('a/b:c', 'md'), 'a b c');
  assert.equal(cleanName('   ', 'md'), null);
  assert.equal(cleanName('x'.repeat(200), 'md').length, 80);
});
