import type {
  AgentHarnessAdapter,
  AgentHarnessAdapterRunContext,
  AgentHarnessConfig,
  AgentHarnessRole,
  AgentHarnessRoleKind,
  AgentHarnessRunErrorCategory,
  AgentTaskExecutionInput,
  AgentTaskExecutor,
} from "@generic-ai/sdk";
import { AGENT_HARNESS_ROLE_KINDS } from "@generic-ai/sdk";

/**
 * Runs each agent turn as one run of any SDK `AgentHarnessAdapter`, so the
 * cascade works on Pi today and on the native runtime as soon as it ships an
 * adapter. Each turn gets a single-role harness config built from the agent
 * record: its role kind governs the tool policy and its model overrides the
 * harness default (models per role).
 */
export interface CreateAdapterTaskExecutorOptions<TCapabilities = unknown, TOutput = unknown> {
  readonly adapter: AgentHarnessAdapter<TCapabilities, TOutput>;
  /** Base harness config shared by every agent. */
  readonly harness: AgentHarnessConfig;
  /** Run context per turn (event sink, artifact store, policy evaluator). */
  readonly context:
    | AgentHarnessAdapterRunContext
    | ((input: AgentTaskExecutionInput) => AgentHarnessAdapterRunContext);
  readonly capabilities?: TCapabilities | ((input: AgentTaskExecutionInput) => TCapabilities);
  /** Harness role kind for agents that do not set one. Defaults to `builder`. */
  readonly defaultRoleKind?: AgentHarnessRoleKind;
  /** Per-turn deadline in milliseconds. */
  readonly turnTimeoutMs?: number;
  /**
   * Extra role settings for an agent's turn, such as the secrets it may use or its tool list.
   * `id`, `kind` and `model` always come from the agent record.
   */
  readonly role?: (
    input: AgentTaskExecutionInput,
  ) => Partial<Omit<AgentHarnessRole, "id" | "kind" | "model">> | undefined;
}

const NON_RETRYABLE: ReadonlySet<AgentHarnessRunErrorCategory> = new Set([
  "cancelled",
  "deadline_exceeded",
  "budget_exceeded",
  "policy_denied",
]);

const ROLE_KINDS: ReadonlySet<string> = new Set(AGENT_HARNESS_ROLE_KINDS);

export function resolveAgentRoleKind(
  roleKind: string | undefined,
  fallback: AgentHarnessRoleKind = "builder",
): AgentHarnessRoleKind {
  if (roleKind !== undefined && ROLE_KINDS.has(roleKind) && roleKind !== "root") {
    return roleKind as AgentHarnessRoleKind;
  }
  return fallback;
}

export function createAdapterTaskExecutor<TCapabilities = unknown, TOutput = unknown>(
  options: CreateAdapterTaskExecutorOptions<TCapabilities, TOutput>,
): AgentTaskExecutor {
  return async (input) => {
    const kind = resolveAgentRoleKind(input.roleKind, options.defaultRoleKind);
    const model = input.model ?? options.harness.model;
    const role: AgentHarnessRole = {
      description: `Persistent agent ${input.agentId} (${input.role}).`,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      readOnly: kind !== "builder" && kind !== "custom",
      ...options.role?.(input),
      id: input.agentId,
      kind,
      ...(model === undefined ? {} : { model }),
    };
    const harness: AgentHarnessConfig = {
      ...options.harness,
      id: `${options.harness.id}:${input.agentId}`,
      primaryAgent: input.agentId,
      roles: [role],
      ...(model === undefined ? {} : { model }),
    };
    const context =
      typeof options.context === "function" ? options.context(input) : options.context;
    const capabilities =
      typeof options.capabilities === "function"
        ? (options.capabilities as (value: AgentTaskExecutionInput) => TCapabilities)(input)
        : options.capabilities;
    const deadline =
      options.turnTimeoutMs === undefined
        ? undefined
        : new Date(Date.now() + options.turnTimeoutMs).toISOString();

    const result = await options.adapter.run(
      {
        instruction: input.prompt,
        harness,
        workspaceRoot: input.workspaceRoot,
        runId: input.attemptRunId,
        rootScopeId: `task/${input.rootTaskId}`,
        rootAgentId: input.agentId,
        ...(deadline === undefined ? {} : { deadline }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(input.effectJournal === undefined ? {} : { effectJournal: input.effectJournal }),
        metadata: {
          taskId: input.taskId,
          rootTaskId: input.rootTaskId,
          ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
          agentId: input.agentId,
          role: input.role,
        },
      },
      {
        ...context,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    return {
      status: result.status,
      outputText: result.outputText,
      runIds: [result.envelope.runId],
      ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
      ...(result.errorCategory !== undefined && NON_RETRYABLE.has(result.errorCategory)
        ? { retryable: false }
        : {}),
    };
  };
}

/**
 * Picks an executor per turn, for example a protocol topology for one agent
 * and a single harness run for everyone else.
 */
export function routeTaskExecutor(
  select: (input: AgentTaskExecutionInput) => AgentTaskExecutor | undefined,
  fallback: AgentTaskExecutor,
): AgentTaskExecutor {
  return (input) => (select(input) ?? fallback)(input);
}
