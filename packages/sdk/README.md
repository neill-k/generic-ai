# @generic-ai/sdk

The framework-facing SDK. This package defines the contracts plugin authors and preset authors depend on so they never need to import from `@generic-ai/core` directly.

Planned SDK contents (see `docs/planning/02-architecture.md` section "SDK Responsibilities"):

- Plugin manifest contract
- Plugin lifecycle contract
- Registry contracts
- Config-schema contract
- Scope contract
- Storage contract
- Workspace contract
- Queue contract
- Output-plugin contract
- Typed helpers for writing plugins and presets
- Re-exports of `pi` primitives where that materially improves plugin author ergonomics

The SDK is the stable public surface plugins compile against. The kernel is free to evolve its internals behind this boundary.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
