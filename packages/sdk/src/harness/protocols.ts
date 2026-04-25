import type {
  CompiledHarness,
  CompileDiagnostic,
  ProtocolAction,
  ProtocolPlugin,
  ProtocolState,
  ProtocolSummary,
  TraceEvent,
} from "./types.js";

function firstActor(compiled: CompiledHarness): string | undefined {
  return compiled.agents[0]?.id;
}

function actorByRole(compiled: CompiledHarness, role: string): string | undefined {
  return compiled.agents.find((agent) => agent.role === role)?.id;
}

function hasCompleted(events: readonly TraceEvent[]): boolean {
  return events.some((event) => event.type === "trial.completed" || event.type === "benchmark.completed");
}

function action(input: {
  readonly id: string;
  readonly kind: ProtocolAction["kind"];
  readonly actorRef?: string;
  readonly payload?: ProtocolAction["payload"];
}): ProtocolAction {
  return Object.freeze({
    id: input.id,
    idempotencyKey: input.id,
    kind: input.kind,
    ...(input.actorRef === undefined ? {} : { actorRef: input.actorRef }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
}

function summary(status: ProtocolState["status"], actions: readonly ProtocolAction[]): ProtocolSummary {
  return Object.freeze({
    status,
    actionCount: actions.length,
    blockerCount: status === "blocked" ? 1 : 0,
  });
}

function state(status: ProtocolState["status"]): ProtocolState {
  return Object.freeze({ status });
}

function requireActors(compiled: CompiledHarness, roles: readonly string[]): readonly CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const role of roles) {
    if (actorByRole(compiled, role) === undefined) {
      diagnostics.push({
        severity: "error",
        code: "missing_protocol_actor",
        message: `Protocol requires an actor with role "${role}".`,
        path: "agents",
      });
    }
  }
  return Object.freeze(diagnostics);
}

export function createPipelineProtocol(): ProtocolPlugin {
  const plugin: ProtocolPlugin = {
    manifest: {
      id: "@generic-ai/protocol-pipeline",
      name: "Pipeline Protocol",
      version: "0.1.0",
      protocol: "pipeline",
    },
    initialize: async () => state("ready"),
    validate: async (compiled) => (firstActor(compiled) === undefined ? requireActors(compiled, ["implementer"]) : []),
    reduce: async ({ compiled, events }) => {
      if (hasCompleted(events)) {
        const nextState = state("done");
        return { state: nextState, actions: [], summary: summary(nextState.status, []) };
      }

      const actorRef = firstActor(compiled);
      const actions =
        actorRef === undefined
          ? []
          : [
              action({
                id: `${compiled.id}:pipeline:invoke:${actorRef}`,
                kind: "invoke_actor",
                actorRef,
                payload: {
                  stage: "plan-implement-test-review-finalize",
                },
              }),
            ];
      const nextState = state(actorRef === undefined ? "blocked" : "ready");
      return { state: nextState, actions, summary: summary(nextState.status, actions) };
    },
  };
  return Object.freeze(plugin);
}

export function createVerifierLoopProtocol(): ProtocolPlugin {
  const plugin: ProtocolPlugin = {
    manifest: {
      id: "@generic-ai/protocol-verifier-loop",
      name: "Verifier Loop Protocol",
      version: "0.1.0",
      protocol: "verifier-loop",
    },
    initialize: async () => state("ready"),
    validate: async (compiled) => requireActors(compiled, ["solver", "critic", "repairer"]),
    reduce: async ({ compiled, events }) => {
      if (hasCompleted(events)) {
        const nextState = state("done");
        return { state: nextState, actions: [], summary: summary(nextState.status, []) };
      }

      const actors = ["solver", "critic", "repairer"]
        .map((role) => actorByRole(compiled, role))
        .filter((actorRef): actorRef is string => actorRef !== undefined);
      const actions = actors.map((actorRef, index) =>
        action({
          id: `${compiled.id}:verifier-loop:${index + 1}:${actorRef}`,
          kind: "invoke_actor",
          actorRef,
          payload: { loopRole: compiled.agents.find((agent) => agent.id === actorRef)?.role ?? "actor" },
        }),
      );
      const nextState = state(actors.length < 3 ? "blocked" : "ready");
      return { state: nextState, actions, summary: summary(nextState.status, actions) };
    },
  };
  return Object.freeze(plugin);
}

export function createHierarchyProtocol(): ProtocolPlugin {
  const plugin: ProtocolPlugin = {
    manifest: {
      id: "@generic-ai/protocol-hierarchy",
      name: "Hierarchy Protocol",
      version: "0.1.0",
      protocol: "hierarchy",
    },
    initialize: async () => state("ready"),
    validate: async (compiled) => requireActors(compiled, ["manager"]),
    reduce: async ({ compiled, events }) => {
      if (hasCompleted(events)) {
        const nextState = state("done");
        return { state: nextState, actions: [], summary: summary(nextState.status, []) };
      }

      const manager = actorByRole(compiled, "manager");
      const delegatees = compiled.agents
        .filter((agent) => agent.id !== manager)
        .map((agent) => agent.id);
      const actions =
        manager === undefined
          ? []
          : delegatees.map((actorRef) =>
              action({
                id: `${compiled.id}:hierarchy:delegate:${actorRef}`,
                kind: "delegate_work",
                actorRef,
                payload: { assignedBy: manager },
              }),
            );
      const nextState = state(manager === undefined ? "blocked" : "ready");
      return { state: nextState, actions, summary: summary(nextState.status, actions) };
    },
  };
  return Object.freeze(plugin);
}

export function createSquadProtocol(): ProtocolPlugin {
  const plugin: ProtocolPlugin = {
    manifest: {
      id: "@generic-ai/protocol-squad",
      name: "Squad Protocol",
      version: "0.1.0",
      protocol: "squad",
    },
    initialize: async () => state("ready"),
    validate: async (compiled) =>
      compiled.spaces.some((space) => space.visibility === "shared")
        ? []
        : [
            {
              severity: "error",
              code: "missing_shared_space",
              message: "Squad protocol requires at least one shared space.",
              path: "spaces",
            },
          ],
    reduce: async ({ compiled, events }) => {
      if (hasCompleted(events)) {
        const nextState = state("done");
        return { state: nextState, actions: [], summary: summary(nextState.status, []) };
      }

      const actions = compiled.agents.map((agent) =>
        action({
          id: `${compiled.id}:squad:claim:${agent.id}`,
          kind: "claim_work",
          actorRef: agent.id,
          payload: { space: compiled.spaces.find((space) => space.visibility === "shared")?.id ?? "shared" },
        }),
      );
      const nextState = state(actions.length === 0 ? "blocked" : "ready");
      return { state: nextState, actions, summary: summary(nextState.status, actions) };
    },
  };
  return Object.freeze(plugin);
}

export const STANDARD_PROTOCOLS = Object.freeze([
  createPipelineProtocol(),
  createVerifierLoopProtocol(),
  createHierarchyProtocol(),
  createSquadProtocol(),
]);
