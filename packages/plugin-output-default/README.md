# @generic-ai/plugin-output-default

Default output and finalization plugin. Owns the final-response shaping step so the kernel can stay payload-agnostic.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide a default output/finalization strategy for the starter preset
- Keep final response shaping out of the kernel
- Stay replaceable by alternate output plugins registered through the SDK's output-plugin contract

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
