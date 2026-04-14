import type {
  OutputEnvelope,
  RunEnvelope,
  RunEnvelopeFinalizationInput,
  RunEnvelopeInput,
  RunEnvelopeStatus,
  RunEnvelopeTimestamps,
} from "@generic-ai/sdk";

const createTimestamp = (): string => new Date().toISOString();

function freezeEventStreamReference(
  eventStream: NonNullable<RunEnvelopeInput["eventStream"]>,
): NonNullable<RunEnvelope["eventStream"]> {
  return Object.freeze({ ...eventStream });
}

function freezeOutputEnvelope<TOutput>(output: OutputEnvelope<TOutput>): OutputEnvelope<TOutput> {
  return Object.freeze({ ...output });
}

function freezeTimestamps(timestamps: RunEnvelopeTimestamps): Readonly<RunEnvelopeTimestamps> {
  return Object.freeze({ ...timestamps });
}

function freezeEnvelope<TOutput>(envelope: RunEnvelope<TOutput>): RunEnvelope<TOutput> {
  const frozenEnvelope: RunEnvelope<TOutput> = {
    ...envelope,
    timestamps: freezeTimestamps(envelope.timestamps),
    ...(envelope.eventStream === undefined
      ? {}
      : { eventStream: freezeEventStreamReference(envelope.eventStream) }),
    ...(envelope.output === undefined ? {} : { output: freezeOutputEnvelope(envelope.output) }),
  };

  return Object.freeze(frozenEnvelope);
}

export function createRunEnvelope<TOutput = unknown>(
  input: RunEnvelopeInput<TOutput>,
): RunEnvelope<TOutput> {
  const createdAt = input.timestamps?.createdAt ?? createTimestamp();

  return freezeEnvelope({
    kind: "run-envelope",
    runId: input.runId,
    rootScopeId: input.rootScopeId,
    ...(input.rootAgentId === undefined ? {} : { rootAgentId: input.rootAgentId }),
    mode: input.mode,
    status: input.status ?? "created",
    timestamps: freezeTimestamps({
      createdAt,
      ...(input.timestamps?.startedAt === undefined
        ? {}
        : { startedAt: input.timestamps.startedAt }),
      ...(input.timestamps?.completedAt === undefined
        ? {}
        : { completedAt: input.timestamps.completedAt }),
      ...(input.timestamps?.cancelledAt === undefined
        ? {}
        : { cancelledAt: input.timestamps.cancelledAt }),
    }),
    ...(input.eventStream === undefined ? {} : { eventStream: input.eventStream }),
    ...(input.outputPluginId === undefined ? {} : { outputPluginId: input.outputPluginId }),
    ...(input.output === undefined ? {} : { output: input.output }),
  });
}

export async function finalizeRunEnvelope<TRun, TOutput>(
  input: RunEnvelopeFinalizationInput<TRun, TOutput>,
): Promise<RunEnvelope<TOutput>> {
  const finalizeInput = {
    runId: input.envelope.runId,
    scopeId: input.envelope.rootScopeId,
    pluginId: input.outputPlugin.manifest.id,
    run: input.run,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
  const output = await input.outputPlugin.finalize(finalizeInput);

  const status: RunEnvelopeStatus = input.status ?? "succeeded";
  const timestamps: RunEnvelopeTimestamps = {
    ...input.envelope.timestamps,
    ...(status === "cancelled"
      ? {
          cancelledAt:
            input.completedAt ?? input.envelope.timestamps.cancelledAt ?? createTimestamp(),
        }
      : {
          completedAt:
            input.completedAt ?? input.envelope.timestamps.completedAt ?? createTimestamp(),
        }),
  };

  return createRunEnvelope({
    ...input.envelope,
    status,
    outputPluginId: input.outputPlugin.manifest.id,
    output,
    timestamps,
  });
}
