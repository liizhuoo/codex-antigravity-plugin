#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"

# GUI-launched apps on macOS/Linux often omit Homebrew, nvm, fnm, volta, and npm-global bins.
add_path() {
  [ -d "$1" ] || return 0
  case ":${PATH:-}:" in
    *":$1:"*) ;;
    *) PATH="$1${PATH:+:$PATH}" ;;
  esac
}

add_path "/opt/homebrew/bin"
add_path "/usr/local/bin"
add_path "${HOME}/.local/bin"
add_path "${HOME}/.npm-global/bin"
add_path "${HOME}/.volta/bin"
add_path "${HOME}/.fnm/aliases/default/bin"

if [ -d "${HOME}/.nvm/versions/node" ]; then
  for dir in "${HOME}/.nvm/versions/node"/*/bin; do
    add_path "$dir"
  done
fi

export PATH

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[codex-mcp] Could not locate 'node' in PATH ($PATH)" >&2
  exit 127
fi

exec "$NODE_BIN" "${PLUGIN_DIR}/server.mjs" "$@"
