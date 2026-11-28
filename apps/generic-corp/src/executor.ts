import path from "node:path";

import {
  createAgentHarness,
  createAgentHarnessRunContext,
  type NativeAgentHarnessOptions,
  type PiCapabilityBindings,
} from "@generic-ai/core";
import { createAdapterTaskExecutor, withRunPersistence } from "@generic-ai/plugin-delegation";
import { createWorkspaceFileTools } from "@generic-ai/plugin-tools-files";
import { createTerminalToolPlugin } from "@generic-ai/plugin-tools-terminal";
import {
  type AgentHarnessBudget,
  type AgentHarnessConfig,
  type AgentHarnessPolicyEvaluator,
  type AgentTaskExecutionInput,
  type AgentTaskExecutionResult,
  type AgentTaskExecutor,
  type RunStoreContract,
  summarizeUsageEvents,
  type UsageTotals,
} from "@generic-ai/sdk";

import { type AgentSessionFiles, createAgentSessionFiles } from "./agent-sessions.js";
import {
  CLAUDE_AGENT_SDK_ADAPTER,
  type ClaudeAgentSdkBackendOptions,
  createClaudeAgentSdkBackend,
} from "./claude-agent-sdk.js";
import { DEFAULT_TIER_MODELS } from "./company.js";
import {
  monitorCapabilities,
  type NoProgressOptions,
  runWithProgressCheck,
  type TurnProgressMonitor,
} from "./no-progress.js";

export const GENERIC_CORP_HARNESS_ID = "generic-corp";

export interface CompanyExecutorOptions {
  readonly runStore: RunStoreContract;
  /** Where each turn's artifacts are written. Kept outside agent workspaces. */
  readonly artifactsRoot: string;
  /**
   * Where agents' saved sessions are kept, one per agent per goal (decision 16). A turn interrupted
   * by a restart resumes from its last completed step (decision 30). Kept outside agent
   * workspaces. Without it, every turn starts a fresh conversation.
   */
  readonly sessionsRoot?: string;
  /** Native runtime options: model resolution, API key, thinking level, stream override. */
  readonly native?: NativeAgentHarnessOptions;
  /**
   * Tools for a turn. Defaults to file and terminal tools rooted at the agent's home; the app
   * server passes the full generic-work toolkit.
   */
  readonly capabilities?: (input: AgentTaskExecutionInput) => PiCapabilityBindings;
  /** Policy evaluator for effects (approvals plug in here). */
  readonly policy?: (input: AgentTaskExecutionInput) => AgentHarnessPolicyEvaluator | undefined;
  /**
   * Hard per-turn deadline. Off by default (decision 31): a turn runs as long as it keeps making
   * progress, which `noProgress` checks.
   */
  readonly turnTimeoutMs?: number;
  /** The no-progress check that stops a stalled or looping turn; `false` turns it off. */
  readonly noProgress?: NoProgressOptions | false;
  /** Harness config shared by every agent; each turn adds the agent's role and model. */
  readonly harness?: Partial<AgentHarnessConfig>;
  /** Secrets each agent may use as `{{secret:NAME}}`. */
  readonly secretGrants?: (agentId: string) => readonly string[] | undefined;
  /**
   * Token and dollar caps for a turn, read as it starts. The harness stops the turn with
   * `budget_exceeded` once its spend reaches them. The eval spend cap plugs in here.
   */
  readonly budget?: (input: AgentTaskExecutionInput) => AgentHarnessBudget | undefined;
  /** Called with what a turn spent once it ends, read from the run store. */
  readonly onTurnUsage?: (input: AgentTaskExecutionInput, totals: UsageTotals) => void;
  /**
   * Run Claude turns in the Claude Agent SDK on the owner's Claude plan (see claude-agent-sdk.ts).
   * When `active()` is true, every turn on an Anthropic model goes through the SDK; other models,
   * and every turn while it is false, use the native runtime with an API key.
   */
  readonly claudePlan?: ClaudeAgentSdkBackendOptions & { readonly active: () => boolean };
}

/** Whether a turn runs in the Claude Agent SDK: the plan is active and the model is Claude. */
export function runsOnClaudePlan(
  claudePlan: { readonly active: () => boolean } | undefined,
  model: string | undefined,
): boolean {
  return (
    claudePlan !== undefined &&
    claudePlan.active() &&
    (model === undefined || model.startsWith("anthropic/"))
  );
}

