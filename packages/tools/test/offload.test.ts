import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

import type { AgentTool } from "@generic-ai/agent";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";

import { createToolBatchTool, offloadToolResult, withOffload } from "../src/index.js";

const written: string[] = [];
afterEach(() => {
  for (const path of written.splice(0)) {
    rmSync(path, { force: true });
  }
});

function textTool(name: string, produce: (params: { n?: number }) => string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({ n: Type.Optional(Type.Integer()) }),
    execute: async (_id, params: { n?: number }) => ({
      content: [{ type: "text", text: produce(params) }],
      details: { produced: true },
    }),
  };
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

describe("offloading", () => {
  it("leaves short results alone", async () => {
    const result = { content: [{ type: "text" as const, text: "short" }], details: {} };
    expect(await offloadToolResult("read", "1", result)).toBe(result);
  });

  it("saves a long result to a file and returns a preview with the path", async () => {
    const long = `${"a".repeat(10_000)}MIDDLE${"z".repeat(10_000)}`;
    const events: unknown[] = [];
    const tool = withOffload(
      textTool("grep", () => long),
      { onOffload: (event) => events.push(event) },
    );
    const result = await tool.execute("call-1", {});
    const details = result.details as {
      produced: boolean;
      offloaded: { path: string; totalChars: number };
    };
    written.push(details.offloaded.path);
    expect(details.produced).toBe(true);
    expect(details.offloaded.totalChars).toBe(long.length);
    // The default file is one the workspace read tool may open outside the workspace.
    expect(dirname(details.offloaded.path)).toBe(tmpdir());
    expect(basename(details.offloaded.path)).toMatch(/^generic-ai-[a-z]+-[0-9a-f]{16}\.[a-z]+$/);
    expect(readFileSync(details.offloaded.path, "utf8")).toBe(long);
    const preview = text(result);
    expect(preview.length).toBeLessThan(2500);
    expect(preview.startsWith("a".repeat(1500))).toBe(true);
    expect(preview).toContain(
      `${"z".repeat(500)}\n\n[Result offloaded: ${long.length} characters saved to`,
    );
    expect(preview).not.toContain("MIDDLE");
    expect(events).toEqual([
      expect.objectContaining({ toolName: "grep", toolCallId: "call-1", totalChars: long.length }),
    ]);
  });

  it("honours the threshold, exclusions and a failed write", async () => {
    const result = { content: [{ type: "text" as const, text: "x".repeat(200) }], details: {} };
    const saved: string[] = [];
    const offloaded = await offloadToolResult("bash", "1", result, {
      maxChars: 100,
      headChars: 10,
      tailChars: 0,
      write: async (_tool, value) => {
        saved.push(value);
        return "/work/out.txt";
      },
    });
    expect(text(offloaded)).toMatch(/^x{10}\n\n\[\.\.\. 190 characters omitted/);
    expect(saved).toEqual(["x".repeat(200)]);
    expect(await offloadToolResult("bash", "1", result, { maxChars: 100, exclude: ["bash"] })).toBe(
      result,
    );
    const failing = await offloadToolResult("bash", "1", result, {
      maxChars: 100,
      write: async () => {
        throw new Error("disk full");
      },
    });
    expect(failing).toBe(result);
  });
});

describe("tool_batch", () => {
  it("runs independent calls together, validates arguments and reports errors per call", async () => {
    const order: string[] = [];
    const tools: AgentTool[] = [
      textTool("echo", (params) => {
        order.push(`echo ${params.n}`);
        return `echo ${params.n}`;
      }),
      { ...textTool("lock", () => "locked"), executionMode: "sequential" },
      {
        ...textTool("boom", () => ""),
        execute: async () => {
          throw new Error("exploded");
        },
      },
    ];
    const batch = createToolBatchTool(() => [...tools, batch]);
    const result = await batch.execute("b", {
      calls: [
        { tool: "lock" },
        { tool: "echo", arguments: { n: 1 } },
        { tool: "echo", arguments: { n: "two" } },
        { tool: "boom" },
        { tool: "missing" },
        { tool: "tool_batch", arguments: { calls: [] } },
      ],
    });
    const output = text(result);
    expect(output).toContain("## 1. lock\nlocked");
    expect(output).toContain("## 2. echo\necho 1");
    expect(output).toContain('## 3. echo (error)\nValidation failed for tool "echo"');
    expect(output).toContain("## 4. boom (error)\nexploded");
    expect(output).toContain("## 5. missing (error)\nUnknown or unavailable tool: missing");
    expect(output).toContain("## 6. tool_batch (error)");
    await expect(
      createToolBatchTool(() => tools, { maxCalls: 1 }).execute("b", {
        calls: [{ tool: "echo" }, { tool: "echo" }],
      }),
    ).rejects.toThrow("at most 1 calls");
  });
});
