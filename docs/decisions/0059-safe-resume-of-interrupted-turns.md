# 0059. Safe Resume of Interrupted Turns

## Context

ADR 0044 made delegated work durable, but a turn was at-least-once: a worker that stopped after
the model answered, or in the middle of a tool call, left the queue to run the whole turn again.
Since ADR 0057, agents reach email, calendars, chat, documents and payments through MCP connectors.
A repeated turn could send the same message or spend the same money twice, and nothing would
notice.

## Decision

1. **Outward tool calls are journaled.** The SDK's `createToolEffectGuard(journal)` wraps tools
   whose effects include `message.send`, `external.write` or `payment.spend` (the outward effects
   of ADR 0057). Before such a call runs it writes a `started` record; afterwards a `completed`
   record with the result, or a `failed` record with the error. Calls are keyed by tool name, a
   sha256 of the canonical arguments, and how many identical calls came earlier in the attempt, so
   a retried model that repeats its calls in a different order still matches.
2. **A retry never repeats an outward call blindly.** When the same turn runs again:
   - a call that `completed` returns the recorded result without running;
   - a call that `failed` returns the recorded error without running;
   - a call that `started` but never reported back is refused. The agent is told the action may
     already have happened and to check before retrying. Calling the tool again after that runs
     it, because it is a new, deliberate call.
   Replays and refusals are reported through `ToolEffectJournal.observe`.
3. **The harness applies the guard on both runtimes.** `AgentHarnessRunInput.effectJournal` (and
   `RunAgentHarnessTopologyOptions.effectJournal`) makes core wrap the run's tools, including MCP
   tools, before role policy and hooks, so the pi and native runtimes and delegated role sessions
   share one guard. Approval gates (R11) still run on top and see the same effect tags.
4. **The cascade keeps one journal per turn.** Every attempt of a task round shares the scope
   `<task>:turn-<round>`; records are sessions in the run store (`createRunStoreToolEffectJournal`),
   so a different worker sees them after a crash. `AgentTaskExecutionInput.effectJournal` carries
   it, and `createAdapterTaskExecutor` passes it to the adapter. Replays and refusals are logged as
   `plugin.delegation.tool-effect-replayed` / `-uncertain` events and emitted as
   `tool.effect.replayed` / `tool.effect.uncertain` cascade events.
5. **The model's answer is checkpointed.** As soon as a turn succeeds, the cascade saves its output
   in session `<task>:turn-<round>:outcome`. If the worker stops before acting on it (validation,
   delegation, settling), the retry acts on the saved answer instead of calling the model again.
6. **In-run goal verdicts are events.** Each goal validation logs
   `plugin.delegation.goal.validated` with `goalId`, `goalFingerprint`, `status` and counts on the
   task's run, so goal evals (ADR 0058) can re-run the validators and flag a `COMPLETE` claim they
   cannot reproduce or a fingerprint that differs from the sealed goal.

## Consequences

- An interrupted turn either reuses the saved answer, or reruns the model with every finished
  outward call replayed and every unfinished one surfaced to the agent. Tests cover a crashed
  attempt replaying two sends, an unrecorded send being refused, a saved answer being reused, and
  a native harness run sharing a journal across two attempts.
- A new round (after validation feedback or delegation results) gets a new journal scope, so an
  agent that is asked to redo work can send again deliberately.
- Reads, file edits and shell commands are not journaled; repeating them is safe or visible in the
  workspace. A tool can opt in through `createToolEffectGuard({ shouldJournal })`.
- The journal records results as JSON. A tool whose result cannot be serialized replays as its
  string form.
- Exactly-once delivery still depends on the outside service when a worker dies between the
  service accepting a call and the journal recording it; that case is the `started` record, which
  is surfaced rather than retried.
