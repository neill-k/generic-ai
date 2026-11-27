# 0071 — No fixed agent patterns

- Status: accepted
- Date: 2026-11-27
- Supersedes: `0042-protocol-topology-runner.md`; the restricted role kinds in
  `0022-composable-agent-harness-control-plane.md`; the topology executor in
  `0058-goal-evals.md`
- Related: design review decisions 1, 2 and 3 (Claude Doc "Generic Corp design
  review: decisions")

## Context

The framework grew several ways to coordinate agents that the product does not
use: four protocol reducers (`pipeline`, `verifier-loop`, `hierarchy`, `squad`)
and a topology runner that drove them, a benchmark runner and a "harness
shootout" built to compare them, console templates for each pattern, and
restricted role kinds (`planner`, `explorer`, `verifier`) whose only purpose was
to fill those patterns with read-only or check-only seats. The native harness's
primary agent was a coordinator that could not write and was told to follow a
Plan/Explore/Build/Verify routine, and that prompt reached Generic Corp's agents
too.

The owner's rule is plain: "every role should be a fully fledged agent with
tools available. Nothing should be fixed into a specific workflow or pattern.
The agents are organized as an org chart to help humans understand how the
delegation works and to provide them with a means of communicating with agents."

## Decision

- **One way to coordinate.** Agents delegate down the org chart (the delegation
  cascade in `@generic-ai/plugin-delegation`): each hand-off is a task with its
  own goal and checks, and results come back up. Who an agent may hand work to
  follows the chart by default (`delegationScope`, default `direct-reports`).
- **Removed:** the protocol reducers and `ProtocolPlugin` types (SDK), the
  topology runner, topology task executor, topology goal-eval executor,
  `runAgentHarnessTopology` and `runHarnessBenchmark` (core), the topology
  approver (approvals), the `protocols` section of the Harness DSL and the
  protocol rows of the capability BOM, the `harness-shootout`,
  `bench-tool-calling` and `bench-policy-tools` examples, and the pattern
  templates in the web console (replaced by one "Team" template).
- **Every role is a full agent.** Role kinds are `root`, `builder` and
  `custom`. A role gets every tool its policy profile and permissions allow;
  `readOnly: true` on a role is the only restriction a role carries. The
  harness's primary agent is a full agent too: it works itself and may delegate
  to roles the config declares. A harness that declares no roles has none. A
  stored agent record with an old restricted kind runs as `builder`.
- **Kept:** `parseActorDirectives` (now in `harness/directives.ts`), which the
  cascade uses to read hand-ins; the Harness DSL compiler and capability BOM for
  agents, capabilities, spaces, relationships, policies and artifacts; benchmark
  and report types used by the Terminal-Bench integration, with the old
  `protocol.action.planned` trace event renamed `handoff.recorded`.

## Consequences

- Generic Corp's agents no longer get the coordinator prompt or a read-only
  primary role. Each turn's harness prompt tells the agent to do the work itself
  with its tools.
- Comparing coordination methods is no longer a framework feature. Changes are
  measured with goal evals and Terminal-Bench runs of the real agent.
- Earlier ADRs that describe the removed pieces stay as history; this ADR is the
  current rule.
