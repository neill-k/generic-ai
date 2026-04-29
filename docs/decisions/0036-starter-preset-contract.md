# 0036: Starter Preset Contract

- Status: accepted
- Date: 2026-04-13
- Renumbered from: `0005-starter-preset-contract.md` to keep ADR numbers unique
  after Plan 05 W1.5.

## Context

`CFG-04` needs the starter preset to become a first-class contract without violating the repo's package-boundary rules. The planning pack wants the starter path to be the easiest way to get to “it works,” but `docs/package-boundaries.md` also says the kernel must remain preset-agnostic.

## Decision

The preset contract is owned by `@generic-ai/sdk`, and `@generic-ai/preset-starter-hono` is the default implementation of that contract.

The contract rules are:

- A preset is a strict SDK-owned object that describes identity, config surface, bundled plugin intent, and composition behavior.
- `@generic-ai/core` exposes a generic bootstrap API that accepts a preset contract. It does not import preset packages directly.
- `@generic-ai/preset-starter-hono` exports the starter preset definition and may also export a convenience bootstrap helper that calls the generic core bootstrap with itself.
- Preset extension points stay explicit: plugin replacement, config overrides, and named composition hooks. Presets do not gain arbitrary mutation callbacks into core internals.
- The starter preset remains the documented default path for end users, but the layering rule stays intact because the preset package depends on core, not the other way around.

## Consequences

- The kernel stays minimal and package-boundary compliant.
- Presets become reusable, testable public contracts rather than informal bundles of plugin choices.
- The starter package can own its docs and extension points cleanly.
- Users get a straightforward entrypoint without forcing the core package to know about a specific preset implementation.

## Alternatives Considered

### Import the starter preset directly inside `@generic-ai/core`

Rejected. It violates the current package-boundary guidance and couples the kernel to one preset implementation.

### Put preset selection in a dedicated `preset.yaml`

Rejected for v1. The planning pack already requires a canonical config layout, and the simpler first step is to keep preset identity package-driven while the config system matures.

### Make presets loosely typed option bags

Rejected. That would make extension fast in the short term but weakens the public contract and makes composition behavior harder to document and validate.
