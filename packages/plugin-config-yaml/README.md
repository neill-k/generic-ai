# @generic-ai/plugin-config-yaml

Canonical YAML config plugin for Generic AI. Implements the config discovery and validation story the kernel expects from a config plugin.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Load canonical YAML config files from the documented `.generic-ai/` layout
- Validate plugin-registered schema fragments before startup completes
- Produce a single resolved config object for the framework
- Surface actionable diagnostics on malformed or invalid config

Config is canonical and file-first. See the canonical config layout in `docs/planning/02-architecture.md`.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
