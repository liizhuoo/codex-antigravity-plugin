#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"

# GUI-launched apps on macOS/Linux often omit Homebrew, nvm, fnm, volta, and npm-global bins.
# Append fallback directories after existing PATH entries so user-chosen binaries win.
add_path() {
  [ -d "$1" ] || return 0
  case ":${PATH:-}:" in
    *":$1:"*) ;;
    *) PATH="${PATH:+$PATH:}$1" ;;
  esac
}

add_path "/opt/homebrew/bin"
add_path "/usr/local/bin"
if [ -n "${HOME:-}" ]; then
  add_path "${HOME}/.local/bin"
  add_path "${HOME}/.npm-global/bin"
  add_path "${HOME}/.volta/bin"
  add_path "${HOME}/.fnm/aliases/default/bin"

  NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  NVM_NODE_DIR="${NVM_DIR}/versions/node"
  if [ -d "${NVM_NODE_DIR}" ]; then
    nvm_default=""
    if [ -r "${NVM_DIR}/alias/default" ]; then
      IFS= read -r nvm_default < "${NVM_DIR}/alias/default" || true
      nvm_default="$(printf '%s' "${nvm_default}" | tr -d '[:space:]')"
      nvm_hops=0
      while [ -n "${nvm_default}" ] && [ "${nvm_hops}" -lt 5 ]; do
        if [ -r "${NVM_DIR}/alias/${nvm_default}" ]; then
          IFS= read -r nvm_next < "${NVM_DIR}/alias/${nvm_default}" || true
          nvm_next="$(printf '%s' "${nvm_next}" | tr -d '[:space:]')"
          [ -n "${nvm_next}" ] && [ "${nvm_next}" != "${nvm_default}" ] || break
          nvm_default="${nvm_next}"
          nvm_hops=$((nvm_hops + 1))
        else
          break
        fi
      done
    fi

    nvm_resolved=""
    if [ -n "${nvm_default}" ] && [ "${nvm_default}" != "node" ] && [ "${nvm_default}" != "stable" ]; then
      nvm_prefix="${nvm_default#v}"
      if [ -d "${NVM_NODE_DIR}/v${nvm_prefix}/bin" ]; then
        nvm_resolved="${NVM_NODE_DIR}/v${nvm_prefix}/bin"
      elif [ -d "${NVM_NODE_DIR}/${nvm_default}/bin" ]; then
        nvm_resolved="${NVM_NODE_DIR}/${nvm_default}/bin"
      else
        for nvm_ver in $(ls -1 "${NVM_NODE_DIR}" 2>/dev/null | sed 's/^v//' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
          case "${nvm_ver}" in
            "${nvm_prefix}"|"${nvm_prefix}".*)
              if [ -d "${NVM_NODE_DIR}/v${nvm_ver}/bin" ]; then
                nvm_resolved="${NVM_NODE_DIR}/v${nvm_ver}/bin"
                break
              elif [ -d "${NVM_NODE_DIR}/${nvm_ver}/bin" ]; then
                nvm_resolved="${NVM_NODE_DIR}/${nvm_ver}/bin"
                break
              fi
              ;;
          esac
        done
      fi
    fi

    if [ -n "${nvm_resolved}" ]; then
      add_path "${nvm_resolved}"
    else
      for nvm_ver in $(ls -1 "${NVM_NODE_DIR}" 2>/dev/null | sed 's/^v//' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
        add_path "${NVM_NODE_DIR}/v${nvm_ver}/bin"
        add_path "${NVM_NODE_DIR}/${nvm_ver}/bin"
      done
    fi
  fi
fi

export PATH

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[codex-mcp] Could not locate 'node' in PATH ($PATH)" >&2
  exit 127
fi

exec "$NODE_BIN" "${PLUGIN_DIR}/server.mjs" "$@"
