# Tool-Overuse Budget Fixture

This fixture demonstrates the NEI-526 report surface for measuring tool-use
discipline separately from final task correctness.

The benchmark includes three deterministic cases:

- `requires-workspace-read`: a tool is required because the answer depends on
  workspace evidence.
- `optional-context-lookup`: a tool is allowed but not required.
- `wasteful-arithmetic-tool`: a direct answer is expected and tool calls are
  counted as overuse.

Both candidates can score full `task_success`. The report still distinguishes
the disciplined candidate from the tool-happy candidate through tool-efficiency,
unnecessary-call, direct-answer opportunity, budget-violation, optional cost,
and optional latency evidence.

This is an evidence-surface fixture, not an external benchmark score claim.
