#!/usr/bin/env node
// MCP server (stdio) so Claude Code can search and organize ~/Downloads.
// Reads the same SQLite index as the web app; works even when the web app is not running.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureFresh, refresh } from './indexer.mjs';
import { searchFiles, getFile, getFileByPath, setStar, addTags, setTags, stats } from './queries.mjs';
import { createPlan, applyPlan, undoBatch, history } from './organize.mjs';
import { findUnnamed, planFromProposals, cleanName } from './naming.mjs';
import { thumbnail } from './thumbs.mjs';
import { DOWNLOADS_DIR, PORT } from './config.mjs';
import { getRoots, addRoot, removeRoot, setRootActive } from './roots.mjs';
import { baseName } from './paths.mjs';

const TYPES = ['image', 'markdown', 'text', 'pdf', 'office', 'data', 'code', 'video', 'audio', 'archive', 'installer', 'font', 'other'];
const IMAGE_KINDS = ['logo', 'screenshot', 'photo', 'graphic'];

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

function brief(f) {
  return {
    id: f.id, name: f.name, path: f.path, type: f.category, image_kind: f.subcategory || undefined,
    location: f.root === DOWNLOADS_DIR ? 'Downloads' : f.root,
    folder: f.folder || '(top level)', size_kb: Math.round(f.size / 1024),
    modified: new Date(f.mtime).toISOString().slice(0, 10),
    dimensions: f.width ? `${f.width}x${f.height}` : undefined,
    source_url: f.source_url || undefined, starred: f.starred || undefined,
    tags: f.tags.length ? f.tags : undefined,
    match: f.snippet ? f.snippet.replace(/[«»]/g, '**') : undefined,
  };
}

function resolve({ id, path }) {
  const f = id != null ? getFile(id) : path ? getFileByPath(path) : null;
  return f;
}

const server = new McpServer({ name: '2ndbrain-downloads', version: '0.1.0' }, {
  instructions: `Index of the user's Downloads folder (${DOWNLOADS_DIR}) and any other folders the user added (see manage_locations), including subfolders.
Use search_downloads to find files (images, logos, markdown, PDFs and more) by name, folder, download URL or text inside the file.
Return the absolute path to the user. Organizing is two steps: plan_organize shows a plan and moves nothing;
apply_organize moves files and must only be called after the user approves that plan. Files are never deleted.
The visual app runs at http://localhost:${PORT} when started.`,
});

