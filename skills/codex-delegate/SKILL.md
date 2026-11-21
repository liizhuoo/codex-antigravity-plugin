---
name: codex-delegate
description: >-
  Delegate coding, refactoring, debugging, or parallel implementation tasks to
  OpenAI Codex using the `codex` subagent or `codex_*` MCP tools. Use when the
  user asks Codex to write/modify code, fix bugs, or run parallel tasks.
---

# Delegating Work to Codex

## Choosing Invocation Mode

1. **Subagent mode (recommended default for coding & parallel tasks)**:
   - Call `invoke_subagent` with `TypeName: "codex"`, a concise `Role` (e.g., `"Codex Refactor Worker"`), and a clear `Prompt` specifying:
     - `cwd` (absolute path of target repo/directory)
     - Whether to edit the current workspace or use an isolated `worktree: true`
     - Concrete goal, constraints, verification command, and any `model` / `effort` override
   - Follow up on the same Codex session anytime by messaging that subagent via `send_message`, or by calling `codex_run(thread_id=...)`.
2. **Direct MCP mode (lightweight single-turn or tight parent control)**:
   - Call `codex_run` directly from the main agent when you want direct control over `thread_id`, `wait_seconds`, `output_schema`, or batching (`codex_run(..., wait_seconds: 0)` across multiple `worktree: true` threads followed by `codex_wait`).
   - Do **not** shell out to `codex` CLI via `run_command`: the terminal sandbox strips `PATH` and restricts `~/.codex` / network access.

## Workspace vs. Worktree Decision Rule

- **Use current workspace (`worktree: false`, `sandbox: "workspace-write"`)** when:
  - Doing a sequential, scoped implementation or fix in the active branch.
  - Codex needs uncommitted edits already sitting in the working tree.
- **Use isolated worktree (`worktree: true`, `sandbox: "workspace-write"`)** when:
  - Running 2+ tasks in parallel on the same repository.
  - Attempting a broad, risky, or speculative change you want to inspect before merging.
  - Note: Git worktrees branch from `HEAD`. If `parent_dirty` is true, uncommitted parent changes are not in the worktree.

## Managing Worktrees & Verification

- In `worktree: true` + `sandbox: "workspace-write"`, instruct Codex to leave changes **uncommitted** inside the worktree (do not `git commit` inside the sandboxed linked worktree, where Seatbelt can block `.git/worktrees/.../index.lock`); inspect via `codex_worktree(action="diff", path=<worktree.path>)` and merge/commit from the main repo.
- Inspect worktree changes with `codex_worktree(action="diff", path=<worktree.path>)`.
- List active Codex worktrees with `codex_worktree(action="list", cwd=<repo>)`.
- Clean up after merging or discarding with `codex_worktree(action="remove", path=<worktree.path>, delete_branch=true)`.
- Always verify Codex's diff/tests yourself before declaring the overall task complete.

## Prompt Cache & Thread Continuity (GPT-6.2+)

- Reuse the same `thread_id` for related follow-ups in the same repo so the cached prompt prefix stays hot.
- Keep `model` and `effort` consistent across turns of a thread, and avoid introducing `output_schema` midway onto a warm coding thread—changing model, reasoning effort, or schema controls invalidates prompt caching and reasoning continuity.
- Check `token_usage.cache_hit_rate` and `token_usage.cache_write` in tool reports to verify cache efficiency.

## Prompt Recipes

See [references/prompt-recipes.md](references/prompt-recipes.md) for compact XML prompt templates adapted from OpenAI's Codex prompting guide.
