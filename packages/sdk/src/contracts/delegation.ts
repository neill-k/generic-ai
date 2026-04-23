import type { Awaitable } from "./shared.js";

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
