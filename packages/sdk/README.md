# @generic-ai/sdk

The framework-facing SDK for Generic AI. This package is the public contract
surface plugin authors and preset authors compile against.

## What lives here

- `src/contracts/` for the typed contract surface
- `src/helpers/` for ergonomic contract constructors
- package-level docs and contract tests that keep the surface honest

## Contract surface

The SDK defines the contract families planned in
`docs/planning/02-architecture.md`:

- plugin contracts
- registry contracts
- lifecycle hooks
- config-schema contracts
- scope contracts
- storage contracts
- workspace contracts
- queue contracts
- output-plugin contracts

The contract modules are intentionally kernel-agnostic. They do not import
`@generic-ai/core`, and they do not require private kernel knowledge to
implement.

## Helper surface

The helper layer is intentionally small and mostly ergonomic:

- `definePlugin`
- `defineLifecycle`
- `defineConfigSchema`
- `createRegistry`
- `createScope`
- `defineStorage`
- `defineWorkspace`
- `defineQueue`
- `defineOutputPlugin`

These helpers do not add policy. They keep plugin author code concise while
staying faithful to the public contract shape.

## Reference documents

- `contracts/sdk/README.md`
- `specs/sdk/README.md`
- `docs/decisions/0004-sdk-contracts.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`

