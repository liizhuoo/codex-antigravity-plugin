---
trigger: model_decision
description: Routing guidance whenever the user wants to delegate coding, debugging, or review work to OpenAI Codex.
---

When the user asks to delegate work to Codex:

- Use the `codex` custom subagent (`invoke_subagent` with `TypeName: "codex"`) or the `codex_run` / `codex_review` MCP tools (from `codex_bridge`), following the `codex-delegate` or `codex-review` skill.
- Do not invoke raw `codex` CLI commands directly inside `run_command`, as the terminal sandbox lacks login PATH and network access.
- Choose `worktree: true` vs. current workspace (`worktree: false`) based on concurrency, conflict risk, and whether uncommitted working-tree changes are needed.
