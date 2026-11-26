# 0042. Protocol-Driven Topology Runner

## Context

The Harness DSL lets a harness bind its agents to a protocol: `pipeline`,
`verifier-loop`, `hierarchy`, or `squad`. Until this decision those protocols
were planners only. Their reducers emitted `invoke_actor`, `delegate_work`, and
`claim_work` actions once, with no memory of what had already run, and nothing
in `@generic-ai/core` consumed those actions. The only working multi-agent
engine was the model-directed `AgentHarness`, where a root coordinator decides
when to call `delegate_agent`. A compiled harness that declared a verifier loop
or a squad therefore could not be executed as declared.

## Decision

Protocol semantics stay in the SDK and scheduling stays in core.

- The protocol ABI gains `ProtocolActionOutcome` and an extended
  `ProtocolReduceInput` (`outcomes`, `binding`, `instruction`). Reducers remain
  pure: given the compiled harness and the outcomes of every executed action,
  they return the next batch of actions with stable idempotency keys. Actions
  returned together are independent and may run concurrently.
- The four standard protocols are now stateful reducers:
  - `pipeline` runs `config.stages` (or the binding's `actorRefs`) in order and
    hands each stage the earlier outputs. A failed or `VERDICT: FAIL` stage
    fails the run.
  - `verifier-loop` runs solver, critic, and repairer (repairer falls back to
    solver) until the critic returns `VERDICT: PASS` or `config.maxIterations`
    (default 3) reviews have rejected the work.
  - `hierarchy` asks the manager for structured assignments, delegates them to
    its reports in parallel (reports come from `config.delegatees`,
    `delegates_to` relationships, or the binding), then has the manager
    synthesize the reports.
  - `squad` takes `config.workItems`, or asks a lead to decompose the task, and
    lets members claim items in parallel batches while sharing a board of
    finished work through the shared space.
- `parseActorDirectives()` reads `VERDICT:` lines and fenced JSON blocks from
  actor output so protocols can branch on verdicts, assignments, and work
  items without provider-specific parsing.
- `runHarnessTopology()` in core is protocol-agnostic. It selects a binding and
  protocol implementation, validates, then loops reduce/execute with bounded
  concurrency, per-action retries, step and deadline budgets, cancellation,
  idempotency, `request_approval` handling through an injected approver, and a
  causal `TraceEvent` trace (`protocol.action.planned` → `actor.invoked` →
  `actor.completed`). Actor execution goes through an injected
  `TopologyActorRunner`.
- `createAdapterTopologyActorRunner()` runs actors through any SDK
  `AgentHarnessAdapter`, so the scheduler has no runtime dependency and picks
  up new runtimes as soon as they implement the adapter contract. Each actor
  gets a single-role config, and its model resolves from the actor, a matching
  `harness.roles` entry, or the harness default.
- `runAgentHarnessTopology()` provides the Pi-backed runner. Each actor runs as
  its own Pi role session through the same role-session path the
  `delegate_agent` tool uses, so policy profiles, effect-based role policies,
  lifecycle hooks, canonical `handoff.*` events, and artifacts are shared with
  the model-directed harness. DSL role names map onto harness role kinds
  (`implementer`/`solver`/`repairer` build, `critic`/`reviewer` verify,
  `manager`/`planner` read-only, unknown names read-only) unless
  `harness.roles` names the actor or its role.

## Consequences

- A compiled harness can now be executed as declared, and every topology run
  leaves a trace and per-action outcome artifact beside the usual harness
  artifacts.
- The model-directed coordinator and the protocol-driven runner coexist. Teams
  choose free-form delegation or a fixed topology per harness.
- Package-provided protocols plug in by implementing `ProtocolPlugin`; the
  runner accepts them through `protocols`.
- Protocol state is recomputed from outcomes on every step, so the runner can
  later persist outcomes and resume a run without protocol-specific storage.
- `runHarnessBenchmark()` still sends one prompt per trial. Routing benchmark
  candidates through the topology runner is follow-on work.

## Alternatives Considered

- Execute protocols inside the root coordinator's prompt. Rejected because the
  topology would remain a suggestion the model can ignore.
- Put protocol semantics in core. Rejected because protocol behaviour is
  package-extensible and the kernel must not own it.
- Let reducers hold mutable state. Rejected because pure reducers over outcomes
  are deterministic, testable without a model, and resumable.

## Amendment: goals decide completion

With goal contracts (ADR 0050) on main, topology runs accept a sealed goal.
The verifier loop gains `config.acceptance` (`critic`, `goal`,
`goal-then-critic`) and a `validate_goal` action that the runner executes with
`runGoalValidators()`, keeping validator code out of the reducers and out of
the agents' reach. Any protocol's success is gated on the goal being
`COMPLETE` for the final output, so a critic's `VERDICT: PASS` alone can no
longer finish a run that has a goal.

