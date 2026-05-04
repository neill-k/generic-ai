# Harness Contracts

The canonical v0.1 TypeScript contract surface lives in
`@generic-ai/sdk` under `src/harness/` and is exported from the package root.

This directory is reserved for frozen machine-readable artifacts once the v0.1
schema is promoted from typed contract to frozen external contract. Until then,
use:

- `packages/sdk/src/harness/types.ts` for public contract types,
- `packages/sdk/src/harness/compiler.ts` for deterministic DSL to IR checks,
- `packages/sdk/src/harness/report.ts` for evidence-backed report helpers,
- `specs/harness-v0.1/README.md` for the normative language boundary.

Compiled harnesses also carry the typed `CapabilityBOM` inventory from the SDK.
It is the current source of truth for package/capability/protocol/policy
fingerprints until a frozen machine-readable BOM schema is promoted here.

Do not add lab-specific nouns to this contract. Architecture Lab is the flagship
proof surface built on the language, not the language itself.
