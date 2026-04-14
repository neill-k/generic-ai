# SDK contract specification

This directory records the behavioral expectations behind `@generic-ai/sdk`.
The package source is the primary implementation surface; this spec explains
how the contracts fit together.

## Behavioral expectations

- plugins can be authored without importing `@generic-ai/core`
- dependency declarations are explicit in plugin manifests
- lifecycle hooks are `Awaitable` so plugin authors can stay synchronous or async
- config schemas are machine-readable and composable
- scope objects preserve ancestry without assuming tenancy semantics
- storage, workspace, queue, and output remain replaceable adapters

## Sample flow

The package test `packages/sdk/src/contracts/sdk-contracts.test.ts` demonstrates
the intended authoring path:

- define a plugin manifest
- define a config schema
- wire lifecycle hooks
- register against a registry
- use storage, workspace, and queue through SDK contracts only
- finalize output through an output-plugin contract

