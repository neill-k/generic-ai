# @generic-ai/plugin-interaction

Structured user interaction capability for Generic AI.

This package adds two agent-facing behaviors:

- `ask_user` — block the current tool call until the user responds to a text, single-choice, or multi-choice question
- `task_write` — publish a visible task-list snapshot that a UI can monitor

The package keeps the interaction contract transport-agnostic. The core plugin
owns question lifecycle, validation, and task-list state; concrete delivery is
provided by transport adapters such as the bundled Hono SSE adapter.

Planned responsibilities (see `docs/planning/02-architecture.md` section
"Plugin Intent"):

- expose a capability-owned user interaction model rather than pushing it into
  the kernel
- keep question delivery transport-agnostic so Hono, a future TUI, and other
  consumers can all reuse the same service
- surface interaction to agents as standard `pi` tools

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
