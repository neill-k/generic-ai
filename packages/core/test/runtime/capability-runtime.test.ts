import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCapabilityPiAgentSession,
  type PiCapabilityBindings,
  resolveCapabilityPiToolRegistry,
  runCapabilityPiAgentSession,
} from "../../src/runtime/index.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "core-capability-runtime-"));
  tempRoots.push(root);

  try {
    return await run(root);
  } finally {
    tempRoots.splice(tempRoots.indexOf(root), 1);
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seedSkillFile(root: string): Promise<void> {
  const skillDir = path.join(root, ".agents", "skills", "starter-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: starter-skill
description: explain the starter stack
---

Use this skill when explaining the starter stack.`,
    "utf8",
  );
}

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
            source: "project",
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

describe("@generic-ai/core capability pi runtime bridge", () => {
  it("assembles a stable capability-backed pi tool registry", async () => {
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

  it("injects capability tools and skills into the createAgentSession boundary", async () => {
    await withTempRoot(async (root) => {
      await seedSkillFile(root);
      let capturedOptions:
        | ({
            resourceLoader?: {
              getSkills(): { skills: { name: string }[] };
            };
          } & Record<string, unknown>)
        | undefined;

      await createCapabilityPiAgentSession(
        {
          cwd: root,
          sessionManager: SessionManager.inMemory(),
          capabilities: createCapabilityBindings(root),
          resourceLoaderOptions: {
            noExtensions: true,
            noPromptTemplates: true,
            noThemes: true,
            noSkills: true,
          },
        },
        {
          createAgentSession: async (options) => {
            capturedOptions = options as typeof capturedOptions;
            return {
              session: { sessionId: "session-001" },
              extensionsResult: {
                extensionCount: 0,
                loadErrors: [],
                loadedExtensions: [],
                commands: [],
                tools: [],
              },
            } as never;
          },
        },
      );

      expect(capturedOptions?.tools).toEqual([
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
      expect((capturedOptions?.customTools as { name: string }[]).map((tool) => tool.name)).toEqual([
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
      expect(
        capturedOptions?.resourceLoader?.getSkills().skills.map((skill) => skill.name),
      ).toEqual(["starter-skill"]);
    });
  });

  it("runs a bridged pi session and forwards prompt activity into canonical events", async () => {
    await withTempRoot(async (root) => {
      await seedSkillFile(root);
      let listener: ((event: unknown) => void) | undefined;

      const result = await runCapabilityPiAgentSession(
        {
          cwd: root,
          sessionManager: SessionManager.inMemory(),
          capabilities: createCapabilityBindings(root),
          prompt: "Summarize the starter stack",
          resourceLoaderOptions: {
            noExtensions: true,
            noPromptTemplates: true,
            noThemes: true,
            noSkills: true,
          },
        },
        {
          createAgentSession: async () =>
            ({
              session: {
                sessionId: "session-002",
                messages: [{ role: "assistant" }],
                subscribe(callback: (event: unknown) => void) {
                  listener = callback;
                  return () => {
                    listener = undefined;
                  };
                },
                async prompt() {
                  listener?.({
                    type: "message_update",
                    assistantMessageEvent: {
                      type: "text_delta",
                      delta: "starter stack",
                    },
                  });
                  listener?.({
                    type: "tool_execution_start",
                    toolCallId: "tool-001",
                    toolName: "agent_memory",
                  });
                  listener?.({
                    type: "tool_execution_end",
                    toolCallId: "tool-001",
                    toolName: "agent_memory",
                    isError: false,
                  });
                },
              },
              extensionsResult: {
                extensionCount: 0,
                loadErrors: [],
                loadedExtensions: [],
                commands: [],
                tools: [],
              },
            }) as never,
        },
      );

      expect(result.failureMessage).toBeUndefined();
      expect(result.envelope.status).toBe("succeeded");
      expect(result.events.map((event) => event.name)).toEqual([
        "run.created",
        "session.created",
        "run.started",
        "session.started",
        "plugin.generic-ai-runtime.pi.message_update",
        "plugin.generic-ai-runtime.pi.tool_execution_start",
        "plugin.generic-ai-runtime.pi.tool_execution_end",
        "session.completed",
        "run.completed",
      ]);
      expect(result.envelope.eventStream).toEqual({
        kind: "event-stream-reference",
        streamId: result.envelope.runId,
        sequence: result.events.at(-1)?.sequence,
      });
    });
  });
});
