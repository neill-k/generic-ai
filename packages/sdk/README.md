# @generic-ai/sdk

The framework-facing SDK. This package defines the contracts plugin authors and preset authors depend on so they never need to import from `@generic-ai/core` directly.

Current SDK contents:

- Canonical config concern types for `framework`, `agent`, `plugin`, `preset`, and the resolved config layer
- Schema-authoring helpers for config contracts and plugin config fragments
- JSON Schema emission interfaces for frozen machine-readable artifacts under `contracts/config/`
- Generic preset and bootstrap contract types used by core and preset packages

The SDK is the stable public surface plugins compile against. The kernel is free to evolve its internals behind this boundary.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
