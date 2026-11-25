// Everything that differs between macOS and Windows sits behind this one module.
// Each platform file exports the same names; see darwin.mjs for what each one does.
const impl = process.platform === 'win32' ? await import('./win32.mjs') : await import('./darwin.mjs');

export const {
  LABELS, imageInfo, onlineOnlySet, downloadSources, extractRichText,
  makeThumbnail, moveToTrash: moveListToTrash, reveal, openPath, pickFolder, claudeCommand,
} = impl;
