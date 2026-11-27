import type { AgentHarnessRole } from "@generic-ai/sdk";

import type { WebUiTemplateDefinition, WebUiTemplateRegistry } from "./types.js";

const readOnlyTools = ["workspace.read", "repo.inspect"] as const;
const stopToolExecution = { turnMode: "stop-tool-loop" } as const;

function role(
  id: string,
  kind: AgentHarnessRole["kind"],
  description: string,
  instructions: string,
): AgentHarnessRole {
  return {
    id,
    kind,
    description,
    instructions,
    tools: [...readOnlyTools],
    readOnly: true,
  };
}

function runnableTemplate(
  input: Omit<WebUiTemplateDefinition, "status" | "effects">,
): WebUiTemplateDefinition {
  return {
    ...input,
    status: "runnable",
    effects: ["fs.read"],
  };
}

/**
 * One starter team. Agents coordinate the one supported way: a lead hands work down to the agents
 * who report to it, and any agent may ask another a question. There are no fixed patterns
 * (pipeline, squad, hierarchy, verifier loop) and no restricted planner, explorer or verifier
 * roles. The starter only reads the workspace so it is safe to try.
 */
export const builtInWebUiTemplates: readonly WebUiTemplateDefinition[] = Object.freeze([
  runnableTemplate({
    id: "team",
    label: "Team",
    summary:
      "A lead agent and two teammates. The lead hands work down; each does it with its own tools.",
    sampleTask: "Review this workspace and list the three changes that matter most.",
    topology: {
      nodes: [
        { id: "lead", label: "Lead", kind: "builder" },
        { id: "teammate-a", label: "Teammate A", kind: "builder" },
        { id: "teammate-b", label: "Teammate B", kind: "builder" },
      ],
      edges: [
        { from: "lead", to: "teammate-a", label: "delegates" },
        { from: "lead", to: "teammate-b", label: "delegates" },
      ],
    },
    edits: [
      {
        action: "set",
        concern: "framework",
        value: {
          schemaVersion: "v1",
          name: "Generic AI team console template",
          primaryAgent: "team-lead",
          primaryHarness: "team",
          metadata: { webUiTemplate: "team" },
        },
      },
      {
        action: "set",
        concern: "agent",
        key: "team-lead",
        value: {
          displayName: "Team Lead",
          model: "gpt-5.5",
          instructions:
            "Own the request. Do what you can yourself and hand focused pieces to your teammates when that helps.",
          tools: [...readOnlyTools],
          plugins: [],
          execution: stopToolExecution,
        },
      },
      {
        action: "set",
        concern: "harness",
        key: "team",
        value: {
          displayName: "Team Harness",
          adapter: "native",
          controller: "model-directed",
          model: "gpt-5.5",
          primaryAgent: "team-lead",
          policyProfile: "local-dev-full",
          execution: stopToolExecution,
          roles: [
            role(
              "teammate-a",
              "builder",
              "A teammate.",
              "Do the work you are handed and report back with evidence.",
            ),
            role(
              "teammate-b",
              "builder",
              "A teammate.",
              "Do the work you are handed and report back with evidence.",
            ),
          ],
          tools: [...readOnlyTools],
          allowNetwork: false,
          allowMcp: false,
          artifactDir: ".generic-ai/artifacts/team",
        },
      },
    ],
  }),
]);

export function createBuiltInTemplateRegistry(
  templates: readonly WebUiTemplateDefinition[] = builtInWebUiTemplates,
): WebUiTemplateRegistry {
  const byId = new Map(templates.map((template) => [template.id, template]));
  return Object.freeze({
    list(): readonly WebUiTemplateDefinition[] {
      return templates;
    },
    get(id: string): WebUiTemplateDefinition | undefined {
      return byId.get(id);
    },
  });
}
