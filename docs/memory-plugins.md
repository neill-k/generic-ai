# Memory Plugin Roadmap

## Status

This document is the package-level roadmap for memory systems beyond the
baseline `@generic-ai/plugin-memory-files` implementation. It follows the
planning pack rule that memory is plugin-owned and replaceable, and the
framework decision in
[`docs/decisions/0029-memory-service-contract-and-roadmap.md`](decisions/0029-memory-service-contract-and-roadmap.md).

## Current Baseline

`@generic-ai/plugin-memory-files` is the reference local-first memory
implementation. It stores agent-scoped JSON entries under the workspace layout
and supports `remember`, `get`, `list`, `search`, and `forget`.

The SDK now exposes `MemoryService` so richer memory plugins can share the same
base operations and record vocabulary while adding optional capabilities for
consolidation, provenance explanation, timeline queries, and graph queries.

## Design Rules

- Memory packages stay plugin-layer packages. They may depend on
  `@generic-ai/sdk`, `pi`, storage/workspace/queue contracts, and documented
  adapter libraries. They must not import `@generic-ai/core`.
- The default starter path remains local-first. Hosted/vector/graph backends
  should be optional adapters, not required for a fresh checkout.
- Every richer memory plugin should preserve read-your-writes behavior through
  a lexical or raw-record path even when embedding, extraction, or graph jobs
  lag.
- Derived memories must retain provenance back to raw records or episodes.
- Supersession, deletion, and stale-memory behavior must be part of the first
  implementation plan for each richer plugin.
- Benchmarks should cover retrieval accuracy, multi-session reasoning,
  temporal reasoning, knowledge updates, abstention, and selective forgetting.

## Recommended Sequence

| Order | Package | Purpose | Default backend | Why this order |
| --- | --- | --- | --- | --- |
| 1 | `@generic-ai/plugin-memory-vector-hybrid` | Dense plus lexical semantic recall with metadata filters and optional reranking. | SQLite FTS plus local embedding cache; optional pgvector/Qdrant/Weaviate adapters. | Highest immediate improvement over lexical file search with moderate complexity. |
| 2 | `@generic-ai/plugin-memory-temporal` | Answer "what was true when?" with events, states, validity intervals, and supersession. | Storage tables plus interval indexes and optional vector sidecar. | Temporal drift and corrections are a major long-horizon accuracy failure mode. |
| 3 | `@generic-ai/plugin-memory-hierarchy` | Working blocks, episodic log, summaries, semantic profile, and procedural memories. | Storage plus queue-backed consolidation jobs. | Improves token-budget control and session continuity after the retrieval base exists. |
| 4 | `@generic-ai/plugin-memory-graph` | Entity-centric and multi-hop recall over episodes, facts, entities, edges, and summaries. | SQL graph tables plus vector candidate generation first; specialized graph DB later. | Highest upside, but graph extraction and entity linking need provenance and observability first. |

## Contract Expectations

All future memory packages should implement `MemoryService`:

```ts
interface MemoryService {
  remember(agentId: string, entry: MemoryRecordInput): Awaitable<MemoryRecord>;
  get(agentId: string, id: string): Awaitable<MemoryRecord | undefined>;
  list(agentId: string, filter?: MemoryListFilter): Awaitable<readonly MemoryRecord[]>;
  search(
    agentId: string,
    query: string | MemorySearchQuery,
    limit?: number,
  ): Awaitable<readonly MemorySearchResult[]>;
  forget(agentId: string, id: string): Awaitable<boolean>;
}
```

Optional extensions should be implemented only when the plugin owns that
behavior:

- `consolidate` for hierarchy and sleeptime memory.
- `explain` for provenance-first, temporal, and graph memory.
- `timeline` for temporal semantic memory.
- `graph` for graph episodic-semantic memory.

## First Plugin: Hybrid Semantic Memory

The hybrid semantic plugin should be the first production-relevant replacement
for file memory.

Minimum deliverables:

- Implements `MemoryService`.
- Keeps a raw record table and lexical search path for read-your-writes.
- Adds dense embeddings and score fusion with lexical results.
- Supports tags, namespace, kind, and metadata filters.
- Degrades to lexical plus recency search if embedding generation fails.
- Includes conformance tests shared with `plugin-memory-files`.
- Documents privacy risk for embeddings and local/hosted adapter choices.

## Second Plugin: Temporal Memory

The temporal plugin should focus on validity, not just similarity.

Minimum deliverables:

- Implements `MemoryService` plus `timeline`.
- Stores point events separately from durative states.
- Supports `asOf`, `before`, `after`, `during`, and current-state queries.
- Models supersession rather than destructive overwrite.
- Surfaces provenance for changed or corrected facts.
- Includes tests for corrections, revocations, timezone shifts, and stale
  summaries.

## Third Plugin: Hierarchical Memory

The hierarchy plugin should model memory layers explicitly.

Minimum deliverables:

- Implements `MemoryService` plus `consolidate`.
- Separates working blocks, episodes, summaries, semantic profile, and procedure
  memories.
- Uses queue-backed consolidation jobs.
- Keeps derived summaries linked to source records.
- Supports pinning small working-memory blocks for prompt construction.
- Includes fidelity tests comparing summaries against raw episodes.

## Fourth Plugin: Graph Memory

The graph plugin should wait until provenance, hybrid retrieval, and temporal
validity are stable.

Minimum deliverables:

- Implements `MemoryService` plus `graph` and `explain`.
- Stores raw episodes, entities, relation edges, and derived summaries.
- Uses lexical/vector retrieval to seed graph expansion.
- Provides raw-only fallback when extraction confidence is low.
- Includes tests for multi-hop retrieval, entity-link precision, graph
  explosion limits, and incorrect merges.

## Deferred Supporting Plugins

These remain useful, but should follow the first four:

- `@generic-ai/plugin-memory-provenance` for append-only memory events and
  reviewable derived claims.
- `@generic-ai/plugin-memory-shared` for shared namespaces and multi-agent
  coordination.
- `@generic-ai/plugin-memory-experience` for procedure traces and reusable
  playbooks.
- `@generic-ai/plugin-memory-sleeptime` for background reflection and profile
  refinement.
- `@generic-ai/plugin-memory-policy-governance` for TTL, sensitivity tags,
  trust scores, redaction, poisoning quarantine, and erasure workflows.
