# 0028 - Web UI Plugin Console

## Status

Accepted.

## Context

The planning pack explicitly deferred the web UI. The framework now has enough
package-layer and harness/config contracts to resume a local-first console, but
the console must not become an unbounded application layer that imports kernel
internals, forks YAML persistence, or exposes unsafe localhost mutation routes.

## Decision

Ship the first web UI as `@generic-ai/plugin-web-ui`.

- The package is a plugin-layer package. It may depend on `@generic-ai/sdk`,
  `@generic-ai/plugin-config-yaml`, `@generic-ai/plugin-hono`, `pi`-compatible
  helper packages, and adapter-local browser/Hono libraries. It must not import
  `@generic-ai/core` or presets.
- Config mutation remains owned by `@generic-ai/plugin-config-yaml`. The web UI
  calls canonical transaction APIs for preview, validation, atomic write,
  rollback, conflict detection, and re-resolve verification.
- The Hono adapter must enforce local-console safety: loopback by default,
  refusal of non-loopback requests without explicit authorize plus remote opt-in,
  strict Origin checks for mutating routes, and a local session token for
  mutation.
- The template catalog may show broad multi-agent architecture shapes, but only
  templates backed by current primitives are runnable in v1: hierarchy,
  pipeline, critic-verifier, and hub-spoke/squad. Other shapes remain
  preview-only until protocol contracts exist.

## Consequences

- `scripts/check-package-boundaries.mjs` rejects unknown `@generic-ai/*`
  package kinds so future UI/package layers cannot silently fall into the
  unrestricted bucket.
- The starter Hono example mounts the console under `/console` and keeps the
  existing `/starter/*` routes intact.
- Browser code and server code are exported from separate subpaths and tested
  for import separation.
