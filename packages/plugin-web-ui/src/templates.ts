import type { AgentHarnessLoopConfig, AgentHarnessRole } from "@generic-ai/sdk";

import type { WebUiTemplateDefinition, WebUiTemplateRegistry } from "./types.js";

const readOnlyTools = ["workspace.read", "repo.inspect"] as const;
const codexReadTools = [
  "workspace.read",
  "workspace.find",
  "workspace.grep",
  "repo.inspect",
  "lsp",
] as const;
const codexExecutionTools = [
  ...codexReadTools,
  "workspace.write",
  "workspace.edit",
  "terminal.run",
] as const;

const codexAgentLoop = {
  pattern: "thread-turn-tool-policy",
  stateModel: "thread-turn-item",
  entryStage: "thread-log",
  terminalStages: ["thread-log"],
  stages: [
    {
      id: "thread-log",
      kind: "state",
      description: "Durable conversation, tool, and evidence history.",
      effects: ["memory.read", "memory.write", "artifact.write"],
    },
    {
      id: "context-builder",
      kind: "context-builder",
      roleRef: "context-builder",
      description: "Assembles instructions, config, repo facts, skills, and runtime affordances.",
      tools: [...codexReadTools],
      effects: ["fs.read", "repo.inspect", "lsp.read"],
      readOnly: true,
    },
    {
      id: "controller",
      kind: "controller",
      roleRef: "controller",
      description: "Owns the single active turn, interruptions, compaction, and final synthesis.",
      tools: [...codexExecutionTools],
      effects: ["handoff.read", "handoff.write", "artifact.write"],
    },
    {
      id: "tool-router",
      kind: "tool-router",
      roleRef: "tool-router",
      description: "Resolves model tool calls into typed local, MCP, terminal, or config actions.",
      tools: [...codexExecutionTools],
      effects: ["fs.read", "fs.write", "process.spawn", "repo.inspect", "lsp.read"],
    },
    {
      id: "permission-gate",
      kind: "policy-gate",
      roleRef: "permission-gate",
      description: "Checks mutating effects before writes, terminal commands, and network access.",
      tools: [...codexReadTools],
      effects: ["fs.read", "repo.inspect", "lsp.read"],
      readOnly: true,
    },
    {
      id: "executor",
      kind: "executor",
      roleRef: "executor",
      description: "Runs approved edits and commands while streaming events.",
      tools: [...codexExecutionTools],
      effects: ["fs.read", "fs.write", "process.spawn", "repo.inspect", "lsp.read"],
    },
    {
      id: "verifier",
      kind: "verifier",
      roleRef: "verifier",
      description: "Reads artifacts, runs checks, and decides if evidence is sufficient.",
      tools: [...codexReadTools, "terminal.run"],
      effects: ["fs.read", "process.spawn", "repo.inspect", "lsp.read"],
    },
  ],
  transitions: [
    { from: "thread-log", to: "context-builder", label: "replay" },
    { from: "context-builder", to: "controller", label: "turn context" },
    { from: "controller", to: "tool-router", label: "tool calls" },
    { from: "tool-router", to: "permission-gate", label: "effects" },
    { from: "permission-gate", to: "executor", label: "approved" },
    { from: "executor", to: "thread-log", label: "events" },
    { from: "executor", to: "verifier", label: "artifacts" },
    { from: "verifier", to: "controller", label: "evidence" },
    { from: "controller", to: "thread-log", label: "messages" },
  ],
  invariants: [
    "Assemble turn context before routing tools.",
    "Route mutating actions through policy before execution.",
    "Persist execution evidence before verification.",
    "Finalize only after verification or an explicit blocker.",
  ],
  metadata: {
    source: "openai/codex",
    sourceCommit: "4e05f3053c840fc77321bfab0aef65ec50448a9e",
  },
} as const satisfies AgentHarnessLoopConfig;

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
  input: Omit<WebUiTemplateDefinition, "status" | "effects"> & {
    readonly effects?: WebUiTemplateDefinition["effects"];
  },
): WebUiTemplateDefinition {
  const { effects = ["fs.read"], ...template } = input;
  return {
    ...template,
    status: "runnable",
    effects,
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
    summary:
      "A planner decomposes work, specialists investigate, and a verifier checks the final answer.",
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
          instructions:
            "Break the user request into specialist work, coordinate results, and produce a concise final plan.",
          tools: [...readOnlyTools],
          plugins: [],
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
          roles: [
            role(
              "planner",
              "planner",
              "Owns decomposition and final synthesis.",
              "Decompose the request and coordinate read-only specialists.",
            ),
            role(
              "researcher",
              "explorer",
              "Finds relevant facts and constraints.",
              "Inspect available context and return evidence-backed notes.",
            ),
            role(
              "builder",
              "builder",
              "Drafts the proposed solution.",
              "Create a solution proposal from planner and researcher inputs without mutating files.",
            ),
            role(
              "verifier",
              "verifier",
              "Checks completeness and risks.",
              "Verify the proposal against the request and list residual risks.",
            ),
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
          instructions:
            "Convert the user request into ordered stage inputs and preserve stage boundaries.",
          tools: [...readOnlyTools],
          plugins: [],
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
          roles: [
            role(
              "intake",
              "planner",
              "Normalizes the request.",
              "Identify inputs, constraints, and success criteria.",
            ),
            role(
              "draft",
              "builder",
              "Produces the candidate answer.",
              "Draft the requested output using the intake notes.",
            ),
            role(
              "review",
              "verifier",
              "Reviews the draft.",
              "Check the draft for gaps, risks, and unsupported claims.",
            ),
            role(
              "final",
              "custom",
              "Finalizes the answer.",
              "Merge the reviewed draft into a crisp final response.",
            ),
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
    summary:
      "A builder proposes, a critic challenges, and a verifier decides when evidence is sufficient.",
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
          instructions:
            "Propose a solution, respond to critique, and wait for verifier acceptance before finalizing.",
          tools: [...readOnlyTools],
          plugins: [],
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
          roles: [
            role(
              "builder",
              "builder",
              "Creates the candidate answer.",
              "Draft the answer and explicitly state assumptions.",
            ),
            role(
              "critic",
              "custom",
              "Challenges weak spots.",
              "Find missing evidence, brittle assumptions, and likely failure modes.",
            ),
            role(
              "verifier",
              "verifier",
              "Accepts or rejects the result.",
              "Decide whether the response meets the task and name remaining risk.",
            ),
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
          instructions:
            "Route subquestions to specialists, merge findings, and produce an evidence-weighted recommendation.",
          tools: [...readOnlyTools],
          plugins: [],
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
          roles: [
            role(
              "hub",
              "planner",
              "Routes and synthesizes work.",
              "Break the question into specialist reads and merge the findings.",
            ),
            role(
              "spoke-a",
              "explorer",
              "Investigates option A.",
              "Inspect the context for the first plausible option.",
            ),
            role(
              "spoke-b",
              "explorer",
              "Investigates option B.",
              "Inspect the context for the second plausible option.",
            ),
            role(
              "spoke-c",
              "explorer",
              "Investigates option C.",
              "Inspect the context for the third plausible option.",
            ),
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
  runnableTemplate({
    id: "codex-cli-agent-loop",
    label: "Codex CLI Agent Loop",
    summary:
      "A thread-backed controller assembles context, routes typed tools through policy, records evidence, and verifies before final output.",
    sampleTask:
      "Implement a small code change, preserve evidence, and report exactly what was verified.",
    effects: ["fs.read", "fs.write", "process.spawn"],
    topology: {
      nodes: [
        {
          id: "thread-log",
          label: "Thread/Turn/Item Log",
          kind: "state",
          description: "Durable conversation, tool, and evidence history.",
        },
        {
          id: "context-builder",
          label: "Context Builder",
          kind: "planner",
          description:
            "Assembles instructions, config, repo facts, skills, and runtime affordances.",
        },
        {
          id: "controller",
          label: "Session Controller",
          kind: "root",
          description:
            "Owns the single active turn, interruptions, compaction, and final synthesis.",
        },
        {
          id: "tool-router",
          label: "Tool Router",
          kind: "custom",
          description:
            "Resolves model tool calls into typed local, MCP, terminal, or config actions.",
        },
        {
          id: "permission-gate",
          label: "Permission Gate",
          kind: "verifier",
          description:
            "Checks mutating effects before writes, terminal commands, and network access.",
        },
        {
          id: "executor",
          label: "Executor",
          kind: "builder",
          description: "Runs approved edits and commands while streaming events.",
        },
        {
          id: "verifier",
          label: "Verifier",
          kind: "verifier",
          description: "Reads artifacts, runs checks, and decides if evidence is sufficient.",
        },
      ],
      edges: [
        { from: "thread-log", to: "context-builder", label: "replay" },
        { from: "context-builder", to: "controller", label: "turn context" },
        { from: "controller", to: "tool-router", label: "tool calls" },
        { from: "tool-router", to: "permission-gate", label: "effects" },
        { from: "permission-gate", to: "executor", label: "approved" },
        { from: "executor", to: "thread-log", label: "events" },
        { from: "executor", to: "verifier", label: "artifacts" },
        { from: "verifier", to: "controller", label: "evidence" },
        { from: "controller", to: "thread-log", label: "messages" },
      ],
    },
    edits: [
      {
        action: "set",
        concern: "framework",
        value: {
          schemaVersion: "v1",
          name: "Generic AI Codex CLI agent-loop console template",
          primaryAgent: "codex-cli-controller",
          primaryHarness: "codex-cli-agent-loop",
          metadata: {
            webUiTemplate: "codex-cli-agent-loop",
            inspiredBy: "openai/codex",
          },
        },
      },
      {
        action: "set",
        concern: "agent",
        key: "codex-cli-controller",
        value: {
          displayName: "Codex CLI Controller",
          model: "gpt-5.5",
          instructions:
            "Run each request as a durable thread/turn loop: assemble context first, route every action through typed tools, enforce policy before mutation, persist evidence, and verify before final output.",
          tools: [...codexExecutionTools],
          plugins: [],
          metadata: {
            pattern: "thread-turn-item-control-plane",
          },
        },
      },
      {
        action: "set",
        concern: "harness",
        key: "codex-cli-agent-loop",
        value: {
          displayName: "Codex CLI Agent Loop Harness",
          adapter: "pi",
          controller: "model-directed",
          model: "gpt-5.5",
          primaryAgent: "codex-cli-controller",
          policyProfile: "local-dev-full",
          loop: codexAgentLoop,
          roles: [
            {
              id: "controller",
              kind: "root",
              description:
                "Owns the thread lifecycle, interrupts, compaction, and final synthesis.",
              instructions:
                "Keep one active turn at a time, preserve evidence, and decide when to delegate, continue, compact, or finish.",
              tools: [...codexExecutionTools],
            },
            {
              id: "context-builder",
              kind: "planner",
              description: "Builds a turn-specific context pack before model sampling.",
              instructions:
                "Read the repo, instructions, config, available tools, and relevant prior state before proposing actions.",
              tools: [...codexReadTools],
              readOnly: true,
            },
            {
              id: "tool-router",
              kind: "custom",
              description: "Maps requested actions onto typed tools and declared effects.",
              instructions:
                "Classify each action by tool, effect, mutability, and whether parallel execution is safe.",
              tools: [...codexExecutionTools],
            },
            {
              id: "permission-gate",
              kind: "verifier",
              description:
                "Checks effects, sandbox policy, and approval requirements before mutation.",
              instructions:
                "Require explicit evidence that every mutating or process-spawning action is allowed by the active policy profile.",
              tools: [...codexReadTools],
              readOnly: true,
            },
            {
              id: "executor",
              kind: "builder",
              description: "Runs approved file and terminal actions while emitting evidence.",
              instructions:
                "Apply approved edits and commands, keep outputs attached to the turn, and stop cleanly on policy or runtime failure.",
              tools: [...codexExecutionTools],
            },
            {
              id: "verifier",
              kind: "verifier",
              description: "Validates artifacts and run evidence before completion.",
              instructions:
                "Run the smallest sufficient checks, inspect outputs, and return whether the turn is ready to finalize.",
              tools: [...codexReadTools, "terminal.run"],
            },
          ],
          tools: [...codexExecutionTools],
          allowNetwork: false,
          allowMcp: false,
          artifactDir: ".generic-ai/artifacts/codex-cli-agent-loop",
          metadata: {
            protocol: "hierarchy",
            source: "openai/codex",
            sourceCommit: "4e05f3053c840fc77321bfab0aef65ec50448a9e",
            lessons: [
              "Keep protocol types small and business-logic-free so multiple UIs can share the same core.",
              "Persist thread, turn, item, tool, and evidence events so runs can resume, fork, compact, and replay.",
              "Assemble context explicitly before sampling instead of letting each tool call rediscover state.",
              "Route all tools through effect-aware handlers with policy, hooks, telemetry, and cancellation.",
              "Treat subagents as thread-backed workers with registry, mailbox, depth, and status controls.",
            ],
          },
        },
      },
    ],
  }),
  previewTemplate({
    id: "star-router",
    label: "Star Router",
    summary: "A router chooses one or more specialists for each turn.",
    previewReason:
      "Router selection needs an SDK protocol contract before this can be generated as runnable YAML.",
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
    summary:
      "Agents coordinate through shared artifacts and update the shared board as they learn.",
    previewReason:
      "Blackboard state requires a shared state contract before runnable YAML can be honest.",
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
    previewReason:
      "Shard/reduce semantics are not yet represented in the harness protocol surface.",
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
