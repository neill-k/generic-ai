# 0033. Research Slots

## Status

Accepted.

## Context

Generic AI is being repositioned as a composable agents-as-code research
harness. The current packages already support that direction, but the package
taxonomy is still mostly capability-named: tools, memory, messaging, Hono, MCP,
storage, and similar implementation surfaces. That makes package discovery read
like a framework assembly kit instead of a harness for comparing agentic
architecture choices.

The research-harness plan calls for plugins to be discoverable by research
slot. A slot is the architectural role a package plays in a harness. A method
is the package's implementation family within that slot. Package names remain
stable for now; slot classification is additive metadata plus a registry doc.

## Decision

Generic AI will use low-risk Option A for v0.1/v0.2: keep current package
names and add `genericAi` metadata to package manifests.

Slot-classified plugins use this shape:

```json
{
  "genericAi": {
    "kind": "plugin",
    "slot": "memory",
    "method": "file-backed-memory.v1"
  }
}
```

Capability plumbing that is not itself a research method uses `category`
instead of `slot`:

```json
{
  "genericAi": {
    "kind": "plugin",
    "category": "transport",
    "method": "mcp-embedded.v1"
  }
}
```

Starter presets use `kind: "preset"` and may declare the research slots they
compose:

```json
{
  "genericAi": {
    "kind": "preset",
    "category": "preset",
    "method": "local-first-hono-starter.v1",
    "composesSlots": ["memory", "communication", "tool-policy"]
  }
}
```

The initial research slot vocabulary is:

- `planning`
- `coordination`
- `memory`
- `communication`
- `tool-policy`
- `recovery`
- `evaluation`
- `reporting`

The initial non-slot categories are:

- `infra`
- `transport`
- `preset`

`docs/slots.md` is the hand-maintained registry for shipped packages, method
families, and canonical harness usage. A generated registry is intentionally
deferred until the metadata starts serving runtime or release automation.

## Consequences

- Package names and imports do not change.
- `npm pack` payloads gain only package metadata; runtime behavior is unchanged.
- Harness docs can describe packages by research slot without inventing
  slot-aliased packages yet.
- The current registry can name empty slots, such as `recovery` or
  `evaluation`, without pretending that a shipped implementation exists.
- Future slot-aliased packages remain possible if the registry proves too weak
  for discovery.

## Alternatives Considered

### Publish slot-aliased re-export packages now

Rejected for this change. Aliases would improve npm search but would also add
publish-surface and maintenance overhead before the slot vocabulary has been
exercised across multiple benchmark families.

### Rename current packages

Rejected. Renaming would create avoidable ecosystem churn before v1.0 and is
unnecessary for the current research-harness repositioning.

### Keep taxonomy only in docs

Rejected. A docs-only registry would help readers but would not give package
consumers, search tooling, or future release checks a stable machine-readable
hook.
