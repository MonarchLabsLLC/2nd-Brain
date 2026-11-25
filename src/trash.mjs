// Move files to the macOS Trash or the Windows Recycle Bin, so they can be put back. Never a permanent delete.
import { moveListToTrash } from './platform/index.mjs';

/** Move one or more paths to the Trash. Throws if any of them could not be moved. */
export async function moveToTrash(paths, timeout = 120_000) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return;
  await moveListToTrash(list, timeout);
}
