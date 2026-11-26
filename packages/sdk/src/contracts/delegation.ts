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
 * protocol topology, or a test double).
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
  /** Fully rendered prompt: identity, memory, task, goal, results, protocol. */
  readonly prompt: string;
  /** The agent's persistent home: its memory file and workspace live here. */
  readonly workspaceRoot: string;
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
