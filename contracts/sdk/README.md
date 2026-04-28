# SDK contract freeze

This directory captures the frozen interface shape for `@generic-ai/sdk`.
It mirrors the public contract families implemented in
`packages/sdk/src/contracts/`.

## Frozen contract families

- plugin manifest and runtime context
- registry contract
- lifecycle contract
- config-schema contract
- scope contract
- storage contract
- workspace contract
- queue contract
- memory service contract
- output-plugin contract

## Freeze rule

Any change that breaks the contract surface should be accompanied by:

- an ADR update in `docs/decisions/`
- a package README update
- test updates in `packages/sdk/src/contracts/sdk-contracts.test.ts`

This directory does not hold implementation code.

