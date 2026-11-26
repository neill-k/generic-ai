import { Type } from "@sinclair/typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { type AgentToolResult, defineTool, type ToolDefinition } from "../src/index.js";

describe("runtime-neutral tool contract", () => {
  it("defineTool returns the tool unchanged and keeps parameter types", async () => {
    const tool = defineTool({
      name: "echo",
      label: "Echo",
      description: "Echo the input.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_toolCallId, params) {
        expectTypeOf(params.text).toEqualTypeOf<string>();
        return {
          content: [{ type: "text", text: params.text }],
          details: { length: params.text.length },
        };
      },
    });
    const tools: ToolDefinition[] = [tool];
    expect(tools[0]).toBe(tool);
    const result: AgentToolResult = await tool.execute(
      "call-1",
      { text: "hi" },
      undefined,
      undefined,
    );
    expect(result).toEqual({ content: [{ type: "text", text: "hi" }], details: { length: 2 } });
  });
});
