import { describe, expect, it } from "vitest";

import { McpRegistryError, createMcpRegistry, kind, name } from "../src/index.js";

describe("@generic-ai/plugin-mcp", () => {
  it("registers stdio and remote MCP servers and produces prompt-ready descriptions", () => {
    const registry = createMcpRegistry([
      {
        id: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        description: "Workspace filesystem access",
      },
      {
        id: "planner",
        transport: "sse",
        url: "https://mcp.example.test/sse",
        description: "Shared planning service",
      },
    ]);

    expect(registry.name).toBe(name);
    expect(registry.kind).toBe(kind);
    expect(registry.list()).toHaveLength(2);
    expect(registry.resolveLaunch("filesystem", { TOKEN: "abc" })).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: {
        TOKEN: "abc",
      },
    });
    expect(registry.describeForPrompt()).toContain("filesystem");
    expect(registry.describeForPrompt()).toContain("planner");
  });

  it("rejects duplicate server ids", () => {
    const registry = createMcpRegistry();

    registry.register({
      id: "filesystem",
      transport: "stdio",
      command: "npx",
    });

    expect(() =>
      registry.register({
        id: "filesystem",
        transport: "stdio",
        command: "npx",
      }),
    ).toThrow(McpRegistryError);
  });
});
