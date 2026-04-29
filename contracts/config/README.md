# Config Contracts (`CFG-01`)

This directory freezes the canonical config contracts introduced by `NEI-317` (`CFG-01`).

Boundaries:

- YAML concerns (`.generic-ai/**`): `framework`, `hooks`, `agent`, `harness`, `plugin`
- Non-YAML concern: `preset` (preset package/default composition metadata)

Artifacts:

- `framework.schema.json` - `.generic-ai/framework.yaml`
- `hooks.schema.json` - `.generic-ai/hooks.yaml`
- `agent.schema.json` - `.generic-ai/agents/*.yaml`
- `harness.schema.json` - `.generic-ai/harnesses/*.yaml`
- `plugin.schema.json` - `.generic-ai/plugins/*.yaml`
- `preset.schema.json` - preset package metadata (not a dedicated user-facing `preset.yaml`)
- `resolved.schema.json` - single resolved config layer composed from concerns above
- `boundaries.json` - machine-readable concern boundary metadata
