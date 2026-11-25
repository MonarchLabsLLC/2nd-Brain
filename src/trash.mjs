// Move files to the macOS Trash, so Finder's "Put Back" still works. Never a permanent delete.
// macOS 14 and later ship /usr/bin/trash. Older versions fall back to asking Finder.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HAS_TRASH_CLI = fs.existsSync('/usr/bin/trash');

/** Move one or more paths to the Trash. Throws if any of them could not be moved. */
export async function moveToTrash(paths, timeout = 120_000) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return;
  if (HAS_TRASH_CLI) {
    await run('/usr/bin/trash', list, { timeout });
    return;
  }
  const script = [
    'on run argv',
    '  set theFiles to {}',
    '  repeat with p in argv',
    '    set end of theFiles to (POSIX file (p as text)) as alias',
    '  end repeat',
    '  tell application "Finder" to delete theFiles',
    'end run',
  ].join('\n');
  await run('/usr/bin/osascript', ['-e', script, ...list], { timeout });
}
