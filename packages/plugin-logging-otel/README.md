# @generic-ai/plugin-logging-otel

Structured logging plus OTEL tracing plugin. Subscribes to the kernel event stream and emits logs and traces without pushing output-shape decisions into the kernel.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide structured logging for framework and plugin events
- Emit OTEL traces for session and delegation lifecycle events
- Ship with OTEL export support from day one
- Document the instrumentation path for plugin authors

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
