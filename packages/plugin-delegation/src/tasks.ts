import type {
  GoalSpec,
  GoalValidationStatus,
  JsonObject,
  JsonValue,
  RunActor,
  RunEnvelope,
  RunRecord,
} from "@generic-ai/sdk";

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
  /**
   * A machine-checkable goal (roadmap R24). When present the task only
   * succeeds once its validators report `COMPLETE`; otherwise the agent gets
   * the validators' feedback and another turn. Stored on the task record,
   * which agents cannot write.
   */
  readonly spec?: GoalSpec;
  /** sha256 fingerprint of `spec`, set when the goal is sealed on submit or delegation. */
  readonly fingerprint?: string;
  readonly metadata?: JsonObject;
}

/** The latest goal validation of a task, kept for dashboards and audit. */
export interface AgentTaskGoalReport {
  readonly status: GoalValidationStatus;
  readonly goalId: string;
  readonly fingerprint: string;
  readonly required: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly feedback: string;
  readonly evaluatedAt: string;
  /**
   * How each check went, so the owner sees the definition of done as a live checklist. Rubric
   * checks list each criterion (the host's `definition-of-done` rubric has one per line).
   */
  readonly checks?: readonly AgentTaskGoalCheck[];
}

export interface AgentTaskGoalCheck {
  readonly validatorId: string;
  readonly kind: string;
  readonly required: boolean;
  readonly status: "passed" | "failed" | "error";
  readonly message: string;
  readonly criteria?: readonly {
    readonly criterionId: string;
    readonly passed: boolean;
    readonly score?: number;
  }[];
}

/** A file an agent handed in, as a path its file tools use (for Generic Corp, company-root relative). */
export interface AgentTaskDeliverable {
  readonly path: string;
  readonly title?: string;
}

/**
 * What an agent handed in with the `submit_work` tool (ADR 0069). Handing in is what finishes a
 * task; the reply text around it is not parsed for results.
 */
export interface AgentTaskHandIn {
  readonly summary: string;
  readonly deliverables: readonly AgentTaskDeliverable[];
  readonly round: number;
  readonly submittedAt: string;
}

/** A second reviewer's verdict on an agent's claim that its task is impossible. */
export interface AgentTaskImpossibilityReview {
  readonly impossible: boolean;
  readonly reasoning: string;
  /** Who reviewed, for example the model reference. */
  readonly reviewer?: string;
}

/** One `declare_impossible` claim and how the review went. */
export interface AgentTaskImpossibilityClaim {
  readonly reason: string;
  readonly round: number;
  readonly declaredAt: string;
  readonly review?: AgentTaskImpossibilityReview;
  /** Set when the review could not run, which never confirms the claim. */
  readonly reviewError?: string;
}

/** A question for the owner. It never blocks: the agent states its assumption and keeps going. */
export interface AgentTaskOwnerQuestion {
  readonly id: string;
  readonly agentId: string;
  readonly question: string;
  readonly assumption: string;
  readonly round: number;
  readonly askedAt: string;
  readonly answer?: string;
  readonly answeredAt?: string;
}

/** Something the agent is told at its next step: an owner edit to the goal, an answer, a note. */
export interface AgentTaskNotice {
  readonly id: string;
  readonly kind: "goal-changed" | "owner-answer" | "owner-note";
  readonly text: string;
  readonly createdAt: string;
  /** The round whose prompt first showed the notice. */
  readonly deliveredRound?: number;
}

/** One version of a task's goal, kept so the owner's edits are auditable. */
export interface AgentTaskGoalRevision {
  readonly revision: number;
  readonly fingerprint?: string;
  readonly objective?: string;
  readonly definitionOfDone: readonly string[];
  readonly changedAt: string;
  /** `agent` when the agent drafted it, `owner` for an owner edit, `submit` for the original. */
  readonly source: "submit" | "agent" | "owner";
  readonly changedBy?: string;
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
  /**
   * Who started the cascade this task belongs to. Delegated tasks inherit the
   * root task's actor, so every record in a cascade says who asked for it.
   */
  readonly actor?: RunActor;
  readonly instruction: string;
  readonly goal?: AgentTaskGoal;
  /**
   * `pending` while the agent still has to draft the task's goal with `set_goal` (the CEO does
   * this for every owner request); `set` once the host has sealed it. Absent when the goal came
   * with the task.
   */
  readonly goalDraft?: "pending" | "set";
  /** Goal version, starting at 1 and raised by every owner edit. */
  readonly goalRevision?: number;
  readonly goalHistory?: readonly AgentTaskGoalRevision[];
  /** The latest hand-in, accepted or not. */
  readonly handIn?: AgentTaskHandIn;
  /** Every claim that the task is impossible, in order. The last one decides a failed task. */
  readonly impossibilityClaims?: readonly AgentTaskImpossibilityClaim[];
  /** Set when a second reviewer confirmed the task is impossible in principle. */
  readonly impossible?: AgentTaskImpossibilityClaim;
  readonly ownerQuestions?: readonly AgentTaskOwnerQuestion[];
  readonly notices?: readonly AgentTaskNotice[];
  readonly status: AgentTaskStatus;
  /**
   * Turn counter. Every time the task goes back to its agent (to resume
   * after delegated work, or to act on feedback) the round increases.
   */
  readonly round: number;
  /** Execution attempts across all rounds, including retries. */
  readonly attempts: number;
  readonly validationFailures: number;
  readonly lastGoalReport?: AgentTaskGoalReport;
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
    ...(task.actor === undefined ? {} : { actor: task.actor }),
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
