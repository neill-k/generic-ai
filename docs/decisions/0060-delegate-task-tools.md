# 0060. Delegate and Finish as Real Tools

## Context

ADR 0044 had agents in the delegation cascade hand off work by ending their reply with a fenced
JSON block (`{"delegate_task": [...]}`) that the cascade parsed after the turn. That works on any
runtime, but the model only learns about a bad hand-off (an unknown agent, someone outside its part
of the org chart, too many children) one whole turn later, the format is easy to get wrong, and
the hand-off is invisible to tool tracing and tool policy.

## Decision

1. **Host tools in the SDK.** `AgentHarnessHostTool` describes a tool without any runtime's types:
   a name, description, JSON Schema parameters, effects for role policy, and an `execute` that
   returns text (or an error). `AgentHarnessRunInput.hostTools` adds such tools to one run. Core
   converts them with `toHarnessToolDefinition`, so the same tool runs on the pi and native
   runtimes and goes through role policy, hooks and the effect journal like any other tool.
2. **The cascade offers `delegate_task` and `finish_task` each turn.** They reach executors as
   `AgentTaskExecutionInput.tools`; `createAdapterTaskExecutor` passes them as `hostTools`.
   - `delegate_task({ tasks: [{ to, task, definitionOfDone?, goal? }] })` validates the entries,
     the target agents, the org-chart scope and the depth and fan-out limits during the call, and
     returns an error the model can act on in the same turn. Valid hand-offs are recorded; it is
     only offered when the agent has someone to delegate to and depth allows it.
   - `finish_task({ reason })` records that the agent gave up.
   Both declare the `handoff.write` effect.
3. **Recorded directives win and are durable.** After the turn the cascade acts on directives
   recorded by the tools, falling back to a fenced-JSON block in the reply. Tool directives are
   saved in the turn checkpoint (ADR 0059), so a resumed turn acts on them without re-running the
   model. The cascade's own checks in `delegate()` still apply.
4. **The JSON block stays as a fallback** for executors that cannot add tools. The prompt names
   the tools first and the JSON form second.

## Consequences

- Bad hand-offs are fixed inside the turn instead of costing a round.
- Hand-offs appear as tool calls in the run's trace, so goal trace validators and goal evals can
  require or forbid them.
- Any host can add its own runtime-neutral tools to a harness run the same way.
- Tests cover the tool on both runtimes (a fake pi session and the native agent loop with a faux
  model) and the cascade's handling of tool directives, including immediate validation errors,
  `finish_task`, and directives saved in the checkpoint.
