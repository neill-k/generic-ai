# @generic-ai/plugin-output-default

Default output and finalization plugin for Generic AI. This package owns the fallback response-shaping step so the kernel can stay payload-agnostic.

## What It Provides

- `name` and `kind` package metadata
- `defaultOutputPlugin`: a stable default plugin instance
- `createDefaultOutputPlugin(options?)`: a package-local factory for replacement or customization
- `finalizeDefaultOutput(value, options?)`: a normalized final output record
- `renderDefaultOutput(value)`: the default human-readable renderer

## Assumptions

- Finalization is synchronous and package-local.
- Output values are expected to be serializable enough for `structuredClone` when possible, but the plugin falls back to the original value if cloning fails.
- Strings, plain objects, primitives, and `Error` instances are the main supported inputs.
- Plain objects can expose `text`, `summary`, `message`, `status`, and `metadata` fields for richer fallback behavior.
- `status` is a plugin-owned output concern, not a kernel-owned schema.
- Consumers can replace this package with any other output plugin that exposes the same local `render` and `finalize` shape.

## Example

```ts
import { finalizeDefaultOutput } from "@generic-ai/plugin-output-default";

const record = finalizeDefaultOutput({
  text: "Run completed successfully.",
  metadata: {
    runId: "run-123",
  },
});

console.log(record.summary);
```

## Package Boundaries

This package stays local to output formatting and finalization. It does not define shared SDK contracts or depend on kernel behavior.

## Tests

Package-local tests live in `test/index.test.ts` and run with the package `test` script.
