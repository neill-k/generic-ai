import type { Awaitable, JsonObject } from "../contracts/shared.js";
import type { OutputEnvelope, OutputPluginContract } from "../contracts/output.js";

export type RunEnvelopeMode = "sync" | "async";

export type RunEnvelopeStatus = "created" | "running" | "succeeded" | "failed" | "cancelled";

export type RunEnvelopeTerminalStatus = Exclude<RunEnvelopeStatus, "created" | "running">;

export interface RunEventStreamReference {
  readonly kind: "event-stream-reference";
  readonly streamId: string;
  readonly sequence?: number;
}

export interface RunEnvelopeTimestamps {
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly cancelledAt?: string;
}

export interface RunEnvelope<TOutput = unknown> {
  readonly kind: "run-envelope";
  readonly runId: string;
  readonly rootScopeId: string;
  readonly rootAgentId?: string;
  readonly mode: RunEnvelopeMode;
  readonly status: RunEnvelopeStatus;
  readonly timestamps: Readonly<RunEnvelopeTimestamps>;
  readonly eventStream?: RunEventStreamReference;
  readonly outputPluginId?: string;
  readonly output?: OutputEnvelope<TOutput>;
}

export interface RunEnvelopeInput<TOutput = unknown> {
  readonly runId: string;
  readonly rootScopeId: string;
  readonly rootAgentId?: string;
  readonly mode: RunEnvelopeMode;
  readonly status?: RunEnvelopeStatus;
  readonly timestamps?: Partial<RunEnvelopeTimestamps>;
  readonly eventStream?: RunEventStreamReference;
  readonly outputPluginId?: string;
  readonly output?: OutputEnvelope<TOutput>;
}

export interface RunEnvelopeFinalizationInput<TRun = unknown, TOutput = unknown> {
  readonly envelope: RunEnvelope;
  readonly outputPlugin: OutputPluginContract<TRun, TOutput>;
  readonly run: TRun;
  readonly context?: JsonObject;
  readonly status?: RunEnvelopeTerminalStatus;
  readonly completedAt?: string;
}

export interface RunEnvelopeFinalizer {
  finalize<TRun = unknown, TOutput = unknown>(
    input: RunEnvelopeFinalizationInput<TRun, TOutput>,
  ): Awaitable<RunEnvelope<TOutput>>;
}
