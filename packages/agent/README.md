# @generic-ai/agent

The agent loop of the Generic AI native runtime, built on `@generic-ai/ai`.

```ts
import { Agent } from "@generic-ai/agent";
import { resolveModel } from "@generic-ai/ai";

const agent = new Agent({
  initialState: {
    model: resolveModel("anthropic/claude-sonnet-5-5"),
    systemPrompt: "You are a careful assistant.",
    tools: [myTool],
  },
});
agent.subscribe((event) => console.log(event.type));
await agent.prompt("Summarise the open issues");
```

- `agentLoop()` / `agentLoopContinue()` are the stateless loop: stream a model turn, run its tool
  calls (in parallel by default, or sequentially), feed results back, and repeat until the model
  stops. Every step is reported as an `AgentEvent`.
- Tools declare a JSON Schema; arguments are validated and coerced before `execute` runs. A tool can
  stream partial results, return `terminate: true` to end the run, or fail with `isError`.
- `beforeToolCall` can block a call, `afterToolCall` can rewrite its result.
- `finishTurn`, `prepareRequest`, and `prepareNextTurn` let a host inspect each turn and change the
  context, model, or thinking level between requests.
- `Agent` wraps the loop with state, a subscriber list, steering messages (delivered as soon as the
  current tool batch finishes) and follow-up messages (delivered when the agent would otherwise
  stop), `abort()`, and `waitForIdle()`.

The semantics follow pi's `pi-agent-core`, and the test suite is ported from it; see
`THIRD_PARTY_NOTICES.md`.