/** Default tools for an agent turn: its home directory's files and a shell there. */
export function defaultAgentCapabilities(input: AgentTaskExecutionInput): PiCapabilityBindings {
  const files = createWorkspaceFileTools({ root: input.workspaceRoot });
  const terminal = createTerminalToolPlugin({ root: input.workspaceRoot });
  return {
    fileTools: { piTools: files.piTools },
    terminalTools: { tool: terminal.tool },
  } as PiCapabilityBindings;
}

/**
 * Runs each agent turn on the native runtime (the D3 default: Anthropic
 * models chosen per role), persisting every harness run in the run store so
 * the dashboard can show traces and costs and goal validators can read them.
 */
export function createCompanyTaskExecutor(options: CompanyExecutorOptions): AgentTaskExecutor {
  const harness: AgentHarnessConfig = {
    id: GENERIC_CORP_HARNESS_ID,
    displayName: "Generic Corp",
    adapter: "native",
    model: DEFAULT_TIER_MODELS.ic,
    policyProfile: "local-dev-full",
    ...options.harness,
  };
  const sdkHarness: AgentHarnessConfig = { ...harness, adapter: CLAUDE_AGENT_SDK_ADAPTER };
  const backends =
    options.claudePlan === undefined ? [] : [createClaudeAgentSdkBackend(options.claudePlan)];
  const adapterFor = (config: AgentHarnessConfig) =>
    withRunPersistence(
      createAgentHarness(config, {
        ...(options.native === undefined ? {} : { native: options.native }),
        backends,
      }).adapter,
      options.runStore,
    );
  const baseCapabilities = options.capabilities ?? defaultAgentCapabilities;
  const monitors = new Map<string, TurnProgressMonitor>();
  const capabilities = (input: AgentTaskExecutionInput): PiCapabilityBindings => {
    const bindings = baseCapabilities(input);
    const monitor = monitors.get(input.attemptRunId);
    return monitor === undefined ? bindings : monitorCapabilities(bindings, monitor);
  };
  const sessions: AgentSessionFiles | undefined =
    options.sessionsRoot === undefined ? undefined : createAgentSessionFiles(options.sessionsRoot);
  const turnRunner = (config: AgentHarnessConfig) =>
    createAdapterTaskExecutor<PiCapabilityBindings, unknown>({
      adapter: adapterFor(config),
      harness: config,
      capabilities,
      ...(sessions === undefined ? {} : { session: (input) => sessions.begin(input) }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      role: (input) => {
        const secrets = options.secretGrants?.(input.agentId);
        return secrets === undefined ? undefined : { secrets };
      },
      context: (input) => {
        const policy = options.policy?.(input);
        const budget = options.budget?.(input);
        const context = createAgentHarnessRunContext({
          runId: input.attemptRunId,
          artifactDir: path.join(options.artifactsRoot, input.attemptRunId),
          actorId: input.agentId,
          ...(policy === undefined ? {} : { policy }),
        });
        return budget === undefined ? context : { ...context, budget };
      },
    });
  const nativeTurn = turnRunner(harness);
  const sdkTurn = options.claudePlan === undefined ? undefined : turnRunner(sdkHarness);
  const runTurn = async (input: AgentTaskExecutionInput): Promise<AgentTaskExecutionResult> =>
    sdkTurn !== undefined && runsOnClaudePlan(options.claudePlan, input.model ?? harness.model)
      ? sdkTurn(input)
      : nativeTurn(input);
  // A turn that throws (or a process that stops) leaves its session marked, so the next attempt
  // resumes; one that ends, fails for good, or stalled starts the next turn from a fresh prompt.
  const runAndSettle = async (
    input: AgentTaskExecutionInput,
    stalled: () => boolean,
  ): Promise<AgentTaskExecutionResult> => {
    const result = await runTurn(input);
    await sessions?.settle(
      input,
      result.status === "failed" && result.retryable !== false && !stalled(),
    );
    return result;
  };
  const noProgress = options.noProgress;
  const execute: AgentTaskExecutor =
    noProgress === false
      ? (input) => runAndSettle(input, () => false)
      : (input) =>
          runWithProgressCheck(input, noProgress ?? {}, async (monitored, monitor) => {
            monitors.set(monitored.attemptRunId, monitor);
            try {
              return await runAndSettle(monitored, () => monitor.reason !== undefined);
            } finally {
              monitors.delete(monitored.attemptRunId);
            }
          });
  const onTurnUsage = options.onTurnUsage;
  if (onTurnUsage === undefined) {
    return execute;
  }
  return async (input) => {
    const result = await execute(input);
    const runIds = result.runIds ?? [];
    const events = (
      await Promise.all(runIds.map((runId) => options.runStore.readEvents(runId)))
    ).flat();
    onTurnUsage(input, summarizeUsageEvents(events).totals);
    return result;
  };
}
