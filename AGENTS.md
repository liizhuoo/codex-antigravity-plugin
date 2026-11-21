# Codex Antigravity Plugin — Maintenance Guide

This file is contributor/maintenance guidance for the plugin repository itself. Antigravity does not inject plugin-root `AGENTS.md` into unrelated workspaces; agents load it only when working inside this repository or when explicitly fixing/improving this plugin after hitting a real issue in use.

## Scope & Authorization

- Do **not** silently edit this global plugin while working on an unrelated user repository.
- When real usage exposes a genuine bug, protocol mismatch, or recurring workflow friction in the plugin itself, report the symptom, root cause, and proposed fix first; edit the plugin once the user confirms (or directly when the user asks to fix/improve the plugin).
- The `codex` subagent (`agents/codex.md`) runs in a sandboxed delegation role and must **not** self-modify the plugin—only report the issue back to the parent agent.

## Repository Layout & Reload Boundary

Changes fall into two layers with different reload behavior in Antigravity:

1. **Prompt / routing layer (live on next turn / next subagent — no MCP restart needed)**
   - `skills/codex-delegate/SKILL.md`, `skills/codex-delegate/references/prompt-recipes.md`
   - `skills/codex-review/SKILL.md`
   - `agents/codex.md`
   - `rules/codex-routing.md`
   - Keep these lean; do not add extra always-on rules or standalone maintenance skills that pollute unrelated conversations.
2. **MCP bridge / launcher layer (requires restarting `codex_bridge` to take effect)**
   - `server.mjs` — MCP tool schemas, input validation, server instructions
   - `lib/app-server.mjs` — `codex app-server` JSON-RPC client, PATH fallback, timeouts, notification opt-outs
   - `lib/bridge.mjs` — thread/turn state, cache-preserving continuation, concurrency guards, memory pruning
   - `lib/worktree.mjs` — managed git worktrees (`~/.codex-mcp/worktrees`) and external metadata (`~/.codex-mcp/meta`)
   - `scripts/launch-mcp.sh`, `mcp_config.json`
   - After modifying any file in this layer, explicitly remind the user to restart/reload the `codex_bridge` MCP server (or open a new session) before testing through live Antigravity tool calls.

## Diagnosing Issues Before Editing

Classify the failure before touching code:
- **Prompt / routing friction**: fix in `skills/`, `agents/codex.md`, or `rules/codex-routing.md`.
- **Bridge / worktree / state bug**: reproduce in `test/fake-codex.mjs` + `test/server.test.mjs`, then fix in `server.mjs` or `lib/`.
- **Upstream `codex-cli` protocol drift**: inspect `codex --version` and generate the live schema to a temporary directory before guessing fields:
  ```bash
  codex app-server generate-ts --out /tmp/codex-schema && ls /tmp/codex-schema
  ```
  Remove `/tmp/codex-schema` after inspecting.

## Invariants to Preserve

- **GPT-6.2 prompt cache & thread continuity**: Pass initial `model` and `effort` into `thread/start`, preserve thread-scoped `model`/`effort` across follow-ups and `thread/resume`, and omit unchanged `cwd`/`approval`/`model`/`effort` overrides on `turn/start`.
- **Antigravity subagent compatibility**: Do **not** add a `tools:` allowlist field to `agents/codex.md` (known Antigravity issue where tool-name filtering can hang subagents).
- **Worktree isolation & safety**: Keep metadata external under `~/.codex-mcp/meta` (never dirtying the worktree), preserve canonical `realpathSync` + linked-worktree ownership checks in `removeWorktree`, and leave no stray worktrees/meta files after tests.
- **PATH precedence**: Append fallback directories (`Homebrew`, `nvm`, `fnm`, `volta`, etc.) *after* the user's `PATH` so user-selected binaries always win.
- **Public repo hygiene**: Never hardcode machine-local paths (e.g., `/Users/...`) or personal credentials in tracked files. Keep `plugin.json` limited to valid Antigravity manifest fields.

## Verification & Release Checklist

1. **Offline unit & protocol tests (always run, zero quota)**:
   ```bash
   npm test
   ```
   Add or update regression coverage in `test/fake-codex.mjs` and `test/server.test.mjs` for any bridge/worktree/server fix.
2. **Low-cost live E2E (when bridge, protocol, or launcher changed)**:
   ```bash
   node test/e2e.mjs /tmp/codex-smoke --model gpt-6-luna --effort low
   ```
   Clean up `/tmp/codex-smoke` afterward. Use `gpt-6.2-sol` (`--effort low`) only when specifically verifying GPT-6.2 caching or model-specific behavior.
3. **Version bumps (for user-visible releases)**: Keep `plugin.json`, `package.json`, `server.mjs`, and `lib/app-server.mjs` (`clientInfo.version`) in sync, and update `README.md` if behavior or setup changed.
4. **Git sync**: Check `git status` and `git diff` to verify no local paths or stray artifacts are staged; commit cleanly, and push only when requested or confirmed by the user.
