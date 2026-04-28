# 0029 - Native Agent Loop Structure

## Context

Codex-style coding agents work better when the run is not treated as a loose
prompt plus tools. The reliable shape is a durable loop: replay thread state,
assemble turn context, route typed tools, check policy before mutation, execute,
record evidence, and verify before final output.

The web UI template catalog needs to demonstrate this shape, but the vocabulary
is not UI-specific. If every example encodes it in ad hoc metadata, presets,
benchmarks, docs, and future UIs will drift.

## Decision

Generic AI will make agent-loop structure a native SDK-level harness contract.

- `AgentHarnessConfig.loop` describes the loop shape for a harness.
- The native loop model includes `pattern`, `stateModel`, `stages`,
  `transitions`, `entryStage`, `terminalStages`, and `invariants`.
- The first built-in pattern is `thread-turn-tool-policy`; custom extensions use
  `custom.*`.
- The first built-in state model is `thread-turn-item`; custom extensions use
  `custom.*`.
- Stage kinds are intentionally structural: `state`, `context-builder`,
  `controller`, `tool-router`, `policy-gate`, `executor`, `verifier`, and
  `custom`.
- Canonical YAML validation accepts the loop field on harness config and rejects
  stage references that point outside the declared stage set.
- The core Pi-backed harness consumes the loop description as runtime guidance
  in the root coordinator prompt. Plugin-specific execution and policy
  enforcement remain owned by the existing capability and policy layers.

## Consequences

The Codex-inspired web UI example becomes a normal Generic AI harness config,
not special UI-only metadata. Other examples and presets can reuse the same
contract without importing the web UI plugin or Codex internals.

This decision does not move Codex's app-server, storage engine, or tool runtime
into the Generic AI kernel. Those remain separate implementation choices. The
native commitment is the reusable loop anatomy and validation boundary.
