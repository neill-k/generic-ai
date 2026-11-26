import type {
  JsonValue,
  RunStoreContract,
  SessionRecordStatus,
  ToolEffectGuardEvent,
  ToolEffectJournal,
  ToolEffectRecord,
} from "@generic-ai/sdk";

/**
 * A `ToolEffectJournal` kept in the run store (ADR 0059). Each outward tool call is one session
 * record under the task's run, so it survives a crash of the worker that made the call and is
 * visible to whichever worker picks the turn up next.
 */
export interface RunStoreToolEffectJournalOptions {
  /** The run the records belong to, for example the task id. */
  readonly runId: string;
  /** What the journal covers, for example `task-1:turn-3`. Every attempt of a turn shares it. */
  readonly scopeId: string;
  readonly agentId?: string;
  readonly onEvent?: (event: ToolEffectGuardEvent) => void | Promise<void>;
}

export function createRunStoreToolEffectJournal(
  store: RunStoreContract,
  options: RunStoreToolEffectJournalOptions,
): ToolEffectJournal {
  const sessionIdFor = (callKey: string) => `${options.scopeId}:effect:${callKey}`;
  return Object.freeze({
    scopeId: options.scopeId,
    async read(callKey: string): Promise<ToolEffectRecord | undefined> {
      const session = await store.getSession(sessionIdFor(callKey));
      return isToolEffectRecord(session?.state) ? session.state : undefined;
    },
    async write(record: ToolEffectRecord): Promise<void> {
      await store.saveSession({
        sessionId: sessionIdFor(record.callKey),
        runId: options.runId,
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        status: SESSION_STATUS[record.status],
        state: record as unknown as JsonValue,
        metadata: {
          kind: "tool-effect",
          scopeId: options.scopeId,
          toolName: record.toolName,
        },
      });
    },
    ...(options.onEvent === undefined
      ? {}
      : {
          async observe(event: ToolEffectGuardEvent): Promise<void> {
            await options.onEvent?.(event);
          },
        }),
  });
}

/** Every outward call recorded for a run, oldest first. */
export async function listToolEffectRecords(
  store: RunStoreContract,
  runId: string,
  scopeId?: string,
): Promise<ToolEffectRecord[]> {
  const sessions = await store.listSessions(runId);
  const records: ToolEffectRecord[] = [];
  for (const session of sessions) {
    if (session.metadata?.["kind"] !== "tool-effect") {
      continue;
    }
    if (scopeId !== undefined && session.metadata?.["scopeId"] !== scopeId) {
      continue;
    }
    if (isToolEffectRecord(session.state)) {
      records.push(session.state);
    }
  }
  return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

const SESSION_STATUS: Record<ToolEffectRecord["status"], SessionRecordStatus> = {
  started: "active",
  completed: "succeeded",
  failed: "failed",
};

function isToolEffectRecord(value: unknown): value is ToolEffectRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "tool-effect-record" &&
    typeof (value as { callKey?: unknown }).callKey === "string"
  );
}