server.registerTool('search_downloads', {
  title: 'Search Downloads',
  description: 'Find files in the Downloads folder (and its subfolders) and any other added locations. Free-text query matches file names, folder names, the URL the file was downloaded from, tags, and text inside .md/.txt/.pdf/.docx/code files. Combine with filters. Returns absolute paths.',
  inputSchema: {
    query: z.string().optional().describe('Words to match, e.g. "acme logo" or "launch brief". Leave empty to list by filters only.'),
    location: z.string().optional().describe('Limit to one indexed location: "Downloads", a folder name like "Desktop", or an absolute path. Default: all locations.'),
    type: z.enum(TYPES).optional().describe('File type group. "markdown" = .md files, "image" = all images.'),
    image_kind: z.enum(IMAGE_KINDS).optional().describe('For images: logo, screenshot, photo, or graphic (everything else).'),
    folder: z.string().optional().describe('Top-level subfolder name inside Downloads, or "__loose" for files directly in Downloads.'),
    extension: z.string().optional().describe('Exact extension, e.g. "png", "svg", "md".'),
    tag: z.string().optional(),
    starred: z.boolean().optional(),
    modified_within_days: z.number().int().positive().optional(),
    sort: z.enum(['relevance', 'newest', 'oldest', 'name', 'largest']).optional(),
    limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  await ensureFresh();
  let root;
  if (a.location) {
    const want = a.location.toLowerCase();
    const hit = getRoots().find((r) => r.path.toLowerCase() === want || r.label.toLowerCase() === want);
    if (!hit) return fail(`Unknown location "${a.location}". Known: ${getRoots().map((r) => r.label).join(', ')}`);
    root = hit.path;
  }
  const r = searchFiles({
    root, q: a.query, category: a.type, subcategory: a.image_kind, folder: a.folder, ext: a.extension, tag: a.tag,
    starred: a.starred, since: a.modified_within_days ? Date.now() - a.modified_within_days * 86400000 : undefined,
    sort: a.sort, limit: a.limit || 20,
  });
  return json({ total_matches: r.total, showing: r.items.length, files: r.items.map(brief) });
});

server.registerTool('get_download_details', {
  title: 'File details',
  description: 'Full details for one indexed file, including the first part of its text content for documents. Pass the id or absolute path from search_downloads.',
  inputSchema: { id: z.number().int().optional(), path: z.string().optional(), max_chars: z.number().int().max(50000).optional() },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const f0 = resolve(a);
  if (!f0) return fail('File not found in the index. Search again; it may have moved.');
  const f = getFile(f0.id, { withContent: true });
  return json({ ...brief(f), birth: new Date(f.birthtime).toISOString(), content: f.content ? f.content.slice(0, a.max_chars || 4000) : undefined });
});

server.registerTool('downloads_overview', {
  title: 'Downloads overview',
  description: 'Counts by type, image kind, top-level folder and tag, plus total size. Good first call to see what is there.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  await ensureFresh();
  const s = stats();
  return json({
    locations: s.roots.map((r) => ({ name: r.label, path: r.path, files: r.n, organize: r.organize })), total_files: s.total, total_gb: +(s.bytes / 1e9).toFixed(2), loose_files: s.loose, starred: s.starred,
    types: s.categories.map((c) => ({ type: c.category, files: c.n })), image_kinds: s.imageSubs.map((x) => ({ kind: x.subcategory, files: x.n })),
    folders: s.folders.sort((a, b) => b.n - a.n).slice(0, 40), tags: s.tags,
  });
});

server.registerTool('tag_download', {
  title: 'Tag or star a file',
  description: 'Add tags, replace tags, or star/unstar a file so it is easy to find later.',
  inputSchema: {
    id: z.number().int().optional(), path: z.string().optional(),
    add_tags: z.array(z.string()).optional(), set_tags: z.array(z.string()).optional().describe('Replaces all tags'),
    starred: z.boolean().optional(),
  },
}, async (a) => {
  const f = resolve(a);
  if (!f) return fail('File not found in the index.');
  let out = f;
  if (a.set_tags) out = setTags(f.id, a.set_tags);
  if (a.add_tags) out = addTags(f.id, a.add_tags);
  if (a.starred != null) out = setStar(f.id, a.starred);
  return json(brief(out));
});

server.registerTool('plan_organize', {
  title: 'Plan: organize Downloads',
  description: 'Make a plan to move loose files (directly in Downloads) into folders such as Images/Logos, Images/Screenshots, Docs/Markdown, Docs/PDF. NOTHING MOVES. Subfolders, partial downloads and files changed in the last 24 hours are left alone. Show the plan to the user and ask before calling apply_organize.',
  inputSchema: { show_files: z.boolean().optional().describe('Include every file in the plan (can be long). Default: 8 examples per folder.') },
  annotations: { readOnlyHint: true },
}, async (a) => {
  await refresh();
  const p = createPlan();
  const byDir = {};
  for (const it of p.items) (byDir[it.to_dir] ||= []).push({ id: it.file_id, name: it.name });
  const skippedBy = {};
  for (const s of p.skipped) skippedBy[s.reason] = (skippedBy[s.reason] || 0) + 1;
  return json({
    plan_id: p.plan_id, files_to_move: p.count,
    destinations: Object.entries(byDir).sort((x, y) => y[1].length - x[1].length).map(([dir, items]) => ({
      folder: `Downloads/${dir}`, files: items.length, ...(a.show_files ? { items } : { examples: items.slice(0, 8).map((i) => i.name) }),
    })),
    left_alone: skippedBy,
    next_step: 'Ask the user to approve. Then call apply_organize with this plan_id (optionally exclude_ids).',
  });
});

server.registerTool('apply_organize', {
  title: 'Apply organize plan',
  description: 'Move the files in a plan from plan_organize. Only call after the user approved that plan. Moves only; never deletes or overwrites (name clashes get " (2)"). Returns a batch_id for undo_organize.',
  inputSchema: {
    plan_id: z.string(),
    exclude_ids: z.array(z.number().int()).optional().describe('File ids the user wants to keep where they are'),
    move_to: z.record(z.string(), z.string()).optional().describe('Optional map of file id to another folder inside Downloads, e.g. {"123": "Clients/Acme"}'),
  },
  annotations: { destructiveHint: false, idempotentHint: false },
}, async (a) => {
  try {
    const r = await applyPlan(a.plan_id, { exclude: a.exclude_ids || [], overrides: a.move_to || {} });
    refresh().catch(() => {});
    return json({ batch_id: r.batch_id, moved: r.moved, failed: r.failed });
  } catch (e) { return fail(e.message); }
});

server.registerTool('undo_organize', {
  title: 'Undo an organize run',
  description: 'Put files from an organize run back where they were. Without batch_id, undoes the latest run. Also lists past runs.',
  inputSchema: { batch_id: z.string().optional(), list_only: z.boolean().optional() },
}, async (a) => {
  const h = history();
  if (a.list_only) return json({ runs: h });
  const id = a.batch_id || h.find((x) => x.can_undo)?.batch_id;
  if (!id) return fail('There is no organize run to undo.');
  try {
    const r = await undoBatch(id);
    refresh().catch(() => {});
    return json(r);
  } catch (e) { return fail(e.message); }
});

server.registerTool('manage_locations', {
  title: 'Folders to search',
  description: 'List, add, remove, turn on or turn off folders that 2ndBrain indexes. A location that is off stays indexed but is left out of searches unless named with the location filter. Folders besides Downloads (for example ~/Desktop or ~/Documents/Brand). Removing only stops searching; no files are touched. Organize only ever changes Downloads.',
  inputSchema: { action: z.enum(['list', 'add', 'remove', 'turn_on', 'turn_off']), path: z.string().optional().describe('Absolute path or ~/path for add/remove') },
}, async (a) => {
  try {
    if (a.action === 'add') { addRoot(a.path); await refresh(); }
    const hit = getRoots().find((r) => r.path === a.path || r.label === a.path);
    if (a.action === 'turn_on' || a.action === 'turn_off') setRootActive(hit?.path || a.path, a.action === 'turn_on');
    if (a.action === 'remove') removeRoot(getRoots().find((r) => r.path === a.path || r.label === a.path)?.path || a.path);
    const s = stats();
    return json(s.roots.map((r) => ({ name: r.label, path: r.path, files: r.n, searched: r.active, missing: r.missing || undefined })));
  } catch (e) { return fail(e.message); }
});

server.registerTool('find_unnamed_files', {
  title: 'Find files with junk names (optimize)',
  description: 'Use when the user asks to "optimize" a folder or name unnamed files. Lists files whose names say nothing (UUIDs, hashes, "IMG_1234", "Screenshot 2026-...", "Untitled 147", "ChatGPT Image ..."). For each file it gives a small preview image path (Read it to see the image) or the start of the document text. Files with real names, files inside code projects and secret-looking files are left out. Then propose names, show them to the user, and call rename_files.',
  inputSchema: {
    location: z.string().optional().describe('"Downloads" (default), a location name, or an absolute path'),
    folder: z.string().optional().describe('Top-level folder name inside the location, or "__loose" for files directly in it. Omit for the whole location.'),
    limit: z.number().int().min(1).max(60).optional().describe('Default 20. Keep batches small; each image costs tokens.'),
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  await ensureFresh();
  const want = (a.location || 'Downloads').toLowerCase();
  const loc = getRoots().find((r) => r.path.toLowerCase() === want || r.label.toLowerCase() === want);
  if (!loc) return fail(`Unknown location "${a.location}". Known: ${getRoots().map((r) => r.label).join(', ')}`);
  const { files, skippedProject } = findUnnamed({ root: loc.path, folder: a.folder === '__loose' ? null : a.folder, limit: a.limit || 20 });
  const out = [];
  for (const f of files) {
    const item = { id: f.id, current_name: f.name, folder: f.rel_path.includes('/') ? f.rel_path.split('/').slice(0, -1).join('/') : '(top level)', type: f.category };
    if (f.category === 'image' || (!f.excerpt && ['pdf', 'doc', 'docx'].includes(f.ext))) {
      try { item.preview_image = await thumbnail(f); } catch { /* no preview */ }
    }
    if (f.excerpt) item.text_start = f.excerpt.slice(0, 800);
    out.push(item);
  }
  return json({
    location: loc.label, found: out.length, skipped_in_code_projects: skippedProject, files: out,
    naming_rules: '2 to 7 words, Title Case with spaces, no extension, specific (brand, product, person, topic). Screenshots end with "Screenshot". Skip a file if unsure.',
  });
});

server.registerTool('rename_files', {
  title: 'Rename files',
  description: 'Rename indexed files after the user approved the names. Give the new name without the extension; the extension is kept. Never overwrites (a clash gets " (2)"). Returns a batch_id; undo_organize with that id puts the old names back.',
  inputSchema: {
    renames: z.array(z.object({ id: z.number().int(), new_name: z.string() })).min(1).max(200),
  },
}, async (a) => {
  const proposals = [];
  const problems = [];
  for (const r of a.renames) {
    const f = getFile(r.id);
    if (!f) { problems.push(`id ${r.id}: not in the index`); continue; }
    const n = cleanName(r.new_name, f.ext);
    if (!n) { problems.push(`id ${r.id}: empty name`); continue; }
    proposals.push({ file_id: f.id, from: f.path, root: f.root, old_name: f.name, new_name: `${n}${f.ext ? '.' + f.ext : ''}` });
  }
  if (!proposals.length) return fail(`Nothing to rename. ${problems.join('; ')}`);
  const r = await applyPlan(planFromProposals(proposals));
  refresh().catch(() => {});
  return json({ batch_id: r.batch_id, renamed: r.moves.map((m) => ({ from: baseName(m.from), to: baseName(m.to) })), failed: r.failed, problems });
});

server.registerTool('reindex_downloads', {
  title: 'Reindex Downloads',
  description: 'Rescan Downloads now (normally automatic; searches refresh if the index is older than a minute).',
  inputSchema: {},
}, async () => json(await refresh()));

await server.connect(new StdioServerTransport());
