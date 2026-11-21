# codex-antigravity-plugin

An [Antigravity](https://antigravity.google) global plugin and MCP bridge that lets Antigravity delegate coding, debugging, refactoring, and code reviews to **OpenAI Codex** just like a native subagent.

Built on top of [`codex app-server`](https://developers.openai.com/codex/) (compatible with Codex CLI `>= 0.154.0`; `>= 0.166.0` recommended for GPT-6.2 prompt caching; tested on `0.171.0`—note that legacy `codex mcp-server` was removed in `0.154.0`).

[中文说明](#中文说明)

## Architecture

```text
Antigravity (Planner / Orchestrator)
  ├── invoke_subagent("codex")  ← agents/codex.md (isolated context, diff verification)
  ├── /codex-delegate           ← skills/codex-delegate/ (routing, workspace vs. worktree, XML prompt recipes)
  ├── /codex-review             ← skills/codex-review/ (standard & adversarial read-only review)
  └── MCP: codex_bridge         ← mcp_config.json → scripts/launch-mcp.sh → server.mjs
         └── persistent `codex app-server` JSON-RPC process (threads, approvals, diffs, worktrees)
```

### What this builds on & improves

This project stands on the shoulders of two open-source foundations:
- **[Goudu666/codex-app-server-mcp](https://github.com/Goudu666/codex-app-server-mcp)** (MIT): persistent `codex app-server` bridge, multi-turn `thread_id` continuity, async `wait_seconds`, two-way `codex_respond`, `codex_steer`, `codex_interrupt`, `codex_review`, and isolated git worktrees.
- **[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)** (Apache-2.0): XML prompt contracts, result-handling discipline, and adversarial review workflow.

Targeted improvements for **Antigravity** (`v0.2.1`):
1. **Native Antigravity Subagent (`agents/codex.md`)**: Call `invoke_subagent(TypeName="codex")` (and follow up via `send_message`) so Codex work stays isolated from the main conversation context and runs cleanly in parallel.
2. **macOS/Linux GUI `PATH` & Sandbox Resilience**: `scripts/launch-mcp.sh` and `lib/app-server.mjs` append Homebrew, nvm (preferring `~/.nvm/alias/default` or newest version), fnm, volta, and standard fallback paths *after* the user's `PATH` so GUI-spawned MCP servers work without overriding user-chosen binaries.
3. **Antigravity Timeout & RPC Recovery**: Default `wait_seconds` is `90` (`CODEX_WAIT_SECONDS`), `timeoutSeconds: 600` in `mcp_config.json`, and `CODEX_RPC_TIMEOUT_MS` (default `60000` ms, `initialize` capped at `45000` ms) kills wedged app-server children and respawns cleanly on timeout.
4. **GPT-6.2 Prompt Cache & Prefix Preservation**: Passes `model`/`effort` directly into `thread/start` (avoiding first-turn model-switch cache misses), preserves thread-scoped `model`/`effort` across follow-ups and `thread/resume` without bridge-default clobbering, omits unchanged `cwd`/`approval`/`model`/`effort` overrides on continuation turns, opts out of unused high-volume delta notifications, and reports `cache_hit_rate` and `cache_write` in `token_usage`.
5. **Hardened Worktree Lifecycle**: Metadata sidecars under `~/.codex-mcp/meta` keep worktree `git status` clean, capture `baseHead` so `codex_worktree(action="diff")` surfaces both committed-on-branch and uncommitted edits with UTF-8 byte-exact truncation, and enforce strict ownership checks (`~/.codex-mcp/worktrees` + linked worktree + sidecar/`codex/*`) before removal, with atomic rollback if `thread/start` fails.
6. **Concurrency & Bounded Memory**: Per-thread turn-start guards (`startingTurn`) and `thread/resume` deduplication (`loadingPromise`), plus automatic pruning of prior-turn items/diffs, `64 KiB` diff caps, and eviction of settled threads beyond `100`.
7. **Multimodal Input**: `codex_run` accepts `images` (`localImage` paths, validated before starting a thread/turn) for screenshots or UI mockups.

## Prerequisites

- Node.js `>= 20`
- OpenAI Codex CLI installed and authenticated (`npm i -g @openai/codex && codex login`)

## Install as a Global Antigravity Plugin

```bash
git clone https://github.com/liizhuoo/codex-antigravity-plugin.git ~/.gemini/config/plugins/codex
cd ~/.gemini/config/plugins/codex
npm install --omit=dev
```

Antigravity automatically discovers `~/.gemini/config/plugins/codex`.

## Workspace vs. Worktree Guide

| Scenario | Recommended Mode |
| --- | --- |
| Sequential bugfix/feature in active branch, or builds on uncommitted edits | Current workspace (`worktree: false`, `sandbox: "workspace-write"`) |
| Parallel tasks (`2+` workers), broad/risky refactor, or diff-before-merge | Isolated worktree (`worktree: true`, `sandbox: "workspace-write"`) |
| Code review, architecture challenge, or diagnosis without edits | Read-only (`codex_review` or `sandbox: "read-only"`) |

> Note: Git worktrees branch from `HEAD`, so uncommitted edits in the parent workspace are not included in a new worktree (`parent_dirty: true` warns when detected).

## MCP Tools (`codex_bridge`)

- `codex_run` — Start or continue (`thread_id`) a Codex task (`cwd`, `worktree`, `sandbox`, `approval`, `model`, `effort`, `images`, `web_search`, `output_schema`, `wait_seconds`)
- `codex_wait` — Wait on one or multiple threads (`mode: "all" | "any"`)
- `codex_status` — Non-blocking progress peek
- `codex_respond` — Answer pending approvals or user-input questions (`request_id`)
- `codex_steer` / `codex_interrupt` — Steer or stop a running turn
- `codex_review` — Native read-only or `adversarial: true` code review
- `codex_worktree` — `list`, `diff`, or safely `remove` managed worktrees under `~/.codex-mcp/worktrees`
- `codex_compact` / `codex_models` / `codex_threads` — Thread compaction, available models, and thread history (compatible with Codex App/CLI via `codex resume <thread_id>`)

## Tests

```bash
npm test                                               # offline unit + MCP protocol suite (zero quota)
node test/e2e.mjs /tmp/codex-scratch --model gpt-6-luna --effort low
```

---

## 中文说明

让 Antigravity 像调用原生 Subagent 一样调度本地 OpenAI Codex CLI（`codex app-server`，兼容 `>= 0.154.0`），并同时提供直接 MCP 调用与 `/codex-review`、`/codex-delegate` 工作流。

- **安装**：克隆本仓库到 `~/.gemini/config/plugins/codex` 并执行 `npm install --omit=dev` 即可全局生效。
- **使用方式**：
  - 直接在对话里让 Antigravity「让 codex 实现/修复/重构…」或「让 codex review 一下代码」，会自动通过 `codex` Subagent 或 `codex_*` MCP 工具调度。
  - **工作区 vs. Worktree**：单线局部修改/依赖未提交改动时直接改当前工作区；并发多任务或大重构时启用 `worktree: true` 隔离开发，完成后通过 `codex_worktree(action="diff")` 验收再合并清理。
  - **人工接管**：每次返回均附带 `thread_id`，随时可在终端运行 `codex resume <thread_id>` 继续同一会话。

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
