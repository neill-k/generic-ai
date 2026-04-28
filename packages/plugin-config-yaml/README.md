# @generic-ai/plugin-config-yaml

Canonical YAML config plugin for Generic AI. Implements the config discovery and validation story the kernel expects from a config plugin.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Load canonical YAML config files from the documented `.generic-ai/` layout
- Validate plugin-registered schema fragments before startup completes
- Produce a single resolved config object for the framework
- Surface actionable diagnostics on malformed or invalid config

Current exports:

- deterministic config discovery from the nearest `.generic-ai/` root
- resolution of `framework`, `hooks`, `agents/*`, `harnesses/*`, and `plugins/*` into one final config object with source provenance
- plugin schema-fragment registry and namespace composition helpers
- startup-time validation with structured diagnostics
- `loadCanonicalConfig`, which starter presets can inject into `@generic-ai/core`'s config-aware bootstrap path so YAML is resolved and validated before runtime start

Config is canonical and file-first. See the canonical config layout in `docs/planning/02-architecture.md`.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
