import { createGenericAI } from "@generic-ai/core";
import { createAgentSkillsPlugin } from "@generic-ai/plugin-agent-skills";
import { createDelegationCoordinator } from "@generic-ai/plugin-delegation";
import { createHonoPlugin } from "@generic-ai/plugin-hono";
import { createFileMemoryStore } from "@generic-ai/plugin-memory-files";
import { createMessagingService } from "@generic-ai/plugin-messaging";
import { createMcpRegistry } from "@generic-ai/plugin-mcp";
import { createMemoryStorage } from "@generic-ai/plugin-storage-memory";
import { createWorkspaceFileTools } from "@generic-ai/plugin-tools-files";
import { createTerminalToolPlugin } from "@generic-ai/plugin-tools-terminal";
import { createWorkspaceFs } from "@generic-ai/plugin-workspace-fs";
import {
  createStarterHonoPreset,
  starterHonoPreset,
  type StarterHonoPresetDefinition,
} from "@generic-ai/preset-starter-hono";

export const defaultStarterBootstrap = createGenericAI();

export const explicitStarterBootstrap = createGenericAI({
  preset: createStarterHonoPreset({
    description: "Explicit example override showing the starter preset can be swapped in directly.",
  }),
  ports: {
    pluginHost: {
      status: "provided",
      note: "The example harness provides the current utility-first runtime composition.",
    },
  },
});

export const examplePresets = {
  starterHonoPreset,
  defaultStarterBootstrap,
  explicitStarterBootstrap,
} as const;

export interface ReferenceExampleOptions {
  readonly root: string;
  readonly includeUserSkills?: boolean;
  readonly includeGlobalSkills?: boolean;
}

export interface ReferenceExampleHarness {
  readonly preset: StarterHonoPresetDefinition;
  readonly bootstrap: typeof defaultStarterBootstrap;
  readonly workspaceRoot: string;
  readonly fileTools: ReturnType<typeof createWorkspaceFileTools>;
  readonly terminalTools: ReturnType<typeof createTerminalToolPlugin>;
  readonly skills: ReturnType<typeof createAgentSkillsPlugin>;
  readonly mcp: ReturnType<typeof createMcpRegistry>;
  readonly delegation: ReturnType<typeof createDelegationCoordinator>;
  readonly messaging: ReturnType<typeof createMessagingService>;
  readonly memory: ReturnType<typeof createFileMemoryStore>;
  readonly transport: ReturnType<typeof createHonoPlugin>;
  run(topic?: string): Promise<ReferenceExampleRun>;
}

export interface ReferenceExampleRun {
  readonly bootstrapDescription: string;
  readonly delegatedSummary: string;
  readonly inboxSize: number;
  readonly memoryHits: number;
  readonly skillNames: readonly string[];
  readonly mcpServers: readonly string[];
  readonly transportHealth: {
    readonly transport: string;
    readonly streaming: boolean;
  };
}

async function seedProjectSkill(root: string): Promise<void> {
  const files = createWorkspaceFileTools({ root });

  await files.writeText(
    ".agents/skills/starter-summarizer/SKILL.md",
    `---
name: starter-summarizer
description: summarize the Generic AI starter stack
---

Use this skill when you need to explain the default Generic AI starter stack and call out transport, delegation, messaging, memory, MCP, and skills.`,
  );
}

