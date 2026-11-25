#!/usr/bin/env node
import { refresh } from './indexer.mjs';
import { searchFiles, stats } from './queries.mjs';
import { createPlan } from './organize.mjs';

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'index') {
  const t = Date.now();
  const r = await refresh();
  console.log(`Indexed ${r.total} items (${r.added} new, ${r.changed} changed, ${r.removed} removed) in ${((Date.now() - t) / 1000).toFixed(1)}s`);
} else if (cmd === 'stats') {
  console.log(JSON.stringify(stats(), null, 2));
} else if (cmd === 'search') {
  const { total, items } = searchFiles({ q: rest.join(' '), limit: 20 });
  console.log(`${total} matches`);
  for (const f of items) console.log(`${f.category}${f.subcategory ? '/' + f.subcategory : ''}\t${f.rel_path}`);
} else if (cmd === 'plan') {
  const p = createPlan();
  console.log(`Plan ${p.plan_id}: ${p.count} files would move. Nothing moved.`);
  for (const g of p.groups) console.log(`  ${g.n}\t-> ${g.to_dir}`);
  console.log(`Skipped: ${p.skipped.length}`);
} else {
  console.log('Usage: node src/cli.mjs index | stats | search <words> | plan');
}
