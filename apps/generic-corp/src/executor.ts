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
  type AgentTaskExecutor,
  type RunStoreContract,
  summarizeUsageEvents,
  type UsageTotals,
} from "@generic-ai/sdk";

import { DEFAULT_TIER_MODELS } from "./company.js";

export const GENERIC_CORP_HARNESS_ID = "generic-corp";

export interface CompanyExecutorOptions {
  readonly runStore: RunStoreContract;
  /** Where each turn's artifacts are written. Kept outside agent workspaces. */
  readonly artifactsRoot: string;
  /** Native runtime options: model resolution, API key, thinking level, stream override. */
  readonly native?: NativeAgentHarnessOptions;
  /**
   * Tools for a turn. Defaults to file and terminal tools rooted at the agent's home; the app
   * server passes the full generic-work toolkit.
   */
  readonly capabilities?: (input: AgentTaskExecutionInput) => PiCapabilityBindings;
  /** Policy evaluator for effects (approvals plug in here). */
  readonly policy?: (input: AgentTaskExecutionInput) => AgentHarnessPolicyEvaluator | undefined;
  /** Per-turn deadline. Defaults to 20 minutes. */
  readonly turnTimeoutMs?: number;
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
  const adapter = withRunPersistence(
    createAgentHarness(harness, {
      ...(options.native === undefined ? {} : { native: options.native }),
    }).adapter,
    options.runStore,
  );
  const capabilities = options.capabilities ?? defaultAgentCapabilities;
  const execute = createAdapterTaskExecutor<PiCapabilityBindings, unknown>({
    adapter,
    harness,
    capabilities,
    turnTimeoutMs: options.turnTimeoutMs ?? 20 * 60_000,
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
