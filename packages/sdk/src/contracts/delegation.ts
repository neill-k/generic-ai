import type { ToolEffectJournal } from "../harness/effect-journal.js";
import type { AgentHarnessHostTool } from "../harness/host-tools.js";
import type { AgentHarnessSteering } from "../harness/types.js";
import type { RunActor } from "./identity.js";
import type { Awaitable, JsonValue } from "./shared.js";

export type DelegationTerminalStatus = "succeeded" | "failed" | "cancelled";

export interface DelegationErrorSnapshot {
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
}

export interface DelegationRequest<TTask = unknown> {
  readonly agentId: string;
  readonly task: TTask;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DelegationExecutorContext {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly rootSessionId: string;
}

export type DelegationExecutor<TTask, TResult> = (
  request: DelegationRequest<TTask>,
  context: DelegationExecutorContext,
) => Awaitable<TResult>;

export interface DelegationResult<TResult = unknown> {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly rootSessionId: string;
  readonly agentId: string;
  readonly status: DelegationTerminalStatus;
  readonly task: unknown;
  readonly result: TResult | undefined;
  readonly error: DelegationErrorSnapshot | undefined;
  readonly cancellationReason: string | undefined;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Durable delegation cascade: the runtime-neutral contract between the
 * cascade scheduler (which owns task records, the queue, and the org chart)
 * and whatever actually runs an agent turn (a single harness adapter run, a
 * or a test double).
 */
export interface AgentTaskExecutionInput {
  /** The durable task this turn works on. */
  readonly taskId: string;
  /** Unique id for this execution attempt; use it as the harness run id. */
  readonly attemptRunId: string;
  readonly rootTaskId: string;
  readonly parentTaskId?: string;
  readonly agentId: string;
  /** The agent's org-chart role, for example `ceo` or `vp-research`. */
  readonly role: string;
  /** Harness role kind that governs the agent's tool policy. */
  readonly roleKind?: string;
  readonly model?: string;
  readonly instructions?: string;
  /** Fully rendered prompt: identity, memory, task, goal, results, how to respond. */
  readonly prompt: string;
  /** The agent's persistent home: its memory file and workspace live here. */
  readonly workspaceRoot: string;
  /** Who started the work this turn belongs to (the owner, a service, ...). */
  readonly actor?: RunActor;
  /**
   * Journal of outward tool calls for this turn, shared by every attempt of it. Pass it to the
   * harness (`AgentHarnessRunInput.effectJournal`) so a retried attempt never repeats a send,
   * write or payment without detecting it.
   */
  readonly effectJournal?: ToolEffectJournal;
  /**
   * Tools the cascade offers for this turn (`delegate_task`, `submit_work`, ...). Pass them to the
   * harness as `AgentHarnessRunInput.hostTools`. Executors that cannot add tools can ignore them;
   * the prompt also describes the fenced-JSON fallback.
   */
  readonly tools?: readonly AgentHarnessHostTool[];
  /**
   * Messages for this turn that arrive while it runs, such as an owner message to a busy agent.
   * Pass it to the harness as `AgentHarnessRunInput.steering`.
   */
  readonly steering?: AgentHarnessSteering;
  /** True once the turn should stop after its current step. Pass it as `AgentHarnessRunInput.stopRequested`. */
  readonly stopRequested?: () => Promise<boolean> | boolean;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface AgentTaskExecutionResult {
  readonly status: "succeeded" | "failed";
  readonly outputText: string;
  readonly failureMessage?: string;
  /** `false` stops the queue from retrying a failed attempt. */
  readonly retryable?: boolean;
  /** Ids of harness runs this turn persisted, for linking task to run logs. */
  readonly runIds?: readonly string[];
  readonly costUsd?: number;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type AgentTaskExecutor = (
  input: AgentTaskExecutionInput,
) => Awaitable<AgentTaskExecutionResult>;
