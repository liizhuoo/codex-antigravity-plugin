# Codex Prompt Recipes

Keep Codex prompts compact and structured with explicit XML tags. State the task, completion/verification contract, safety boundaries, and desired output shape.

## Scoped Implementation / Bugfix

```xml
<task>
[Describe the concrete implementation or bugfix in <repo>, including target files and constraints.]
</task>

<completeness_contract>
Resolve the task fully before stopping. Check edge cases and follow-on callers affected by your change.
</completeness_contract>

<verification_loop>
Run the relevant tests/build/lint checks after editing and verify all modified files. If a check fails, fix it before finishing.
</verification_loop>

<action_safety>
Keep changes strictly scoped to the task. Avoid unrelated refactors, renames, or formatting churn.
</action_safety>

<structured_output_contract>
Return:
1. summary of changes
2. touched files
3. verification commands run and exact outcomes
4. residual risks or open questions
</structured_output_contract>
```

## Root-Cause Diagnosis (Read-Only)

```xml
<task>
Diagnose why [failing test/behavior] occurs in this repository. Do not edit files.
</task>

<grounding_rules>
Ground every claim in inspected files or tool output. Clearly label hypotheses vs. verified facts.
</grounding_rules>

<structured_output_contract>
Return:
1. root cause
2. supporting evidence (file paths, symbols, command output)
3. smallest safe fix
</structured_output_contract>
```

## Follow-Up Turn (`thread_id`)

When continuing an existing `thread_id`, send only the incremental delta instead of repeating the initial context unless the goal changed materially.
