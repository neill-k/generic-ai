# 0029 - Memory Service Contract And Roadmap

## Status

Accepted.

## Context

The planning pack makes memory plugin-owned and replaceable. The first shipped
memory package, `@generic-ai/plugin-memory-files`, provides a useful local-first
baseline with persistent read, write, lexical search, and delete behavior, but
that API lived in the plugin package itself.

That was enough for the initial vertical slice, but it leaves future memory
plugins at risk of inventing incompatible surfaces for semantic retrieval,
temporal validity, provenance, consolidation, graph traversal, and shared
memory. The SDK already owns comparable contracts for storage, workspace,
queueing, output, and sandbox execution, so memory needs the same narrow public
anchor before richer plugins land.

## Decision

Add an SDK-owned `MemoryService` contract that preserves the operational core
of the existing file-memory store:

- `remember(agentId, entry)`
- `get(agentId, id)`
- `list(agentId, filter?)`
- `search(agentId, query, limit?)`
- `forget(agentId, id)`

The base record shape standardizes common fields such as text, tags, metadata,
timestamps, optional kind/namespace, temporal validity, provenance, salience,
importance, and supersession links. The contract also reserves optional
extension methods for consolidation, provenance explanation, timeline queries,
and graph queries, but a plugin does not need to implement those methods to be
a valid memory service.

`@generic-ai/plugin-memory-files` now implements this SDK contract while keeping
its file-backed local behavior and existing store ergonomics. Future memory
packages should depend on `@generic-ai/sdk`, implement `MemoryService`, and
remain plugin-layer packages that can be mounted into or layered around the
starter preset's memory slot without changing the kernel.

The concrete roadmap lives in [`../memory-plugins.md`](../memory-plugins.md).
The recommended sequence is:

1. Hybrid semantic memory.
2. Temporal semantic memory.
3. Hierarchical consolidation memory.
4. Graph episodic-semantic memory.

## Consequences

- Memory stays out of `@generic-ai/core`; the kernel continues to orchestrate
  sessions around plugin-owned capability surfaces.
- Alternate memory plugins can share conformance tests and starter slot wiring
  instead of each exporting an unrelated CRUD/search API.
- The file-memory plugin remains the simplest reference implementation and the
  local-first fallback for read-your-writes behavior.
- The SDK contract is intentionally broad enough to support temporal,
  provenance, consolidation, and graph plugins, but the optional extension
  methods should only become required after real plugin implementations and
  conformance tests prove the shape.
- Richer memory plugins should include deletion, provenance, and stale-memory
  handling from the start rather than treating those as hosted-enterprise
  add-ons.

## Alternatives Considered

- Keep memory contracts package-local. This keeps the file-memory plugin small,
  but future vector, temporal, hierarchy, and graph plugins would fragment
  quickly.
- Put memory into the kernel. This contradicts the planning-pack decision that
  memory is plugin-owned and replaceable.
- Build `plugin-memory-vector-hybrid` before a contract. That would produce a
  more visible feature faster, but it would bake the second implementation's
  choices into the de facto public API.
