import type {
  AgentHarnessAdapter,
  AgentHarnessRunResult,
  CanonicalEvent,
  JsonValue,
  RunEnvelope,
  RunStoreContract,
} from "@generic-ai/sdk";
import { isRunStoreError } from "@generic-ai/sdk";

/**
 * Persist every run an agent harness adapter performs (roadmap R8).
 *
 * The wrapper is runtime-neutral: it works for the Pi adapter, the native
 * adapter, or any other `AgentHarnessAdapter`. Before the run it records a
 * `running` envelope; afterwards it appends the run's canonical events to the
 * run's log, records one session per run with the adapter's opaque output,
 * and stores the final envelope. A failure to persist never hides the run's
 * own result: persistence errors go to `onError`.
 */
export interface RunPersistenceOptions {
  /** Extra metadata stored on each run record. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly onError?: (error: unknown, runId: string) => void;
  readonly now?: () => Date;
}

let runCounter = 0;

export function withRunPersistence<TCapabilities, TOutput>(
  adapter: AgentHarnessAdapter<TCapabilities, TOutput>,
  store: RunStoreContract,
  options: RunPersistenceOptions = {},
): AgentHarnessAdapter<TCapabilities, TOutput> {
  const now = options.now ?? (() => new Date());
  const report = (error: unknown, runId: string) => {
    if (options.onError !== undefined) {
      options.onError(error, runId);
      return;
    }
    throw error;
  };

  return {
    id: adapter.id,
    kind: adapter.kind,
    async run(input, context) {
      runCounter += 1;
      const runId = input.runId ?? `harness-run-${now().getTime()}-${runCounter}`;
      const startedAt = now().toISOString();
      const metadata: Record<string, JsonValue> = {
        kind: "agent-harness-run",
        harnessId: input.harness.id,
        adapter: adapter.kind,
        ...(input.rootAgentId === undefined ? {} : { agentId: input.rootAgentId }),
        ...(input.metadata === undefined ? {} : { input: input.metadata }),
        ...(options.metadata ?? {}),
      };
      const running: RunEnvelope = {
        kind: "run-envelope",
        runId,
        rootScopeId: input.rootScopeId ?? `harness/${input.harness.id}`,
        ...(input.rootAgentId === undefined ? {} : { rootAgentId: input.rootAgentId }),
        mode: "async",
        status: "running",
        timestamps: { createdAt: startedAt, startedAt },
        eventStream: { kind: "event-stream-reference", streamId: runId },
      };

      let version: number | undefined;
      try {
        const saved = await store.saveRun({ envelope: running, metadata });
        version = saved.version;
      } catch (error) {
        report(error, runId);
      }

      let result: AgentHarnessRunResult<TOutput>;
      try {
        result = await adapter.run({ ...input, runId }, context);
      } catch (error) {
        const completedAt = now().toISOString();
        try {
          await store.saveRun({
            envelope: {
              ...running,
              status: context.signal?.aborted === true ? "cancelled" : "failed",
              timestamps: { ...running.timestamps, completedAt },
            },
            metadata: { ...metadata, failureMessage: errorMessage(error) },
          });
        } catch (persistError) {
          report(persistError, runId);
        }
        throw error;
      }

      try {
        const events = normalizeRunEvents(runId, result.events);
        if (events.length > 0) {
          await store.appendEvents(runId, events);
        }
        await store.saveSession({
          sessionId: `${runId}:session`,
          runId,
          ...(input.rootAgentId === undefined ? {} : { agentId: input.rootAgentId }),
          status: result.status,
          state: toJson({
            outputText: result.outputText,
            output: result.output,
            artifacts: result.artifacts,
          }),
          metadata: {
            ...(result.errorCategory === undefined ? {} : { errorCategory: result.errorCategory }),
            ...(result.failureMessage === undefined
              ? {}
              : { failureMessage: result.failureMessage }),
          },
        });
        const completedAt = now().toISOString();
        await store.saveRun({
          envelope: {
            ...running,
            ...result.envelope,
            runId,
            status: result.envelope.status === "running" ? result.status : result.envelope.status,
            timestamps: {
              ...running.timestamps,
              ...result.envelope.timestamps,
              completedAt: result.envelope.timestamps.completedAt ?? completedAt,
            },
            eventStream: { kind: "event-stream-reference", streamId: runId },
          },
          metadata: {
            ...metadata,
            outputText: truncate(result.outputText, 16_000),
            ...(result.failureMessage === undefined
              ? {}
              : { failureMessage: result.failureMessage }),
            ...(result.errorCategory === undefined ? {} : { errorCategory: result.errorCategory }),
          },
          ...(version === undefined ? {} : { expectedVersion: version }),
        });
      } catch (error) {
        if (!isRunStoreError(error, "VERSION_CONFLICT")) {
          report(error, runId);
        }
      }
      return result;
    },
  };
}

/**
 * Rewrites a harness's canonical events into one ordered log for `runId`.
 * Events that already belong to the run keep their sequence when the
 * sequences are strictly increasing; otherwise the log is renumbered from 1.
 */
export function normalizeRunEvents(
  runId: string,
  events: readonly CanonicalEvent[],
): CanonicalEvent[] {
  const ordered =
    events.every((event) => event.runId === runId) &&
    events.every(
      (event, index) =>
        index === 0 || event.sequence > (events[index - 1] as CanonicalEvent).sequence,
    ) &&
    events.every((event) => Number.isInteger(event.sequence) && event.sequence > 0);
  if (ordered) {
    return [...events];
  }
  return events.map((event, index) => ({
    ...event,
    runId,
    sequence: index + 1,
    eventId: event.eventId.length > 0 ? event.eventId : `${runId}:event:${index + 1}`,
  }));
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
