# Plugin Host Spec

This spec captures the `KRN-02` plugin-host behavior that the core package must keep stable while the rest of the framework grows around it.

## Required Behavior

- Plugins register through a host-owned manifest.
- Manifests are validated before storage.
- Dependency order is deterministic and stable for independent plugins.
- Missing dependencies produce actionable diagnostics that name the plugin, the missing dependency, and the registered set.
- Lifecycle hooks run in dependency order for setup/start and reverse order for stop.
- The host exposes registries for registered plugins and normalized manifests.

## Shape Notes

- Plugin ids are normalized as trimmed strings.
- Dependency lists are normalized and deduplicated at registration time.
- The current core implementation keeps the contract local to `@generic-ai/core` until the SDK contract sweep lands in `KRN-01`.
