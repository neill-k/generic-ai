import type { AgentHarnessRole } from "@generic-ai/sdk";

import type { WebUiTemplateDefinition, WebUiTemplateRegistry } from "./types.js";

const readOnlyTools = ["workspace.read", "repo.inspect"] as const;
const stopToolExecution = { turnMode: "stop-tool-loop", maxTurns: 8 } as const;

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

function runnableTemplate(input: Omit<WebUiTemplateDefinition, "status" | "effects">): WebUiTemplateDefinition {
  return {
    ...input,
    status: "runnable",
    effects: ["fs.read"],
  };
}

function previewTemplate(
  input: Omit<WebUiTemplateDefinition, "status" | "effects" | "edits"> & {
    readonly previewReason: string;
  },
): WebUiTemplateDefinition {
  return {
    ...input,
    status: "preview",
    effects: [],
    edits: [],
  };
}

export const builtInWebUiTemplates: readonly WebUiTemplateDefinition[] = Object.freeze([
  runnableTemplate({
    id: "hierarchical",
    label: "Hierarchical",
    summary: "A planner decomposes work, specialists investigate, and a verifier checks the final answer.",
    sampleTask: "Plan a small release and identify the verification steps.",
    topology: {
      nodes: [
        { id: "planner", label: "Planner", kind: "planner" },
        { id: "researcher", label: "Researcher", kind: "explorer" },
        { id: "builder", label: "Builder", kind: "builder" },
        { id: "verifier", label: "Verifier", kind: "verifier" },
      ],
      edges: [
        { from: "planner", to: "researcher", label: "scopes" },
        { from: "planner", to: "builder", label: "assigns" },
        { from: "builder", to: "verifier", label: "hands off" },
        { from: "verifier", to: "planner", label: "reports" },
      ],
    },
    edits: [
      {
        action: "set",
        concern: "framework",
        value: {
          schemaVersion: "v1",
          name: "Generic AI hierarchical console template",
          primaryAgent: "hierarchical-planner",
          primaryHarness: "hierarchical",
          metadata: { webUiTemplate: "hierarchical" },
        },
      },
      {
        action: "set",
        concern: "agent",
        key: "hierarchical-planner",
        value: {
          displayName: "Hierarchical Planner",
          model: "gpt-5.5",
          instructions: "Break the user request into specialist work, coordinate results, and produce a concise final plan.",
          tools: [...readOnlyTools],
          plugins: [],
          execution: stopToolExecution,
        },
      },
      {
        action: "set",
        concern: "harness",
        key: "hierarchical",
        value: {
          displayName: "Hierarchical Multi-Agent Harness",
          adapter: "pi",
          controller: "model-directed",
          model: "gpt-5.5",
          primaryAgent: "hierarchical-planner",
          policyProfile: "local-dev-full",
          execution: stopToolExecution,
          roles: [
            role("planner", "planner", "Owns decomposition and final synthesis.", "Decompose the request and coordinate read-only specialists."),
            role("researcher", "explorer", "Finds relevant facts and constraints.", "Inspect available context and return evidence-backed notes."),
            role("builder", "builder", "Drafts the proposed solution.", "Create a solution proposal from planner and researcher inputs without mutating files."),
            role("verifier", "verifier", "Checks completeness and risks.", "Verify the proposal against the request and list residual risks."),
          ],
          tools: [...readOnlyTools],
          allowNetwork: false,
          allowMcp: false,
          artifactDir: ".generic-ai/artifacts/hierarchical",
          metadata: { protocol: "hierarchy" },
        },
      },
    ],
  }),
  runnableTemplate({
    id: "pipeline",
    label: "Pipeline",
    summary: "Sequential stages pass artifacts through analysis, draft, review, and finalization.",
    sampleTask: "Turn a rough feature idea into a reviewed implementation checklist.",
    topology: {
      nodes: [
        { id: "intake", label: "Intake", kind: "planner" },
        { id: "draft", label: "Draft", kind: "builder" },
        { id: "review", label: "Review", kind: "verifier" },
        { id: "final", label: "Final", kind: "custom" },
      ],
      edges: [
        { from: "intake", to: "draft" },
        { from: "draft", to: "review" },
        { from: "review", to: "final" },
      ],
    },
    edits: [
      {
        action: "set",
        concern: "framework",
        value: {
          schemaVersion: "v1",
          name: "Generic AI pipeline console template",
          primaryAgent: "pipeline-intake",
          primaryHarness: "pipeline",
          metadata: { webUiTemplate: "pipeline" },
        },
      },
      {
        action: "set",
        concern: "agent",
        key: "pipeline-intake",
        value: {
          displayName: "Pipeline Intake",
          model: "gpt-5.5",
          instructions: "Convert the user request into ordered stage inputs and preserve stage boundaries.",
          tools: [...readOnlyTools],
          plugins: [],
          execution: stopToolExecution,
        },
      },
      {
        action: "set",
        concern: "harness",
        key: "pipeline",
        value: {
          displayName: "Pipeline Harness",
          adapter: "pi",
          controller: "model-directed",
          model: "gpt-5.5",
          primaryAgent: "pipeline-intake",
          policyProfile: "local-dev-full",
          execution: stopToolExecution,
          roles: [
            role("intake", "planner", "Normalizes the request.", "Identify inputs, constraints, and success criteria."),
            role("draft", "builder", "Produces the candidate answer.", "Draft the requested output using the intake notes."),
            role("review", "verifier", "Reviews the draft.", "Check the draft for gaps, risks, and unsupported claims."),
            role("final", "custom", "Finalizes the answer.", "Merge the reviewed draft into a crisp final response."),
          ],
          tools: [...readOnlyTools],
          allowNetwork: false,
          allowMcp: false,
          artifactDir: ".generic-ai/artifacts/pipeline",
          metadata: { protocol: "pipeline" },
        },
      },
    ],
  }),
  runnableTemplate({
    id: "critic-verifier",
    label: "Critic Verifier",
    summary: "A builder proposes, a critic challenges, and a verifier decides when evidence is sufficient.",
    sampleTask: "Evaluate a proposed refactor and decide whether it is ready.",
    topology: {
      nodes: [
        { id: "builder", label: "Builder", kind: "builder" },
        { id: "critic", label: "Critic", kind: "custom" },
        { id: "verifier", label: "Verifier", kind: "verifier" },
      ],
      edges: [
        { from: "builder", to: "critic", label: "proposal" },
        { from: "critic", to: "builder", label: "challenge" },
        { from: "critic", to: "verifier", label: "evidence" },
      ],
    },
    edits: [
      {
        action: "set",
        concern: "framework",
        value: {
          schemaVersion: "v1",
          name: "Generic AI critic-verifier console template",
          primaryAgent: "critic-verifier-builder",
          primaryHarness: "critic-verifier",
          metadata: { webUiTemplate: "critic-verifier" },
        },
      },
      {
        action: "set",
        concern: "agent",
        key: "critic-verifier-builder",
        value: {
          displayName: "Critic-Verifier Builder",
          model: "gpt-5.5",
          instructions: "Propose a solution, respond to critique, and wait for verifier acceptance before finalizing.",
          tools: [...readOnlyTools],
          plugins: [],
          execution: stopToolExecution,
        },
      },
      {
        action: "set",
        concern: "harness",
        key: "critic-verifier",
        value: {
          displayName: "Critic Verifier Harness",
          adapter: "pi",
          controller: "model-directed",
          model: "gpt-5.5",
          primaryAgent: "critic-verifier-builder",
          policyProfile: "local-dev-full",
          execution: stopToolExecution,
          roles: [
            role("builder", "builder", "Creates the candidate answer.", "Draft the answer and explicitly state assumptions."),
            role("critic", "custom", "Challenges weak spots.", "Find missing evidence, brittle assumptions, and likely failure modes."),
            role("verifier", "verifier", "Accepts or rejects the result.", "Decide whether the response meets the task and name remaining risk."),
          ],
          tools: [...readOnlyTools],
          allowNetwork: false,
          allowMcp: false,
          artifactDir: ".generic-ai/artifacts/critic-verifier",
          metadata: { protocol: "verifier-loop" },
        },
      },
    ],
  }),
  runnableTemplate({
    id: "hub-spoke",
    label: "Hub And Spoke",
    summary: "A coordinator fans out parallel specialist reads and aggregates their findings.",
    sampleTask: "Compare several implementation options and recommend one.",
    topology: {
      nodes: [
        { id: "hub", label: "Coordinator", kind: "planner" },
        { id: "spoke-a", label: "Specialist A", kind: "explorer" },
        { id: "spoke-b", label: "Specialist B", kind: "explorer" },
        { id: "spoke-c", label: "Specialist C", kind: "explorer" },
      ],
      edges: [
        { from: "hub", to: "spoke-a" },
        { from: "hub", to: "spoke-b" },
        { from: "hub", to: "spoke-c" },
        { from: "spoke-a", to: "hub" },
        { from: "spoke-b", to: "hub" },
        { from: "spoke-c", to: "hub" },
      ],
    },
    edits: [
      {
        action: "set",
        concern: "framework",
        value: {
          schemaVersion: "v1",
          name: "Generic AI hub-spoke console template",
          primaryAgent: "hub-spoke-coordinator",
          primaryHarness: "hub-spoke",
          metadata: { webUiTemplate: "hub-spoke" },
        },
      },
      {
        action: "set",
        concern: "agent",
        key: "hub-spoke-coordinator",
        value: {
          displayName: "Hub-Spoke Coordinator",
          model: "gpt-5.5",
          instructions: "Route subquestions to specialists, merge findings, and produce an evidence-weighted recommendation.",
          tools: [...readOnlyTools],
          plugins: [],
          execution: stopToolExecution,
        },
      },
      {
        action: "set",
        concern: "harness",
        key: "hub-spoke",
        value: {
          displayName: "Hub And Spoke Harness",
          adapter: "pi",
          controller: "model-directed",
          model: "gpt-5.5",
          primaryAgent: "hub-spoke-coordinator",
          policyProfile: "local-dev-full",
          execution: stopToolExecution,
          roles: [
            role("hub", "planner", "Routes and synthesizes work.", "Break the question into specialist reads and merge the findings."),
            role("spoke-a", "explorer", "Investigates option A.", "Inspect the context for the first plausible option."),
            role("spoke-b", "explorer", "Investigates option B.", "Inspect the context for the second plausible option."),
            role("spoke-c", "explorer", "Investigates option C.", "Inspect the context for the third plausible option."),
          ],
          tools: [...readOnlyTools],
          allowNetwork: false,
          allowMcp: false,
          artifactDir: ".generic-ai/artifacts/hub-spoke",
          metadata: { protocol: "squad" },
        },
      },
    ],
  }),
  previewTemplate({
    id: "star-router",
    label: "Star Router",
    summary: "A router chooses one or more specialists for each turn.",
    previewReason: "Router selection needs an SDK protocol contract before this can be generated as runnable YAML.",
    sampleTask: "Route product, code, and verification questions to different specialists.",
    topology: {
      nodes: [
        { id: "router", label: "Router", kind: "planner" },
        { id: "product", label: "Product", kind: "custom" },
        { id: "code", label: "Code", kind: "builder" },
        { id: "qa", label: "QA", kind: "verifier" },
      ],
      edges: [
        { from: "router", to: "product" },
        { from: "router", to: "code" },
        { from: "router", to: "qa" },
      ],
    },
  }),
  previewTemplate({
    id: "peer-swarm",
    label: "Peer Swarm",
    summary: "Peers work independently, then a synthesis pass merges the strongest outputs.",
    previewReason: "Peer coordination and synthesis semantics are not yet a stable SDK protocol.",
    topology: {
      nodes: [
        { id: "peer-a", label: "Peer A", kind: "custom" },
        { id: "peer-b", label: "Peer B", kind: "custom" },
        { id: "peer-c", label: "Peer C", kind: "custom" },
        { id: "synth", label: "Synthesis", kind: "planner" },
      ],
      edges: [
        { from: "peer-a", to: "synth" },
        { from: "peer-b", to: "synth" },
        { from: "peer-c", to: "synth" },
      ],
    },
  }),
  previewTemplate({
    id: "blackboard",
    label: "Blackboard",
    summary: "Agents coordinate through shared artifacts and update the shared board as they learn.",
    previewReason: "Blackboard state requires a shared state contract before runnable YAML can be honest.",
    topology: {
      nodes: [
        { id: "board", label: "Shared Board", kind: "state" },
        { id: "analyst", label: "Analyst", kind: "explorer" },
        { id: "builder", label: "Builder", kind: "builder" },
        { id: "verifier", label: "Verifier", kind: "verifier" },
      ],
      edges: [
        { from: "analyst", to: "board" },
        { from: "builder", to: "board" },
        { from: "verifier", to: "board" },
        { from: "board", to: "builder" },
      ],
    },
  }),
  previewTemplate({
    id: "debate",
    label: "Debate",
    summary: "Competing agents argue positions before a judge chooses the answer.",
    previewReason: "Debate judging and transcript semantics need an SDK protocol contract.",
    topology: {
      nodes: [
        { id: "pro", label: "Pro", kind: "custom" },
        { id: "con", label: "Con", kind: "custom" },
        { id: "judge", label: "Judge", kind: "verifier" },
      ],
      edges: [
        { from: "pro", to: "judge" },
        { from: "con", to: "judge" },
      ],
    },
  }),
  previewTemplate({
    id: "market-bidding",
    label: "Market Bidding",
    summary: "Agents bid for work based on capability fit, then winners execute tasks.",
    previewReason: "Bidding, claims, and task-market state are deferred protocol primitives.",
    topology: {
      nodes: [
        { id: "market", label: "Task Market", kind: "state" },
        { id: "agent-a", label: "Agent A", kind: "custom" },
        { id: "agent-b", label: "Agent B", kind: "custom" },
        { id: "agent-c", label: "Agent C", kind: "custom" },
      ],
      edges: [
        { from: "agent-a", to: "market" },
        { from: "agent-b", to: "market" },
        { from: "agent-c", to: "market" },
        { from: "market", to: "agent-a" },
      ],
    },
  }),
  previewTemplate({
    id: "map-reduce",
    label: "Map Reduce",
    summary: "Shard a task across workers and reduce the outputs into one answer.",
    previewReason: "Shard/reduce semantics are not yet represented in the harness protocol surface.",
    topology: {
      nodes: [
        { id: "mapper-a", label: "Mapper A", kind: "custom" },
        { id: "mapper-b", label: "Mapper B", kind: "custom" },
        { id: "mapper-c", label: "Mapper C", kind: "custom" },
        { id: "reducer", label: "Reducer", kind: "planner" },
      ],
      edges: [
        { from: "mapper-a", to: "reducer" },
        { from: "mapper-b", to: "reducer" },
        { from: "mapper-c", to: "reducer" },
      ],
    },
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
