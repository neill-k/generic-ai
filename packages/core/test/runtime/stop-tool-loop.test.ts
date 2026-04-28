import { describe, expect, it, vi } from "vitest";

import {
  createStopAndRespondTool,
  runStopToolLoop,
  STOP_AND_RESPOND_TOOL_NAME,
  type StopAndRespondState,
} from "../../src/runtime/index.js";

describe("@generic-ai/core stop-tool loop", () => {
  it("marks the stop tool result terminal for Pi's per-prompt tool loop", async () => {
    const state: StopAndRespondState = { stopped: false };
    const tool = createStopAndRespondTool(state);

    const result = await tool.execute(
      "stop-1",
      { response: "final answer", status: "completed" },
      undefined,
      undefined,
      {} as never,
    );

    expect(tool.name).toBe(STOP_AND_RESPOND_TOOL_NAME);
    expect(state).toEqual({
      stopped: true,
      response: "final answer",
      status: "completed",
    });
    expect(result.terminate).toBe(true);
  });

  it("re-prompts the same session until the stop tool state is set", async () => {
    const state: StopAndRespondState = { stopped: false };
    const runPrompt = vi.fn(async () => {
      if (runPrompt.mock.calls.length === 2) {
        state.stopped = true;
        state.response = "done";
        state.status = "completed";
      }
    });

    const result = await runStopToolLoop({
      prompt: "finish the task",
      maxTurns: 3,
      state,
      runPrompt,
    });

    expect(result).toEqual({
      stopped: true,
      outputText: "done",
      status: "completed",
      turnCount: 2,
    });
    expect(runPrompt.mock.calls[0]?.[0]).toContain("User task:\nfinish the task");
    expect(runPrompt.mock.calls[1]?.[0]).toContain("Continue the same task");
  });
});
