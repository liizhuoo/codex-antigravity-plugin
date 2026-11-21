---
name: codex-review
description: >-
  Run an independent read-only or adversarial code review with OpenAI Codex on
  uncommitted changes, branch diffs, or a specific commit. Use when the user asks
  Codex to review code or invokes /codex-review.
---

# Codex Code Review

## Procedure

1. Determine review target inside the git repository (`cwd`):
   - Default: `target: "uncommitted"`
   - Branch comparison: `target: "base"`, `base_branch: "<branch>"`
   - Single commit: `target: "commit"`, `commit_sha: "<sha>"`
2. Choose review style:
   - Standard bug/regression review: `adversarial: false`
   - Deep design/tradeoff challenge (concurrency, state, failure modes): `adversarial: true`, plus optional `focus` string.
3. Call `codex_review` with `wait_seconds: 90` (and poll with `codex_wait` if `status === "inProgress"`).
   - Leave `model` and `effort` unset unless the user requested specific overrides.
   - If custom instructions ask Codex to run `git status` or `git diff` in a `read-only` sandbox, use `git --no-optional-locks` so git does not attempt `.git/index.lock` writes.

## Result-Handling Rules

- Present findings ordered by severity, preserving exact file paths, line references, and evidence boundaries from Codex's `review` output.
- If Codex reports no findings, say so explicitly and note any brief residual risk.
- **STOP after presenting review findings**: Do not edit code or auto-apply fixes unless the user explicitly asks you (or Codex) to fix specific items.
- Include the `thread_id` so the user or agent can follow up on the review thread if needed.
