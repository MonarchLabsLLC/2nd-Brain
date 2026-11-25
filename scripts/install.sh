#!/bin/zsh
# One-step install for 2ndBrain on a Mac.
#   scripts/install.sh            install everything that this Mac supports
#   scripts/install.sh --no-app   skip the Dock app
# Safe to run again: it updates what is already installed.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
BUILD_APP=1
for a in "$@"; do [[ "$a" == "--no-app" ]] && BUILD_APP=0; done

say() { print -P "%B==>%b $1"; }
warn() { print -P "%F{yellow}!%f $1"; }

[[ "$(uname)" == "Darwin" ]] || { echo "2ndBrain runs on macOS only."; exit 1; }

# 1. Node.js 22.13 or later
if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Install it with:  brew install node   (or from https://nodejs.org)"; exit 1
fi
NODE_OK=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>22||(a===22&&b>=13)?1:0)')
if [[ "$NODE_OK" != 1 ]]; then
  echo "2ndBrain needs Node.js 22.13 or later. You have $(node -v). Update with:  brew upgrade node"; exit 1
fi
say "Node.js $(node -v)"

# 2. Dependencies
say "Installing dependencies"
npm install --no-fund --no-audit --loglevel=error

# 3. First index
say "Indexing ~/Downloads (the first run can take a minute)"
npm run --silent index || warn "The first index did not finish. The app will try again when it starts."

# 4. Start at login
say "Starting 2ndBrain at login"
"$DIR/scripts/install-login-item.sh"

# 5. MCP server for AI agents
MCP_ARGS=("$(command -v node)" --disable-warning=ExperimentalWarning "$DIR/src/mcp.mjs")
if command -v claude >/dev/null; then
  say "Connecting to Claude Code"
  claude mcp remove --scope user 2ndbrain >/dev/null 2>&1 || true
  claude mcp add --scope user 2ndbrain -- "${MCP_ARGS[@]}" >/dev/null && echo "   Added MCP server '2ndbrain' to Claude Code." \
    || warn "Could not add the MCP server to Claude Code. See README, section 'Use it from your AI agent'."
else
  warn "Claude Code (claude) not found. Search, Organize and the app still work. AI naming and the Claude Code tools need it."
fi
if command -v codex >/dev/null; then
  say "Connecting to Codex"
  codex mcp remove 2ndbrain >/dev/null 2>&1 || true
  codex mcp add 2ndbrain -- "${MCP_ARGS[@]}" >/dev/null && echo "   Added MCP server '2ndbrain' to Codex." \
    || warn "Could not add the MCP server to Codex. See README."
fi

# 6. Optional helpers
command -v pdftotext >/dev/null || warn "Optional: brew install poppler   (lets 2ndBrain search the text inside PDFs)"

# 7. Dock app
if [[ $BUILD_APP == 1 ]]; then
  if command -v swiftc >/dev/null && command -v rsvg-convert >/dev/null; then
    say "Building the Dock app"
    "$DIR/scripts/build-mac-app.sh"
  else
    warn "Dock app skipped. It needs Xcode Command Line Tools (xcode-select --install) and librsvg (brew install librsvg). Then run scripts/build-mac-app.sh"
  fi
fi

echo
say "Done. Open http://localhost:4321"
[[ -d "$HOME/Applications/2ndBrain.app" ]] && echo "   Or open ~/Applications/2ndBrain.app and drag it to your Dock."
