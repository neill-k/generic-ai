# examples/starter-hono

Reference example for the Generic AI starter preset. This directory is still a stub until `TRN-03`, but `CFG-04` establishes the preset contract that this example will consume.

## Intended bootstrap shape

The example should use the preset package contract directly, then pass that contract into top-level bootstrap wiring from `@generic-ai/core`.

```ts
import { starterPresetContract, withStarterPreset } from "@generic-ai/preset-starter-hono";
// import { createGenericAI } from "@generic-ai/core";

// const app = withStarterPreset(createGenericAI, { scope: { id: "example" } });
// or explicitly:
// const app = createGenericAI({ scope: { id: "example" }, preset: starterPresetContract });
```

This keeps package boundaries clear: core does not need to directly import preset/plugin packages.

## Starter preset extension points

When the example needs customization, use programmatic contract extension points:

- slot overrides (for replacing defaults like storage/transport)
- addon plugins before/after a slot anchor

There is no separate user-facing `preset.yaml` file in v1.

## Planning baseline

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
