# 0023 - Agent Harness Adapter Run Context And Pi Boundary

## Context

Generic AI's harness claim is stronger than "call Pi with a prompt." The SDK adapter seam must let Generic AI own cancellation, deadlines, budgets, event emission, policy evaluation, artifact storage, and error categorization even when the first implementation is Pi-backed.

A `run(input) -> result` adapter shape would freeze Pi's lifecycle as the public SDK contract. That would make non-Pi adapters either reimplement Pi's assumptions or bypass harness guarantees.

## Decision

`AgentHarnessAdapter.run()` takes both `AgentHarnessRunInput` and `AgentHarnessAdapterRunContext`.

The run context owns:

- `AbortSignal` for cancellation.
- `deadline` and `budget` for bounded execution.
- a typed harness event sink.
- a policy evaluator callback.
- an artifact store callback.

The Pi-backed adapter remains the only P1 implementation, but Pi is below the harness boundary. Pi provides session and tool-loop mechanics. Generic AI owns capability composition, role policy, event projection, policy decisions, artifact references, and the final run result envelope.

## Consequences

External adapters can be built against Generic AI's lifecycle instead of Pi's function signature.

The P1 Pi adapter may not fully enforce every budget dimension yet, but the public contract has a place for cancellation, deadlines, budgets, policy checks, artifact writes, and categorized failures before SDK consumers depend on it.

## Alternatives Considered

### Keep `run(input) -> result`

Rejected. It is simple, but it makes the adapter contract a Pi wrapper and leaves no stable place for cross-adapter harness guarantees.

### Put lifecycle callbacks directly on `AgentHarnessRunInput`

Rejected. Inputs should describe the run. Runtime-owned services such as policy and artifact storage belong in a run context so they can be swapped by core, tests, hosted runtimes, and external harnesses.
