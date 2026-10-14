# Source this to build/test with the official nodejs.org runtime that
# `pnpm package:mac` downloads and verifies (never Hermes' private node):
#   source scripts/env.sh
_iphone_ai_root="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)"
_iphone_ai_node="$_iphone_ai_root/.cache/node/node-v22.22.3-darwin-arm64/bin"
if [ -x "$_iphone_ai_node/node" ]; then
  export PATH="$_iphone_ai_node:$PATH"
  echo "Using official Node $(node --version) from $_iphone_ai_node"
else
  echo "Official Node not found; run: pnpm package:mac -- --stage-only (downloads and verifies it)" >&2
fi
