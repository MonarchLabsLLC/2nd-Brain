// Path rules that work the same on macOS and Windows.
// Windows paths are case-insensitive and use "\", so plain string checks are not enough there.
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';

const key = (p) => (IS_WIN ? p.toLowerCase() : p);

/** True when a and b name the same place. Both should already be absolute. */
export function samePath(a, b) {
  return key(path.resolve(a)) === key(path.resolve(b));
}

/** True when child is strictly inside parent. Works when parent is a drive root like C:\ too. */
export function isWithin(child, parent) {
  const c = key(path.resolve(child));
  let p = key(path.resolve(parent));
  if (!p.endsWith(path.sep)) p += path.sep;
  return c.startsWith(p) && c.length > p.length;
}

/** child is parent itself, or inside it. */
export const isInsideOrSame = (child, parent) => samePath(child, parent) || isWithin(child, parent);

/** Relative paths are stored with "/" on every system, so the index, the app and the MCP tools agree. */
export const toPosix = (rel) => rel.split(path.sep).join('/');

/** rel_path (with "/") of a file inside a location, and its top-level subfolder (null for loose files). */
export function relInfo(full, root) {
  const rel = toPosix(path.relative(root, full));
  const parts = rel.split('/');
  return { rel, folder: parts.length > 1 ? parts[0] : null };
}

/** Last part of a path written with either separator. */
export const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
