import type { JsonObject, JsonValue, RunEnvelope, RunRecord } from "@generic-ai/sdk";

/**
 * Durable agent tasks.
 *
 * A task is one unit of delegated work owned by one persistent agent. Tasks
 * are stored as runs in the SDK run store, so they get optimistic versioning,
 * listing, and an append-only event log for free, and they live next to the
 * harness runs that executed them.
 */
export type AgentTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export const TERMINAL_TASK_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

/**
 * What "done" means for a task. Roadmap R24 extends this with validators; the
 * cascade already carries it on every delegation and shows it to the agent.
 */
export interface AgentTaskGoal {
  readonly definitionOfDone?: string;
  readonly criteria?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface AgentTaskRecord {
  readonly taskId: string;
  readonly rootTaskId: string;
  readonly parentTaskId?: string;
  /** 0 for a task submitted by the owner, parent depth + 1 for delegated work. */
  readonly depth: number;
  readonly agentId: string;
  /** Agent that delegated this task, if any. */
  readonly delegatedBy?: string;
  readonly instruction: string;
  readonly goal?: AgentTaskGoal;
  readonly status: AgentTaskStatus;
  /**
   * Turn counter. Every time the task goes back to its agent (to resume
   * after delegated work, or to act on feedback) the round increases.
   */
  readonly round: number;
  /** Execution attempts across all rounds, including retries. */
  readonly attempts: number;
  readonly validationFailures: number;
  /** Every child task this task has delegated, in order. */
  readonly childTaskIds: readonly string[];
  /** Children from the latest delegation, whose results the next round sees. */
  readonly pendingChildTaskIds: readonly string[];
  /**
   * Owner approvals this task is waiting on. The task stays `waiting` until
   * every one is decided (approved, rejected, expired or cancelled); the next
   * round's prompt shows the decisions.
   */
  readonly pendingApprovalIds?: readonly string[];
  /** Every approval request this task has waited on, in order. */
  readonly approvalIds?: readonly string[];
  /** Feedback for the next round (validation failures, rejected delegations). */
  readonly feedback?: string;
  readonly outputText?: string;
  readonly failureMessage?: string;
  /** Harness runs that executed this task's turns. */
  readonly runIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly metadata?: JsonObject;
  /** Run-store record version, for optimistic concurrency. */
  readonly version: number;
}

export const AGENT_TASK_RUN_KIND = "agent-task";
export const DELEGATION_PLUGIN_ID = "@generic-ai/plugin-delegation";

export function taskScopeId(rootTaskId: string): string {
  return `task/${rootTaskId}`;
}

function envelopeStatus(status: AgentTaskStatus): RunEnvelope["status"] {
  switch (status) {
    case "queued":
      return "created";
    case "running":
    case "waiting":
      return "running";
    default:
      return status;
  }
}

type StoredTask = Omit<AgentTaskRecord, "version">;

export function taskToRun(task: StoredTask): {
  readonly envelope: RunEnvelope<string>;
  readonly metadata: Record<string, JsonValue>;
} {
  const envelope: RunEnvelope<string> = {
    kind: "run-envelope",
    runId: task.taskId,
    rootScopeId: taskScopeId(task.rootTaskId),
    rootAgentId: task.agentId,
    mode: "async",
    status: envelopeStatus(task.status),
    timestamps: {
      createdAt: task.createdAt,
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
      ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
      ...(task.status === "cancelled" && task.completedAt !== undefined
        ? { cancelledAt: task.completedAt }
        : {}),
    },
    eventStream: { kind: "event-stream-reference", streamId: task.taskId },
    ...(task.outputText === undefined
      ? {}
      : {
          outputPluginId: DELEGATION_PLUGIN_ID,
          output: {
            kind: "output-envelope",
            pluginId: DELEGATION_PLUGIN_ID,
            contentType: "text/plain",
            payload: task.outputText,
          },
        }),
  };
  return {
    envelope,
    metadata: {
      kind: AGENT_TASK_RUN_KIND,
      task: JSON.parse(JSON.stringify(task)) as JsonValue,
    },
  };
}

export function runToTask(record: RunRecord): AgentTaskRecord | undefined {
  if (record.metadata?.["kind"] !== AGENT_TASK_RUN_KIND) {
    return undefined;
  }
  const stored = record.metadata["task"];
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return undefined;
  }
  return { ...(stored as unknown as StoredTask), version: record.version };
}
