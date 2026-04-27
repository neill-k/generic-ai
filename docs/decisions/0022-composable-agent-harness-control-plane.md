# 0022 - Composable Agent Harness Control Plane

## Context

Generic AI is intended to be a composable agent harness, not a fixed agent and not only a low-level text runtime wrapper. The Terminal-Bench quick run exposed the practical consequence of the old path: `GenericAILlmRuntime` could send a prompt through Pi-compatible inference, but it did not assemble the full starter stack, role topology, tool observations, durable handoffs, or trace-backed artifacts that a serious benchmark agent needs.

The existing package boundary already says the SDK owns public contracts, core owns runtime/session/event control-plane, plugins own capabilities, presets compose the stack, and examples consume that stack. The harness spine should follow that boundary instead of moving benchmark-specific orchestration into the kernel or into a one-off Terminal-Bench script.

## Decision

Generic AI will expose a public SDK-level `AgentHarness` contract family and a core Pi-backed implementation.

- `@generic-ai/sdk` owns `AgentHarness`, `AgentHarnessAdapter`, `AgentHarnessRunInput`, `AgentHarnessRunResult`, `AgentHarnessRole`, `AgentHarnessPolicyProfile`, adapter run context, capability-effect descriptors, artifact references, and typed harness event projections.
- Canonical config supports top-level `harnesses` plus `framework.primaryHarness`.
- `@generic-ai/core` exposes `createAgentHarness()` and `runAgentHarness()` as the runtime control-plane above Pi.
- The first implementation is Pi-backed. Pi provides session and tool-loop mechanics; Generic AI owns capability composition by declared effects, role policy, delegation, canonical events, policy decisions, artifact writing, and the final run result envelope.
- `GenericAILlmRuntime` remains available as a low-level text/model helper, but it is not the composable harness surface.
- `@generic-ai/plugin-repo-map` and `@generic-ai/plugin-lsp` become public plugins because repository orientation and language-aware inspection are reusable harness capabilities, not Terminal-Bench-specific code.
- The starter preset includes repo-map and LSP slots.
- Terminal-Bench consumes `runAgentHarness()` and maps canonical harness projections into ATIF/report artifacts.

## Consequences

The public architecture now has a clearer vertical path:

```text
SDK contracts -> core harness runtime -> plugin capability bindings -> preset/example composition
```

Terminal-Bench can validate the same harness surface that application users compose. It also gets trace-backed tool/action evidence instead of relying on user/final text only.

The kernel remains plugin-agnostic: core can filter and pass capability bindings, but it must not import plugin packages. Presets and examples assemble concrete terminal, file, repo-map, LSP, skills, memory, messaging, MCP, web, and output plugins.

The new policy profiles are intentionally narrow in P1:

- `local-dev-full` allows the starter-stack local development posture.
- `benchmark-container` treats the external benchmark container as the execution boundary, denies nested sandboxing, and denies network/MCP by default unless explicitly allowed.

Reusable policy automation, verifier-loop automation, and richer report/render plugins remain follow-on work after the live smoke gate proves the harness launches, writes artifacts, and solves at least one real task. Recommendation-quality Terminal-Bench validation requires a pinned repeated task set, not the quick profile alone.

## Alternatives Considered

### Keep Terminal-Bench on `GenericAILlmRuntime`

Rejected. That path can call a model, but it does not represent the Generic AI product goal. It also hides missing tool composition and produces weak benchmark evidence.

### Put benchmark orchestration directly in `examples/terminal-bench`

Rejected as the primary fix. The example should consume the framework harness, not define it. Benchmark-specific Harbor glue and report import stay in the example, but role topology, events, policy decisions, and artifact contracts belong to SDK/core surfaces.

### Promote a benchmark-specific public package now

Rejected for P1. Terminal-Bench remains an example/consumer until a second benchmark integration proves which import/report abstractions should become public package code.
