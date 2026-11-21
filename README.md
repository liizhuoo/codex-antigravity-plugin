# codex-antigravity-plugin

An [Antigravity](https://antigravity.google) global plugin and MCP bridge that lets Antigravity delegate coding, debugging, refactoring, and code reviews to **OpenAI Codex** just like a native subagent.

Built on top of [`codex app-server`](https://developers.openai.com/codex/) (compatible with Codex CLI `>= 0.154.0`, tested on `0.162.0`—note that legacy `codex mcp-server` was removed in `0.154.0`).

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

Targeted improvements for **Antigravity**:
1. **Native Antigravity Subagent (`agents/codex.md`)**: Call `invoke_subagent(TypeName="codex")` (and follow up via `send_message`) so Codex work stays isolated from the main conversation context and runs cleanly in parallel.
2. **macOS/Linux GUI `PATH` & Sandbox Resilience**: `scripts/launch-mcp.sh` and `lib/app-server.mjs` resolve `node` and `codex` across Homebrew, nvm, fnm, volta, and standard paths so GUI-spawned MCP servers work even with stripped `PATH`.
3. **Antigravity Timeout Alignment**: Default `wait_seconds` is `90` (via `CODEX_WAIT_SECONDS`) with `timeoutSeconds: 600` in `mcp_config.json`, preventing premature MCP tool timeouts during `high`/`xhigh` reasoning runs.
4. **Full Diff & Worktree Lifecycle**: Captures `turn/diff/updated` (including shell-command edits missed by `fileChange` items) and exposes `codex_worktree` (`list`, `diff`, safe `remove` with dirty-tree guard).
5. **Multimodal Input**: `codex_run` accepts `images` (`localImage` paths) for screenshots or UI mockups.

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