export async function createReferenceExampleHarness(
  options: ReferenceExampleOptions,
): Promise<ReferenceExampleHarness> {
  const workspace = createWorkspaceFs(options.root);
  await workspace.ensureLayout();
  await seedProjectSkill(workspace.root);

  const fileTools = createWorkspaceFileTools({ root: workspace.root });
  const terminalTools = createTerminalToolPlugin({ root: workspace.root });
  const skills = createAgentSkillsPlugin({
    root: workspace.root,
    includeUser: options.includeUserSkills ?? false,
    includeGlobal: options.includeGlobalSkills ?? false,
  });
  const mcp = createMcpRegistry([
    {
      id: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", workspace.root],
      description: "Workspace filesystem server for the starter stack.",
    },
  ]);
  const delegation = createDelegationCoordinator();
  const messaging = createMessagingService({
    storage: createMemoryStorage(),
  });
  const memory = createFileMemoryStore({
    root: workspace.root,
  });
  const preset = createStarterHonoPreset();
  const bootstrap = createGenericAI({
    preset,
  });

  async function execute(topic: string = "the Generic AI starter stack") {
    await fileTools.writeText(
      "workspace/shared/brief.md",
      `# Brief\n\nTopic: ${topic}\n\nFocus on delegation, messaging, memory, MCP, skills, file tools, terminal tools, and Hono transport.`,
    );

    await memory.remember("coordinator", {
      id: "starter-brief",
      text: "Mention MCP, skills, messaging, memory, file tools, and Hono transport in the answer.",
      tags: ["starter", "demo"],
    });

    messaging.send({
      from: "coordinator",
      to: "implementer",
      body: `Summarize ${topic}.`,
      subject: "Starter stack brief",
      threadId: "starter-demo",
    });

    const loadedSkills = await skills.load();
    const rootSession = delegation.createRootSession({
      topic,
    });
    const delegated = await delegation.delegate(
      rootSession.id,
      {
        agentId: "implementer",
        task: {
          topic,
        },
      },
      async () => {
        const inbox = messaging.inbox("implementer");
        const memoryHits = await memory.search("coordinator", "MCP skills messaging memory transport");
        const sharedFiles = await fileTools.list("workspace/shared");

        return {
          summary: `Implementer saw ${inbox.length} message(s), ${memoryHits.length} memory hit(s), ${sharedFiles.length} shared file(s), ${loadedSkills.skills.length} skill(s), and ${mcp.list().length} MCP server(s) while preparing ${topic}.`,
          inboxSize: inbox.length,
          memoryHits: memoryHits.length,
          skillNames: loadedSkills.skills.map((skill) => skill.name),
          mcpServers: mcp.list().map((server) => server.id),
        };
      },
    );
    delegation.orchestrator.completeSession(rootSession.id, {
      result: delegated.result,
    });

    const healthResponse = await transport.app.request("/starter/health");
    const transportHealth = (await healthResponse.json()) as ReferenceExampleRun["transportHealth"];

    return {
      bootstrapDescription: bootstrap.describe(),
      delegatedSummary: (delegated.result as { summary: string }).summary,
      inboxSize: (delegated.result as { inboxSize: number }).inboxSize,
      memoryHits: (delegated.result as { memoryHits: number }).memoryHits,
      skillNames: (delegated.result as { skillNames: readonly string[] }).skillNames,
      mcpServers: (delegated.result as { mcpServers: readonly string[] }).mcpServers,
      transportHealth,
    } satisfies ReferenceExampleRun;
  }

  const transport = createHonoPlugin({
    routePrefix: "/starter",
    run: async (payload) => execute(typeof payload.input === "string" ? payload.input : undefined),
    stream: async function* (payload) {
      const topic = typeof payload.input === "string" ? payload.input : "the Generic AI starter stack";
      yield {
        event: "status",
        data: {
          state: "started",
          topic,
        },
      };

      const result = await execute(topic);
      yield {
        event: "done",
        data: result,
      };
    },
  });

  return Object.freeze({
    preset,
    bootstrap,
    workspaceRoot: workspace.root,
    fileTools,
    terminalTools,
    skills,
    mcp,
    delegation,
    messaging,
    memory,
    transport,
    run: execute,
  });
}

export async function runReferenceExample(
  options: ReferenceExampleOptions,
  topic?: string,
): Promise<ReferenceExampleRun> {
  const harness = await createReferenceExampleHarness(options);
  return harness.run(topic);
}
