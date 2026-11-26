import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type PiCapabilityBindings,
  resolveCapabilityPiToolRegistry,
} from "../../src/runtime/index.js";

function createCapabilityBindings(root = "/virtual"): PiCapabilityBindings {
  const skillDir = path.join(root, ".agents", "skills", "starter-skill");
  const skillFilePath = path.join(skillDir, "SKILL.md");

  return {
    terminalTools: {
      tool: {
        name: "bash",
        description: "Execute a shell command",
      } as never,
    },
    fileTools: {
      piTools: [
        { name: "read", description: "Read a file" },
        { name: "write", description: "Write a file" },
        { name: "edit", description: "Edit a file" },
        { name: "find", description: "Find files" },
        { name: "grep", description: "Search file contents" },
        { name: "ls", description: "List files" },
      ] as never,
    },
    mcp: {
      list: () => [
        {
          id: "filesystem",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
      ],
      get: (id) =>
        id === "filesystem"
          ? {
              id: "filesystem",
              transport: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem"],
            }
          : undefined,
      resolveLaunch: () => ({
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
      }),
      describeForPrompt: () => "Available MCP servers:\n- filesystem (stdio)",
    },
    skills: {
      load: async () => ({
        skills: [
          {
            name: "starter-skill",
            description: "explain the starter stack",
            filePath: skillFilePath,
            baseDir: skillDir,
            sourceInfo: {
              path: skillFilePath,
              source: "project",
              scope: "project",
              origin: "top-level",
              baseDir: skillDir,
            },
            disableModelInvocation: false,
          },
        ],
        diagnostics: [],
        prompt: "starter-skill prompt",
      }),
    },
    messaging: {
      send: (input) => ({
        id: "message-1",
        threadId: input.threadId ?? "thread-1",
        from: input.from,
        to: input.to,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        body: input.body,
        createdAt: "2026-04-15T00:00:00.000Z",
        metadata: {},
      }),
      inbox: () => [],
      thread: () => [],
      markRead: () => undefined,
      search: () => [],
    },
    memory: {
      remember: async (agentId, entry) => ({
        id: entry.id ?? "memory-1",
        agentId,
        text: entry.text,
        tags: [...(entry.tags ?? [])],
        metadata: {},
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
      }),
      get: async () => undefined,
      list: async () => [],
      search: async () => [],
      forget: async () => false,
    },
  };
}

describe("@generic-ai/core capability tool registry", () => {
  it("assembles a stable capability-backed tool registry", async () => {
    const registry = await resolveCapabilityPiToolRegistry(createCapabilityBindings());

    expect(registry.toolNames).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "find",
      "grep",
      "ls",
      "mcp_registry",
      "agent_messages",
      "agent_memory",
    ]);
    expect(registry.skillSnapshot?.skills.map((skill) => skill.name)).toEqual(["starter-skill"]);
    expect(registry.customTools.map((tool) => tool.name)).toEqual([
      "mcp_registry",
      "agent_messages",
      "agent_memory",
    ]);
  });

  it("rejects two capability tools with the same name", async () => {
    await expect(
      resolveCapabilityPiToolRegistry({
        fileTools: { piTools: [{ name: "read", description: "a" }, { name: "read", description: "b" }] as never },
      }),
    ).rejects.toThrow(/read/);
  });
});
