# 0005: Plugin Host And Deterministic Dependency Ordering

## Context

`KRN-02` asks for a kernel-owned plugin host that can register plugins, validate manifests, order dependencies deterministically, and run lifecycle hooks with useful diagnostics. The repository is still in the contract-building phase, so the SDK shape is not yet frozen. That means the kernel needs a working implementation now without coupling this change to an upstream SDK refactor.

The planning docs also require a machine-checkable plugin contract and explicit host behavior:

- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`

## Decision

Implement the first plugin host directly in `@generic-ai/core` with a small local contract surface:

- Plugin manifests are normalized and validated at registration time.
- Registered plugins are stored in kernel-owned registries for manifests and definitions.
- Dependency resolution uses a stable topological order so independent plugins retain registration order while dependencies always precede dependents.
- Lifecycle execution uses the same order for setup/start and reverse order for stop.
- Host errors carry actionable issue objects so callers can report missing dependencies, duplicate registrations, invalid manifests, and cycles without guessing.

The implementation stays local to `packages/core/src/plugin-host/**` and `packages/core/src/registries/**` until the SDK contract work lands.

## Consequences

- The host is usable now, even though the SDK contract package still only exposes a placeholder entrypoint.
- Dependency resolution is deterministic and testable, which reduces bootstrap flakiness as more plugins arrive.
- Error reporting becomes structured early, which makes it easier for the later preset/bootstrap code to surface failures cleanly.
- The local contract surface will likely need a follow-up sync with `KRN-01` once the shared SDK types are introduced.

## Alternatives Considered

1. Defer the host entirely until `@generic-ai/sdk` is fully defined.

   Rejected because `KRN-02` needs a concrete kernel implementation and the planning docs already require lifecycle and dependency rules to be testable.

2. Export only a monolithic opaque host with no registry or validation helpers.

   Rejected because that would make diagnostics and tests harder, and it would leave the eventual SDK contract without a clear shape to mirror.

3. Use a nondeterministic "first ready wins" ordering without stable tie-breaking.

   Rejected because independent plugins would then depend on incidental insertion details, which is exactly the kind of bootstrap drift this issue is trying to eliminate.
