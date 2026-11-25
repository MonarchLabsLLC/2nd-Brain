#!/bin/zsh
# Remove 2ndBrain's login item, MCP registrations and Dock app.
#   scripts/uninstall.sh          keeps your index and settings
#   scripts/uninstall.sh --data   also deletes the index, thumbnails and settings
# Your files are never touched.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
"$DIR/scripts/uninstall-login-item.sh"
command -v claude >/dev/null && claude mcp remove --scope user 2ndbrain >/dev/null 2>&1 && echo "Removed the MCP server from Claude Code."
command -v codex >/dev/null && codex mcp remove 2ndbrain >/dev/null 2>&1 && echo "Removed the MCP server from Codex."
[[ -d "$HOME/Applications/2ndBrain.app" ]] && rm -rf "$HOME/Applications/2ndBrain.app" && echo "Removed ~/Applications/2ndBrain.app"
if [[ "${1:-}" == "--data" ]]; then
  rm -rf "$HOME/Library/Application Support/2ndBrain" && echo "Deleted the index, thumbnails and settings."
fi
echo "2ndBrain is uninstalled. You can delete this folder."
