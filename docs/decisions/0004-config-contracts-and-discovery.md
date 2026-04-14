# 0004: Config Contracts And Discovery

## Context

`CFG-01`, `CFG-02`, and `CFG-03` establish the first real configuration surface for the framework. The planning pack already fixes several non-negotiables:

- config is canonical, not ad hoc
- config is YAML-based and split by concern
- config must be machine-readable and composable
- startup should resolve one final config object rather than a stack of runtime overrides

Those requirements affect the SDK, the config plugin, the starter preset, the contracts directory, and contributor-facing docs.

## Decision

We will use a Zod-backed config model in code and publish JSON Schema artifacts as the frozen machine-readable contract.

The implementation rules are:

- Canonical config concerns are `framework`, `agent`, `plugin`, and `preset`.
- Runtime schemas live in `@generic-ai/sdk` and are authored with Zod so TypeScript inference, validation, and composition stay in one place.
- Frozen contract artifacts live under `contracts/config/` as JSON Schema generated from the canonical SDK schemas.
- `@generic-ai/plugin-config-yaml` owns file discovery, YAML parsing, schema-fragment registration, schema composition, validation, and resolution into one final config object.
- The filesystem layout stays fixed and narrow. The plugin discovers the nearest `.generic-ai/framework.yaml`, then loads only the canonical concern files from that root.
- v1 does not add a separate user-facing `preset.yaml`. Preset behavior is defined by the preset contract/package and by the resolved framework/plugin config, not by a standalone preset selection file.
- Plugin-owned config extends the root schema through explicit fragment registration, deterministic ordering, and namespaced composition under plugin-controlled keys.
- Validation happens before startup completes. YAML syntax problems and schema validation failures are reported separately, with file/provenance details preserved in diagnostics.

## Consequences

- The SDK becomes the source of truth for config contracts rather than scattering validation logic across plugins.
- The contracts directory gains stable JSON Schema files that docs and future contract tests can consume.
- `@generic-ai/plugin-config-yaml` can surface actionable diagnostics because it owns both file provenance and validation output.
- The framework avoids a general-purpose config search system. That keeps behavior predictable and aligned with the planning pack.
- Preset selection stays package-driven in v1, which keeps the public config layout simpler at the cost of deferring user-selectable preset files to a later decision if they become necessary.

## Alternatives Considered

### JSON Schema-first authoring with Ajv/TypeBox

Rejected for now. It would make the machine-readable artifact primary, but it adds more authoring surface area at a point where the repo still needs fast iteration across SDK and plugin contracts. Zod gives us a smaller implementation surface while still letting us emit JSON Schema artifacts.

### Ad hoc per-plugin validation

Rejected. It would make plugin ownership easy in the short term, but it would fragment diagnostics, reduce composability, and make a frozen contract surface much harder to maintain.

### Broad config search similar to `cosmiconfig`

Rejected. Borrowing the “walk upward to the nearest config root” idea is useful, but broad file search conflicts with the repo’s explicit canonical layout and would make discovery less predictable.
