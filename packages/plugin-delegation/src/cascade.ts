import { randomUUID } from "node:crypto";

import type {
  AgentHarnessHostTool,
  AgentTaskExecutionResult,
  AgentTaskExecutor,
  ApprovalRequest,
  ApprovalServiceContract,
  Awaitable,
  CanonicalEvent,
  CanonicalEventName,
  DurableQueueContract,
  DurableQueueLease,
  JsonObject,
  JsonValue,
  QueueWorker,
  QueueWorkerJobContext,
  QueueWorkerOptions,
  RunActor,
  RunStoreContract,
  SealedGoal,
  ToolEffectRecord,
} from "@generic-ai/sdk";
import {
  canonicalJson,
  createQueueWorker,
  describeGoalForAgent,
  isRunStoreError,
  NonRetryableJobError,
  parseActorDirectives,
} from "@generic-ai/sdk";

import type { AgentDirectory, PersistentAgentRecord } from "./agents.js";
import { createRunStoreToolEffectJournal } from "./effect-journal.js";
import {
  applyGoalEdit,
  collectGoalEvidence,
  prepareTaskGoal,
  readDelegatedGoalSpec,
  readDraftedGoal,
  sealStoredGoal,
  summarizeGoalReport,
  type TaskGoalEdit,
  type TaskGoalOptions,
  validateTaskGoal,
} from "./goals.js";
import {
  type AgentTaskDeliverable,
  type AgentTaskGoal,
  type AgentTaskGoalRevision,
  type AgentTaskHandIn,
  type AgentTaskImpossibilityClaim,
  type AgentTaskImpossibilityReview,
  type AgentTaskNotice,
  type AgentTaskOwnerQuestion,
  type AgentTaskRecord,
  type AgentTaskStatus,
  DELEGATION_PLUGIN_ID,
  isTerminalTaskStatus,
  runToTask,
  taskScopeId,
  taskToRun,
} from "./tasks.js";

/**
 * Cross-run delegation cascade (roadmap R9).
 *
 * The owner submits a task to an agent (usually the CEO). Each agent turn
 * runs through an injected {@link AgentTaskExecutor}. A turn either finishes
 * the task or delegates work to other agents by ending with a `delegate_task`
 * directive. Delegated work becomes child tasks on the durable queue; the
 * parent releases its worker and waits in the store, not in memory. When the
 * last child settles, the parent is re-queued with its children's results.
 * Results bubble up the org chart until the root task settles.
 *
 * Everything is durable: tasks are run-store records with optimistic
 * versioning, turns are queue jobs with leases, retries, and one running turn
 * per agent (`concurrencyKey`), and every step is idempotent so a crash or
 * restart at any point resumes the cascade instead of losing or duplicating
 * work. Turns are at-least-once: a turn interrupted by a crash runs again.
 */

export const AGENT_TASK_JOB_NAME = "generic-ai.agent-task";

export interface AgentTaskJobPayload {
  readonly taskId: string;
  readonly round: number;
}

export interface AgentTaskJobResult {
  readonly taskId: string;
  readonly round: number;
  readonly outcome:
    | "finished"
    | "failed"
    | "delegated"
    | "awaiting_approval"
    | "requeued"
    | "skipped"
    | "cancelled";
}

export type DelegationScope = "direct-reports" | "subtree" | "any";

export interface DelegationDirective {
  readonly to: string;
  readonly task: string;
  readonly goal?: AgentTaskGoal;
}

export interface TaskValidationInput {
  readonly task: AgentTaskRecord;
  readonly agent: PersistentAgentRecord;
  readonly outputText: string;
  /** Harness runs that executed this turn; their event logs are the turn's trace. */
  readonly turnRunIds: readonly string[];
  /** What the agent handed in, when it used `submit_work`. */
  readonly handIn?: AgentTaskHandIn;
  readonly signal?: AbortSignal;
}

export interface TaskValidationResult {
  readonly passed: boolean;
  /** What to fix. Shown to the agent on its next attempt. */
  readonly feedback?: string;
}

/**
 * Extra gate on finishing a task, run after the task's goal validators (when
 * it has a goal spec) report `COMPLETE`.
 */
export type TaskValidator = (
  input: TaskValidationInput,
) => TaskValidationResult | Promise<TaskValidationResult>;

export type DelegationCascadeEvent =
  | { readonly type: "task.submitted"; readonly task: AgentTaskRecord }
  | { readonly type: "task.started"; readonly task: AgentTaskRecord }
  | {
      readonly type: "task.delegated";
      readonly task: AgentTaskRecord;
      readonly children: readonly AgentTaskRecord[];
    }
  | { readonly type: "task.requeued"; readonly task: AgentTaskRecord; readonly reason: string }
  | {
      readonly type: "task.awaiting_approval";
      readonly task: AgentTaskRecord;
      readonly approvals: readonly ApprovalRequest[];
    }
  | { readonly type: "task.resumed"; readonly task: AgentTaskRecord }
  | { readonly type: "task.succeeded"; readonly task: AgentTaskRecord }
  | { readonly type: "task.failed"; readonly task: AgentTaskRecord }
  | { readonly type: "task.cancelled"; readonly task: AgentTaskRecord }
  | {
      /** The goal was drafted by the agent or edited by the owner. */
      readonly type: "task.goal_changed";
      readonly task: AgentTaskRecord;
      readonly source: "agent" | "owner";
    }
  | {
      /** An agent wrote down a question for the owner and kept working on its assumption. */
      readonly type: "task.owner_question";
      readonly task: AgentTaskRecord;
      readonly question: AgentTaskOwnerQuestion;
    }
  | {
      readonly type: "task.impossibility_reviewed";
      readonly task: AgentTaskRecord;
      readonly claim: AgentTaskImpossibilityClaim;
    }
  | {
      /** A retried turn returned a recorded outward call's result instead of running it again. */
      readonly type: "tool.effect.replayed";
      readonly taskId: string;
      readonly record: ToolEffectRecord;
    }
  | {
      /** A retried turn refused to repeat an outward call whose outcome was never recorded. */
      readonly type: "tool.effect.uncertain";
      readonly taskId: string;
      readonly record: ToolEffectRecord;
    }
  | { readonly type: "error"; readonly error: unknown; readonly taskId?: string };

interface TurnCheckpoint {
  readonly outputText: string;
  readonly attemptRunId: string;
  readonly runIds: readonly string[];
  readonly directives?: JsonObject;
}

export const DELEGATE_TASK_TOOL_NAME = "delegate_task";
/** Hands in finished work (ADR 0069). Handing in, not the reply text, finishes a task. */
export const SUBMIT_WORK_TOOL_NAME = "submit_work";
/** Claims the task is impossible in principle; a second reviewer must agree (ADR 0069). */
export const DECLARE_IMPOSSIBLE_TOOL_NAME = "declare_impossible";
/** Drafts the task's goal before work starts; the host seals it against later agent edits. */
export const SET_GOAL_TOOL_NAME = "set_goal";
/** Writes a question down for the owner without waiting for the answer. */
export const ASK_OWNER_TOOL_NAME = "ask_owner";
/**
 * The fenced-JSON name `declare_impossible` replaced. Still read, with the same review.
 * @deprecated Use {@link DECLARE_IMPOSSIBLE_TOOL_NAME}.
 */
export const FINISH_TASK_TOOL_NAME = "finish_task";

/** Most deliverables one hand-in may list. */
const MAX_DELIVERABLES = 50;

const DELEGATE_TASK_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      description: "One entry per agent and task.",
      items: {
        type: "object",
        properties: {
          to: { type: "string", description: "Id of the agent to hand the work to." },
          task: { type: "string", description: "What to do and why." },
          definitionOfDone: {
            type: "string",
            description: "How they will know the task is done.",
          },
          goal: {
            type: "object",
            description:
              "Optional goal spec (objective, definitionOfDone, validators) checked automatically before the task can finish.",
          },
        },
        required: ["to", "task"],
      },
    },
  },
  required: ["tasks"],
};

const DECLARE_IMPOSSIBLE_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      description:
        "Why the task is impossible in principle, not merely hard or slow: the argument a skeptical reviewer would accept.",
    },
  },
  required: ["reason"],
};

const SUBMIT_WORK_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "The result for whoever assigned the task, in a few sentences.",
    },
    deliverables: {
      type: "array",
      description: "Files you made, as the paths your file tools use.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          title: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  required: ["summary"],
};

const SET_GOAL_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    title: { type: "string" },
    objective: { type: "string", description: "What the request is for, in one sentence." },
    definitionOfDone: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description: "Plain statements the owner would check the result against.",
    },
    validators: {
      type: "array",
      minItems: 1,
      description:
        "The checks that decide completion (goal validator specs: rubric, numeric on a host metric, trace, output_schema, check).",
      items: { type: "object" },
    },
  },
  required: ["objective", "definitionOfDone", "validators"],
};

const ASK_OWNER_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    question: { type: "string" },
    assumption: {
      type: "string",
      description: "What you will assume and act on until the owner answers.",
    },
  },
  required: ["question", "assumption"],
};

/** What a reviewer is shown when an agent says its task is impossible. */
export interface ImpossibilityReviewInput {
  readonly task: AgentTaskRecord;
  readonly agent: PersistentAgentRecord;
  readonly reason: string;
  /** The agent's reply in the turn it made the claim. */
  readonly outputText: string;
  readonly goal?: SealedGoal;
  readonly signal: AbortSignal;
}

/**
 * The second opinion an impossibility claim needs (decision 10). It should run on a different
 * model from the agent and confirm only what is impossible in principle: teleporting the earth to
 * the sun is; proving P != NP is not known to be.
 */
export type ImpossibilityReviewer = (
  input: ImpossibilityReviewInput,
) => Awaitable<AgentTaskImpossibilityReview>;

/** Session id of the saved answer for one round of a task. */
export function turnCheckpointSessionId(taskId: string, round: number): string {
  return `${taskId}:turn-${round}:outcome`;
}

export interface CreateDelegationCascadeOptions {
  readonly runStore: RunStoreContract;
  readonly queue: DurableQueueContract<AgentTaskJobPayload, AgentTaskJobResult>;
  readonly directory: AgentDirectory;
  readonly executor: AgentTaskExecutor;
  readonly validate?: TaskValidator;
  /**
   * How a task is finished. `tool` (the default): only a `submit_work` call hands work in, and a
   * turn that ends without one, a delegation or an impossibility claim goes back to the agent.
   * `reply`: a reply without a directive is the result, as before ADR 0069.
   */
  readonly handIn?: "tool" | "reply";
  /**
   * Checks a hand-in while the agent is still in its turn, for example that every deliverable
   * exists. Return a problem and the agent can fix it before the turn ends.
   */
  readonly checkHandIn?: (input: {
    readonly task: AgentTaskRecord;
    readonly agent: PersistentAgentRecord;
    readonly deliverables: readonly AgentTaskDeliverable[];
  }) => Awaitable<string | undefined>;
  /**
   * Reviews `declare_impossible` claims. Without one, no claim can be confirmed and the agent is
   * told to keep working.
   */
  readonly impossibility?: ImpossibilityReviewer;
  /**
   * Owner approvals (roadmap R11). When set, a turn that leaves approval
   * requests pending for its task (see `@generic-ai/plugin-approvals`) parks
   * the task as `waiting` without holding a worker, and the task resumes once
   * the owner has decided every request.
   */
  readonly approvals?: ApprovalServiceContract;
  /**
   * How often a started worker checks for decided approvals and expiries, for
   * decisions made by another process. Defaults to 5 seconds; 0 turns it off.
   */
  readonly approvalPollIntervalMs?: number;
  /**
   * Judges, checks, and extra evidence for goal validation. Tasks with a goal
   * spec are always gated on `COMPLETE`; without judges or checks, rubric and
   * check validators report errors and block completion.
   */
  readonly goals?: TaskGoalOptions;
  /** Who an agent may delegate to. Defaults to `direct-reports`. */
  readonly delegationScope?: DelegationScope;
  /** Deepest delegation allowed (root task is depth 0). Defaults to 6. */
  readonly maxDepth?: number;
  /**
   * Most turns a single task may take before it fails. Unlimited by default: a task keeps going
   * until it is done, declared impossible, cancelled, or stopped by a spending limit.
   */
  readonly maxRounds?: number;
  /** Most children one delegation may create. Defaults to 8. */
  readonly maxChildrenPerDelegation?: number;
  /**
   * Failed validations before a task fails. Unlimited by default: a result that does not pass
   * goes back to the agent with the feedback, as often as it takes. A goal spec's `maxAttempts`
   * is not a failure limit here; set this to bring one back.
   */
  readonly maxValidationAttempts?: number;
  /** Queue attempts per turn before the task fails. Defaults to the queue's default. */
  readonly maxAttemptsPerTurn?: number;
  /** Characters of the agent's memory file included in its prompt. Defaults to 8000. */
  readonly memoryPromptChars?: number;
  /** Characters of each child result included in the parent's prompt. Defaults to 8000. */
  readonly childResultPromptChars?: number;
  readonly jobName?: string;
  readonly worker?: Omit<
    QueueWorkerOptions<AgentTaskJobPayload, AgentTaskJobResult>,
    "names" | "onEvent"
  >;
  readonly onEvent?: (event: DelegationCascadeEvent) => void;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface SubmitAgentTaskInput {
  readonly agentId: string;
  readonly instruction: string;
  readonly goal?: AgentTaskGoal;
  /**
   * The agent drafts the goal itself with `set_goal` before any other work, and the host seals
   * it (decision 7). Ignored when `goal.spec` is given.
   */
  readonly draftGoal?: boolean;
  /** Stable id makes submission idempotent. Generated when omitted. */
  readonly taskId?: string;
  /** Who is asking, usually `toRunActor(authContext)`. Inherited by delegated work. */
  readonly actor?: RunActor;
  readonly metadata?: JsonObject;
}

export interface WaitForTaskOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface DrainOptions {
  /** Stop after this many jobs. Defaults to 1000. */
  readonly maxJobs?: number;
  readonly workerId?: string;
}

export interface DelegationCascade {
  readonly jobName: string;
  submit(input: SubmitAgentTaskInput): Promise<AgentTaskRecord>;
  get(taskId: string): Promise<AgentTaskRecord | undefined>;
  children(taskId: string): Promise<readonly AgentTaskRecord[]>;
  /** Every task in a cascade, ordered by creation. */
  tree(rootTaskId: string): Promise<readonly AgentTaskRecord[]>;
  /**
   * Resumes the task waiting on this approval if every approval it waits on
   * is decided. Call it after a decision for an immediate resume; started
   * workers also poll. Returns true when a turn was queued.
   */
  approvalDecided(approvalId: string): Promise<boolean>;
  /** Expires overdue approvals and resumes every task whose approvals are all decided. */
  resumeDecidedApprovals(): Promise<number>;
  /** Cancels a task and everything it delegated. */
  cancel(taskId: string, reason?: string): Promise<boolean>;
  /**
   * The owner changes a task's goal (decision 8). The goal is re-sealed under a new revision,
   * every unfinished task in the cascade is told at its next step, and the next hand-in is
   * checked against the new version. A root task that already succeeded is reopened.
   */
  updateGoal(
    taskId: string,
    edit: TaskGoalEdit,
    context?: { readonly changedBy?: string },
  ): Promise<AgentTaskRecord>;
  /** Tells an unfinished task something at its next step. Returns false for a settled task. */
  notify(taskId: string, text: string, kind?: AgentTaskNotice["kind"]): Promise<boolean>;
  /** Records the owner's answer to an agent's question and tells the agent at its next step. */
  answerQuestion(taskId: string, questionId: string, answer: string): Promise<AgentTaskRecord>;
  /** Resolves once the task settles. */
  wait(taskId: string, options?: WaitForTaskOptions): Promise<AgentTaskRecord>;
  /** Queue handler for one turn. Exposed for custom workers. */
  handle(
    job: DurableQueueLease<AgentTaskJobPayload>,
    context: Pick<QueueWorkerJobContext, "signal">,
  ): Promise<AgentTaskJobResult>;
  /**
   * Re-queues work that should be running: queued tasks without a live job
   * and waiting tasks whose children have all settled. Run it on startup.
   */
  recover(): Promise<number>;
  /** Processes available jobs in this process until none are left. For tests and scripts. */
  drain(options?: DrainOptions): Promise<number>;
  start(): QueueWorker;
  stop(): Promise<void>;
}

/** Fields to change. An explicit `undefined` clears an optional field. */
type TaskPatch = {
  readonly [K in keyof Omit<AgentTaskRecord, "version" | "taskId">]?:
    | Omit<AgentTaskRecord, "version" | "taskId">[K]
    | undefined;
};

class TaskSettledError extends Error {
  constructor(readonly task: AgentTaskRecord) {
    super(`Task ${task.taskId} is already ${task.status}.`);
    this.name = "TaskSettledError";
  }
}

const DEFAULTS = {
  maxDepth: 6,
  maxRounds: Number.POSITIVE_INFINITY,
  maxChildrenPerDelegation: 8,
  maxValidationAttempts: Number.POSITIVE_INFINITY,
  memoryPromptChars: 8_000,
  childResultPromptChars: 8_000,
};

export function createDelegationCascade(
  options: CreateDelegationCascadeOptions,
): DelegationCascade {
  const store = options.runStore;
  const queue = options.queue;
  const directory = options.directory;
  const jobName = options.jobName ?? AGENT_TASK_JOB_NAME;
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => randomUUID());
  const scope = options.delegationScope ?? "direct-reports";
  const handInMode = options.handIn ?? "tool";
  const limits = {
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
    maxRounds: options.maxRounds ?? DEFAULTS.maxRounds,
    maxChildren: options.maxChildrenPerDelegation ?? DEFAULTS.maxChildrenPerDelegation,
    maxValidationAttempts: options.maxValidationAttempts ?? DEFAULTS.maxValidationAttempts,
    memoryChars: options.memoryPromptChars ?? DEFAULTS.memoryPromptChars,
    childChars: options.childResultPromptChars ?? DEFAULTS.childResultPromptChars,
  };
  let worker: QueueWorker | undefined;
  let approvalTimer: ReturnType<typeof setInterval> | undefined;

  const emit = (event: DelegationCascadeEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observers must not break the cascade.
    }
  };

  // ---------------------------------------------------------------------------
  // Store helpers
  // ---------------------------------------------------------------------------

  async function load(taskId: string): Promise<AgentTaskRecord | undefined> {
    const record = await store.getRun(taskId);
    return record === undefined ? undefined : runToTask(record);
  }

  async function create(task: Omit<AgentTaskRecord, "version">): Promise<AgentTaskRecord> {
    const { envelope, metadata } = taskToRun(task);
    try {
      const saved = await store.saveRun({ envelope, metadata, expectedVersion: 0 });
      return { ...task, version: saved.version };
    } catch (error) {
      if (isRunStoreError(error, "VERSION_CONFLICT")) {
        // Created by an earlier attempt of the same step: reuse it.
        const existing = await load(task.taskId);
        if (existing !== undefined) {
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * Read-modify-write with optimistic concurrency. Throws `TaskSettledError`
   * when the task is already terminal unless `allowSettled` is set.
   */
  async function update(
    taskId: string,
    mutate: (task: AgentTaskRecord) => TaskPatch,
    updateOptions: { readonly allowSettled?: boolean } = {},
  ): Promise<AgentTaskRecord> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await load(taskId);
      if (current === undefined) {
        throw new NonRetryableJobError(`Unknown task "${taskId}".`);
      }
      if (isTerminalTaskStatus(current.status) && updateOptions.allowSettled !== true) {
        throw new TaskSettledError(current);
      }
      const { version, ...rest } = current;
      const merged: Record<string, unknown> = { ...rest, ...mutate(current) };
      for (const key of Object.keys(merged)) {
        if (merged[key] === undefined) {
          delete merged[key];
        }
      }
      const next = {
        ...(merged as Omit<AgentTaskRecord, "version">),
        updatedAt: now().toISOString(),
      };
      const { envelope, metadata } = taskToRun(next);
      try {
        const saved = await store.saveRun({ envelope, metadata, expectedVersion: version });
        return { ...next, version: saved.version };
      } catch (error) {
        if (!isRunStoreError(error, "VERSION_CONFLICT")) {
          throw error;
        }
      }
    }
    throw new Error(`Task ${taskId} kept changing under concurrent updates.`);
  }

  async function logEvent(
    task: Pick<AgentTaskRecord, "taskId" | "rootTaskId" | "parentTaskId" | "actor">,
    name: CanonicalEventName,
    data: Record<string, unknown>,
    sessionId = `${task.taskId}:task`,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sequence = (await store.lastSequence(task.taskId)) + 1;
      const event: CanonicalEvent = {
        eventId: `${task.taskId}:${sequence}:${createId()}`,
        sequence,
        occurredAt: now().toISOString(),
        name,
        origin: { namespace: "plugin", pluginId: DELEGATION_PLUGIN_ID, subsystem: "cascade" },
        scopeId: taskScopeId(task.rootTaskId),
        runId: task.taskId,
        rootSessionId: `${task.rootTaskId}:task`,
        sessionId,
        ...(task.parentTaskId === undefined
          ? {}
          : { parentSessionId: `${task.parentTaskId}:task` }),
        ...(task.actor === undefined ? {} : { actor: task.actor }),
        data,
      };
      try {
        await store.appendEvents(task.taskId, [event]);
        return;
      } catch (error) {
        if (!isRunStoreError(error, "SEQUENCE_CONFLICT")) {
          emit({ type: "error", error, taskId: task.taskId });
          return;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Queue helpers
  // ---------------------------------------------------------------------------

  function jobId(taskId: string, round: number): string {
    return `${jobName}:${taskId}:${round}`;
  }

  async function enqueueTurn(task: AgentTaskRecord): Promise<void> {
    await queue.enqueue({
      id: jobId(task.taskId, task.round),
      idempotencyKey: jobId(task.taskId, task.round),
      name: jobName,
      payload: { taskId: task.taskId, round: task.round },
      scopeId: taskScopeId(task.rootTaskId),
      concurrencyKey: `agent:${task.agentId}`,
      // Deeper work first, so a cascade finishes before new cascades fan out.
      priority: task.depth,
      ...(options.maxAttemptsPerTurn === undefined
        ? {}
        : { maxAttempts: options.maxAttemptsPerTurn }),
      metadata: { taskId: task.taskId, agentId: task.agentId, round: task.round },
    });
    worker?.wake();
  }

  async function childrenOf(task: AgentTaskRecord, ids = task.childTaskIds) {
    const children: AgentTaskRecord[] = [];
    for (const id of ids) {
      const child = await load(id);
      if (child !== undefined) {
        children.push(child);
      }
    }
    return children;
  }

  /** When a child settles, resume its parent once every sibling has settled. */
  async function notifyParent(child: AgentTaskRecord): Promise<void> {
    if (child.parentTaskId === undefined) {
      return;
    }
    const parent = await load(child.parentTaskId);
    if (parent === undefined) {
      return;
    }
    await logEvent(
      parent,
      child.status === "succeeded"
        ? "delegation.completed"
        : child.status === "cancelled"
          ? "delegation.cancelled"
          : "delegation.failed",
      {
        childTaskId: child.taskId,
        agentId: child.agentId,
        status: child.status,
        ...(child.failureMessage === undefined ? {} : { failureMessage: child.failureMessage }),
      },
    );
    await resumeIfReady(parent);
  }

  /** True while any approval the task waits on is still undecided. */
  async function awaitingApprovals(task: AgentTaskRecord): Promise<boolean> {
    const ids = task.pendingApprovalIds ?? [];
    if (ids.length === 0 || options.approvals === undefined) {
      return false;
    }
    for (const id of ids) {
      const approval = await options.approvals.get(id);
      if (approval?.status === "pending") {
        return true;
      }
    }
    return false;
  }

  async function resumeIfReady(parent: AgentTaskRecord): Promise<boolean> {
    if (parent.status !== "waiting") {
      return false;
    }
    if (await awaitingApprovals(parent)) {
      return false;
    }
    const pending = await childrenOf(parent, parent.pendingChildTaskIds);
    if (
      pending.length < parent.pendingChildTaskIds.length ||
      pending.some((candidate) => !isTerminalTaskStatus(candidate.status))
    ) {
      return false;
    }
    await enqueueTurn(parent);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Settling tasks
  // ---------------------------------------------------------------------------

  async function settle(
    taskId: string,
    status: "succeeded" | "failed" | "cancelled",
    fields: { readonly outputText?: string; readonly failureMessage?: string },
  ): Promise<AgentTaskRecord> {
    const timestamp = now().toISOString();
    const task = await update(taskId, () => ({
      status,
      completedAt: timestamp,
      pendingChildTaskIds: [],
      pendingApprovalIds: [],
      ...(fields.outputText === undefined ? {} : { outputText: fields.outputText }),
      ...(fields.failureMessage === undefined ? {} : { failureMessage: fields.failureMessage }),
    }));
    await logEvent(
      task,
      status === "succeeded"
        ? "run.completed"
        : status === "failed"
          ? "run.failed"
          : "run.cancelled",
      {
        status,
        ...(fields.failureMessage === undefined ? {} : { failureMessage: fields.failureMessage }),
      },
    );
    emit({
      type:
        status === "succeeded"
          ? "task.succeeded"
          : status === "failed"
            ? "task.failed"
            : "task.cancelled",
      task,
    });
    await notifyParent(task);
    return task;
  }

  async function requeue(taskId: string, feedback: string, extra: Partial<AgentTaskRecord> = {}) {
    const task = await update(taskId, (current) => ({
      status: "queued",
      round: current.round + 1,
      feedback,
      pendingApprovalIds: [],
      ...extra,
    }));
    emit({ type: "task.requeued", task, reason: feedback });
    if (task.round > limits.maxRounds) {
      await settle(task.taskId, "failed", {
        failureMessage: `Task took more than ${limits.maxRounds} turns. Last feedback: ${feedback}`,
      });
      return;
    }
    await enqueueTurn(task);
  }

  // ---------------------------------------------------------------------------
  // Delegation
  // ---------------------------------------------------------------------------

  async function canDelegate(
    from: PersistentAgentRecord,
    to: PersistentAgentRecord,
    task: AgentTaskRecord,
  ): Promise<string | undefined> {
    if (to.status !== "active") {
      return `Agent "${to.id}" is retired.`;
    }
    if (to.id === from.id) {
      return "You cannot delegate to yourself.";
    }
    // Never delegate back up the chain of the work itself: that would deadlock.
    let cursor: AgentTaskRecord | undefined = task;
    while (cursor?.parentTaskId !== undefined) {
      cursor = await load(cursor.parentTaskId);
      if (cursor?.agentId === to.id) {
        return `Agent "${to.id}" is already waiting on this work; delegating to it would deadlock.`;
      }
    }
    if (scope === "any") {
      return undefined;
    }
    if (scope === "direct-reports") {
      return to.reportsTo === from.id ? undefined : `Agent "${to.id}" does not report to you.`;
    }
    const chain = await directory.managementChain(to.id);
    return chain.some((manager) => manager.id === from.id)
      ? undefined
      : `Agent "${to.id}" is not in your part of the org chart.`;
  }

  async function delegate(
    task: AgentTaskRecord,
    agent: PersistentAgentRecord,
    directives: readonly DelegationDirective[],
  ): Promise<AgentTaskJobResult> {
    const problems: string[] = [];
    if (task.depth + 1 > limits.maxDepth) {
      problems.push(`Delegation is limited to ${limits.maxDepth} levels; do this task yourself.`);
    }
    if (directives.length > limits.maxChildren) {
      problems.push(`Delegate at most ${limits.maxChildren} tasks at once.`);
    }
    const targets: PersistentAgentRecord[] = [];
    for (const directive of directives) {
      const target = await directory.get(directive.to);
      if (target === undefined) {
        problems.push(`There is no agent "${directive.to}".`);
        continue;
      }
      const problem = await canDelegate(agent, target, task);
      if (problem !== undefined) {
        problems.push(problem);
      }
      targets.push(target);
    }
    if (problems.length > 0) {
      await logEvent(task, "delegation.rejected", { problems });
      await requeue(
        task.taskId,
        `Your delegation was rejected:\n- ${problems.join("\n- ")}\nFix it, or finish the task yourself.`,
      );
      return { taskId: task.taskId, round: task.round, outcome: "requeued" };
    }

    const timestamp = now().toISOString();
    const children: AgentTaskRecord[] = [];
    for (const [index, directive] of directives.entries()) {
      // Deterministic ids: replaying this step after a crash reuses the children.
      const childGoal = prepareTaskGoal(directive.goal);
      const child = await create({
        taskId: `${task.taskId}.${task.round}.${index + 1}`,
        rootTaskId: task.rootTaskId,
        parentTaskId: task.taskId,
        depth: task.depth + 1,
        agentId: directive.to,
        delegatedBy: agent.id,
        ...(task.actor === undefined ? {} : { actor: task.actor }),
        instruction: directive.task,
        ...(childGoal === undefined ? {} : { goal: childGoal }),
        status: "queued",
        round: 0,
        attempts: 0,
        validationFailures: 0,
        childTaskIds: [],
        pendingChildTaskIds: [],
        runIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      children.push(child);
    }
    const childIds = children.map((child) => child.taskId);
    const waiting = await update(task.taskId, (current) => ({
      status: "waiting",
      round: current.round + 1,
      childTaskIds: [...new Set([...current.childTaskIds, ...childIds])],
      pendingChildTaskIds: childIds,
      pendingApprovalIds: [],
    }));
    for (const child of children) {
      await logEvent(waiting, "delegation.requested", {
        childTaskId: child.taskId,
        agentId: child.agentId,
        task: child.instruction,
      });
      if (child.version === 1) {
        await logEvent(child, "run.created", {
          agentId: child.agentId,
          delegatedBy: agent.id,
          parentTaskId: task.taskId,
        });
      }
      if (!isTerminalTaskStatus(child.status)) {
        await enqueueTurn(child);
      }
    }
    emit({ type: "task.delegated", task: waiting, children });
    await resumeIfReady(waiting);
    return { taskId: task.taskId, round: task.round, outcome: "delegated" };
  }

  // ---------------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------------

  async function awaitApprovals(
    taskId: string,
    round: number,
    approvals: readonly ApprovalRequest[],
    outputText: string,
  ): Promise<AgentTaskJobResult> {
    const ids = approvals.map((approval) => approval.approvalId);
    const dropped = readDirectives(outputText).delegations.length > 0;
    const waiting = await update(taskId, (current) => ({
      status: "waiting",
      round: current.round + 1,
      pendingChildTaskIds: [],
      pendingApprovalIds: ids,
      approvalIds: [...new Set([...(current.approvalIds ?? []), ...ids])],
      ...(outputText.length === 0 ? {} : { outputText }),
      feedback: dropped
        ? "Your turn paused for the owner's approval, so the delegation in it was not sent. Delegate again if it is still needed."
        : undefined,
    }));
    for (const approval of approvals) {
      await logEvent(waiting, "approval.requested", {
        approvalId: approval.approvalId,
        action: approval.action.name,
        summary: approval.action.summary,
        effects: [...approval.action.effects],
        ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
      });
    }
    emit({ type: "task.awaiting_approval", task: waiting, approvals });
    // The owner may already have decided while the turn was finishing.
    await resumeIfReady(waiting);
    return { taskId, round, outcome: "awaiting_approval" };
  }

  async function resumeDecidedApprovals(): Promise<number> {
    if (options.approvals === undefined) {
      return 0;
    }
    await options.approvals.expireDue();
    let resumed = 0;
    let createdBefore: string | undefined;
    for (;;) {
      const page = await store.listRuns({
        status: "running",
        limit: 200,
        ...(createdBefore === undefined ? {} : { createdBefore }),
      });
      for (const record of page) {
        const task = runToTask(record);
        if (
          task?.status === "waiting" &&
          (task.pendingApprovalIds?.length ?? 0) > 0 &&
          (await queue.get(jobId(task.taskId, task.round))) === undefined &&
          (await resumeIfReady(task))
        ) {
          resumed += 1;
        }
      }
      if (page.length < 200) {
        return resumed;
      }
      createdBefore = page[page.length - 1]?.createdAt;
    }
  }

  // ---------------------------------------------------------------------------
  // Turn handler
  // ---------------------------------------------------------------------------

  async function handleTurn(
    job: DurableQueueLease<AgentTaskJobPayload>,
    signal: AbortSignal,
  ): Promise<AgentTaskJobResult> {
    const { taskId, round } = job.payload;
    const skipped = { taskId, round, outcome: "skipped" as const };
    const initial = await load(taskId);
    if (initial === undefined) {
      throw new NonRetryableJobError(`Unknown task "${taskId}".`);
    }
    if (isTerminalTaskStatus(initial.status) || initial.round !== round) {
      return skipped;
    }
    if (initial.status === "waiting") {
      const pending = await childrenOf(initial, initial.pendingChildTaskIds);
      if (pending.some((child) => !isTerminalTaskStatus(child.status))) {
        return skipped;
      }
      if (await awaitingApprovals(initial)) {
        return skipped;
      }
    }

    const agent = await directory.get(initial.agentId);
    if (agent === undefined || agent.status !== "active") {
      await settle(taskId, "failed", {
        failureMessage: `Agent "${initial.agentId}" is ${agent === undefined ? "unknown" : "retired"}.`,
      });
      return { taskId, round, outcome: "failed" };
    }
    await directory.ensureWorkspace(agent.id);

    const resuming = initial.status === "waiting";
    const turnScopeId = `${taskId}:turn-${round}`;
    const checkpoint = await readTurnCheckpoint(taskId, round);
    if (checkpoint !== undefined) {
      // The model already answered this round and its answer was saved, but the worker stopped
      // before acting on it. Act on the saved answer instead of running the model again.
      const task = await update(taskId, () => ({ status: "running" }));
      await logEvent(
        task,
        "session.completed",
        { round, fromCheckpoint: true, attemptRunId: checkpoint.attemptRunId },
        checkpoint.attemptRunId,
      );
      emit({ type: "task.resumed", task });
      return finishTurn(
        job,
        task,
        agent,
        round,
        checkpoint.attemptRunId,
        resuming,
        {
          status: "succeeded",
          outputText: checkpoint.outputText,
          ...(checkpoint.runIds.length === 0 ? {} : { runIds: checkpoint.runIds }),
        },
        signal,
        undefined,
        checkpoint.directives,
      );
    }

    const attemptNumber = initial.attempts + 1;
    const attemptRunId = `${turnScopeId}:attempt-${attemptNumber}`;
    const task = await update(taskId, (current) => ({
      status: "running",
      ...(current.notices === undefined ? {} : { notices: markDelivered(current.notices, round) }),
      attempts: current.attempts + 1,
      startedAt: current.startedAt ?? now().toISOString(),
      runIds: [...current.runIds, attemptRunId],
    }));
    await logEvent(
      task,
      "session.started",
      { round, attempt: attemptNumber, attemptRunId, resuming },
      attemptRunId,
    );
    emit({ type: resuming ? "task.resumed" : "task.started", task });

    const effectJournal = createRunStoreToolEffectJournal(store, {
      runId: taskId,
      scopeId: turnScopeId,
      agentId: agent.id,
      onEvent: async (event) => {
        if (event.type === "recorded") {
          return;
        }
        await logEvent(
          task,
          event.type === "replayed"
            ? "plugin.delegation.tool-effect-replayed"
            : "plugin.delegation.tool-effect-uncertain",
          {
            round,
            attempt: attemptNumber,
            toolName: event.record.toolName,
            callKey: event.record.callKey,
            recordedStatus: event.record.status,
            startedAt: event.record.startedAt,
          },
          attemptRunId,
        );
        emit({
          type: event.type === "replayed" ? "tool.effect.replayed" : "tool.effect.uncertain",
          taskId,
          record: event.record,
        });
      },
    });

    const prompt = await buildPrompt(task, agent);
    const turnTools = await createTurnTools(task, agent);
    let result: AgentTaskExecutionResult;
    try {
      result = await options.executor({
        taskId,
        attemptRunId,
        rootTaskId: task.rootTaskId,
        ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
        agentId: agent.id,
        role: agent.role,
        ...(agent.roleKind === undefined ? {} : { roleKind: agent.roleKind }),
        ...(agent.model === undefined ? {} : { model: agent.model }),
        ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
        prompt,
        workspaceRoot: agent.homePath,
        ...(task.actor === undefined ? {} : { actor: task.actor }),
        effectJournal,
        tools: turnTools.tools,
        signal,
        metadata: { round, attempt: attemptNumber, depth: task.depth },
      });
    } catch (error) {
      result = {
        status: "failed",
        outputText: "",
        failureMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const toolDirectives = turnTools.collected();
    if (result.status === "succeeded" && !signal.aborted) {
      // Save the answer before acting on it, so a crash from here on resumes from it.
      await saveTurnCheckpoint(taskId, agent.id, round, attemptRunId, result, toolDirectives);
    }
    return finishTurn(
      job,
      task,
      agent,
      round,
      attemptRunId,
      resuming,
      result,
      signal,
      attemptNumber,
      toolDirectives,
    );
  }

  async function finishTurn(
    job: DurableQueueLease<AgentTaskJobPayload>,
    task: AgentTaskRecord,
    agent: PersistentAgentRecord,
    round: number,
    attemptRunId: string,
    resuming: boolean,
    result: AgentTaskExecutionResult,
    signal: AbortSignal,
    attemptNumber?: number,
    toolDirectives?: JsonObject,
  ): Promise<AgentTaskJobResult> {
    const { taskId } = task;
    const afterTurn = await load(taskId);
    if (afterTurn === undefined || isTerminalTaskStatus(afterTurn.status)) {
      return { taskId, round, outcome: "cancelled" };
    }
    if (result.runIds !== undefined && result.runIds.length > 0) {
      await update(taskId, (current) => ({
        runIds: [...new Set([...current.runIds, ...(result.runIds ?? [])])],
      }));
    }
    if (attemptNumber !== undefined) {
      await logEvent(
        task,
        result.status === "succeeded" ? "session.completed" : "session.failed",
        {
          round,
          attempt: attemptNumber,
          ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
          ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
        },
        attemptRunId,
      );
    }

    if (signal.aborted) {
      throw new Error("Turn was interrupted before it finished.");
    }

    if (options.approvals !== undefined) {
      const awaiting = await options.approvals.list({ taskId, status: "pending" });
      if (awaiting.length > 0) {
        return awaitApprovals(taskId, round, awaiting, result.outputText);
      }
    }

    if (result.status === "failed") {
      const lastAttempt = result.retryable === false || job.attempts >= job.maxAttempts;
      if (!lastAttempt) {
        // Back to queued; the queue retries this same round after backoff.
        await update(taskId, () => ({
          status: resuming ? "waiting" : "queued",
          ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
        }));
        throw new Error(result.failureMessage ?? "Agent turn failed.");
      }
      await settle(taskId, "failed", {
        failureMessage: result.failureMessage ?? "Agent turn failed.",
        ...(result.outputText.length === 0 ? {} : { outputText: result.outputText }),
      });
      return { taskId, round, outcome: "failed" };
    }

    // Directives given through the turn tools win over a fenced-JSON reply.
    const directives =
      toolDirectives !== undefined && Object.keys(toolDirectives).length > 0
        ? readDirectiveData(toolDirectives)
        : readDirectives(result.outputText);
    if (directives.impossible !== undefined) {
      return reviewImpossibility(
        (await load(taskId)) as AgentTaskRecord,
        agent,
        round,
        directives.impossible,
        result.outputText,
        signal,
      );
    }
    if (directives.invalid !== undefined) {
      await requeue(taskId, directives.invalid);
      return { taskId, round, outcome: "requeued" };
    }
    const beforeHandIn = (await load(taskId)) as AgentTaskRecord;
    if (beforeHandIn.goalDraft === "pending") {
      await requeue(
        taskId,
        `No goal is set for this request yet. Call ${SET_GOAL_TOOL_NAME} with the objective, ` +
          "the definition of done and the checks before doing anything else.",
      );
      return { taskId, round, outcome: "requeued" };
    }
    if (directives.delegations.length > 0) {
      return delegate(beforeHandIn, agent, directives.delegations);
    }

    let handIn: AgentTaskHandIn | undefined;
    if (directives.handIn !== undefined) {
      handIn = { ...directives.handIn, round, submittedAt: now().toISOString() };
    } else if (handInMode === "reply") {
      handIn = undefined;
    } else {
      await requeue(
        taskId,
        `You ended your turn without handing anything in. When the work is done, call ` +
          `${SUBMIT_WORK_TOOL_NAME} with a summary and the paths of the files you made. If it is ` +
          "not done, keep working or delegate.",
        { outputText: result.outputText },
      );
      return { taskId, round, outcome: "requeued" };
    }
    const resultText = handIn === undefined ? result.outputText : renderHandIn(handIn);
    const current = await update(taskId, () => ({
      ...(handIn === undefined ? {} : { handIn }),
    }));

    const verdict = await validateTurn(
      current,
      agent,
      result.outputText,
      result.runIds !== undefined && result.runIds.length > 0 ? result.runIds : [attemptRunId],
      signal,
      handIn,
    );
    if (!verdict.passed) {
      const latest = (await load(taskId)) as AgentTaskRecord;
      const failures = latest.validationFailures + 1;
      const feedback = verdict.feedback ?? "The result did not pass validation.";
      const maxAttempts = limits.maxValidationAttempts;
      await logEvent(latest, "session.failed", {
        round,
        validation: "failed",
        feedback,
        ...(latest.lastGoalReport === undefined
          ? {}
          : { goalStatus: latest.lastGoalReport.status, goalId: latest.lastGoalReport.goalId }),
      });
      if (failures >= maxAttempts) {
        await settle(taskId, "failed", {
          outputText: resultText,
          failureMessage: `Result failed validation ${failures} times. Last feedback: ${feedback}`,
        });
        return { taskId, round, outcome: "failed" };
      }
      await requeue(taskId, `Your last result did not pass validation:\n${feedback}`, {
        validationFailures: failures,
        outputText: resultText,
      });
      return { taskId, round, outcome: "requeued" };
    }

    await settle(taskId, "succeeded", { outputText: resultText });
    return { taskId, round, outcome: "finished" };
  }

  /**
   * An agent says its task is impossible. A reviewer, ideally on another model, must agree that
   * it is impossible in principle (decision 10); otherwise the agent gets the task back with the
   * reviewer's reasoning. Every claim and verdict is written to the task record.
   */
  async function reviewImpossibility(
    task: AgentTaskRecord,
    agent: PersistentAgentRecord,
    round: number,
    reason: string,
    outputText: string,
    signal: AbortSignal,
  ): Promise<AgentTaskJobResult> {
    const { taskId } = task;
    let review: AgentTaskImpossibilityReview | undefined;
    let reviewError: string | undefined;
    if (options.impossibility === undefined) {
      reviewError = "No reviewer is configured to confirm impossibility claims.";
    } else {
      try {
        let goal: SealedGoal | undefined;
        try {
          goal = sealStoredGoal(task.goal);
        } catch {
          goal = undefined;
        }
        review = await options.impossibility({
          task,
          agent,
          reason,
          outputText,
          ...(goal === undefined ? {} : { goal }),
          signal,
        });
      } catch (error) {
        reviewError = error instanceof Error ? error.message : String(error);
      }
    }
    const claim: AgentTaskImpossibilityClaim = {
      reason,
      round,
      declaredAt: now().toISOString(),
      ...(review === undefined ? {} : { review }),
      ...(reviewError === undefined ? {} : { reviewError }),
    };
    const recorded = await update(taskId, (current) => ({
      impossibilityClaims: [...(current.impossibilityClaims ?? []), claim],
      ...(review?.impossible === true ? { impossible: claim } : {}),
    }));
    await logEvent(recorded, "plugin.delegation.impossibility.reviewed", {
      round,
      reason,
      confirmed: review?.impossible === true,
      ...(review === undefined
        ? {}
        : {
            reasoning: review.reasoning,
            ...(review.reviewer === undefined ? {} : { reviewer: review.reviewer }),
          }),
      ...(reviewError === undefined ? {} : { reviewError }),
    });
    emit({ type: "task.impossibility_reviewed", task: recorded, claim });
    if (review?.impossible === true) {
      await settle(taskId, "failed", {
        outputText,
        failureMessage:
          `Declared impossible: ${reason}\n` +
          `Confirmed by ${review.reviewer ?? "the reviewer"}: ${review.reasoning}`,
      });
      return { taskId, round, outcome: "failed" };
    }
    await requeue(
      taskId,
      review === undefined
        ? `Your claim that the task is impossible could not be reviewed (${reviewError}), so it ` +
            "is not accepted. Keep working toward the goal."
        : "A reviewer did not agree that the task is impossible in principle, so keep going. " +
            `Its reasoning: ${review.reasoning}`,
      { outputText },
    );
    return { taskId, round, outcome: "requeued" };
  }

  // ---------------------------------------------------------------------------
  // Turn tools
  // ---------------------------------------------------------------------------

  async function delegatableAgents(agent: PersistentAgentRecord): Promise<PersistentAgentRecord[]> {
    const candidates =
      scope === "direct-reports"
        ? await directory.directReports(agent.id)
        : (await directory.list()).filter((candidate) => candidate.id !== agent.id);
    return candidates.filter((candidate) => candidate.status === "active");
  }

  /**
   * The tools the cascade adds to one turn (ADR 0060, 0069): `delegate_task`, `submit_work`,
   * `declare_impossible`, `ask_owner`, and `set_goal` while the goal is still to be drafted. They
   * check what they can right away so the agent can fix a mistake in the same turn, and record
   * the rest; the cascade acts on what was recorded once the turn ends. `set_goal` and
   * `ask_owner` write to the task record at once: a sealed goal must not depend on how the turn
   * ends, and a question must reach the owner even if the turn fails.
   */
  async function createTurnTools(
    task: AgentTaskRecord,
    agent: PersistentAgentRecord,
  ): Promise<{ readonly tools: AgentHarnessHostTool[]; collected(): JsonObject }> {
    const delegations: JsonObject[] = [];
    let impossible: string | undefined;
    let handIn: JsonObject | undefined;
    let goalPending = task.goalDraft === "pending";
    const startingRevision = task.goalRevision;
    const tools: AgentHarnessHostTool[] = [];

    /** Why the agent cannot hand in, delegate or give up yet, or undefined. */
    const blocked = (action: string): string | undefined => {
      if (goalPending) {
        return `Set the goal with ${SET_GOAL_TOOL_NAME} before you ${action}.`;
      }
      if (impossible !== undefined) {
        return `You already declared this task impossible this turn; it cannot ${action} now.`;
      }
      if (handIn !== undefined) {
        return `You already handed in this turn; it cannot ${action} now.`;
      }
      return undefined;
    };

    /** Owner edits made while this turn ran, phrased for the agent. */
    const goalChangedNote = async (): Promise<string> => {
      const current = await load(task.taskId);
      if (current === undefined || current.goalRevision === startingRevision) {
        return "";
      }
      const fresh = (current.notices ?? []).filter(
        (notice) => notice.kind === "goal-changed" && notice.deliveredRound === undefined,
      );
      return fresh.length === 0
        ? ""
        : `\n\nWhile you worked: ${fresh.map((notice) => notice.text).join("\n")}`;
    };

    if (goalPending) {
      tools.push({
        name: SET_GOAL_TOOL_NAME,
        label: "Set Goal",
        description:
          "Set the goal for this request before doing any work: the objective, the definition " +
          "of done, and the checks that decide completion. Once set, only the owner can change it.",
        promptSnippet: "set_goal: draft this request's goal and checks before any other work",
        parameters: SET_GOAL_PARAMETERS,
        effects: ["handoff.write"],
        async execute(params) {
          if (!goalPending) {
            return {
              text: "The goal is already set and locked. Only the owner can change it.",
              isError: true,
            };
          }
          const goalId = task.goal?.spec?.id ?? task.rootTaskId;
          const draft = readDraftedGoal(params, goalId, (spec) =>
            options.goals?.draftPolicy?.(spec, { task, agent }),
          );
          if ("error" in draft) {
            return { text: `The goal was not set. ${draft.error}`, isError: true };
          }
          const prepared = prepareTaskGoal({ ...(task.goal ?? {}), spec: draft.spec });
          const sealed = sealStoredGoal(prepared) as SealedGoal;
          const timestamp = now().toISOString();
          const saved = await update(task.taskId, (current) => {
            if (current.goalDraft !== "pending") {
              throw new Error("The goal is already set and locked.");
            }
            return {
              ...(prepared === undefined ? {} : { goal: prepared }),
              goalDraft: "set",
              goalRevision: 1,
              goalHistory: [
                ...(current.goalHistory ?? []),
                goalRevisionEntry(sealed, 1, timestamp, "agent", agent.id),
              ],
            };
          });
          goalPending = false;
          await logEvent(saved, "plugin.delegation.goal.set", {
            goalId: sealed.spec.id,
            goalFingerprint: sealed.fingerprint,
            revision: 1,
            source: "agent",
            agentId: agent.id,
          });
          emit({ type: "task.goal_changed", task: saved, source: "agent" });
          return {
            text:
              "Goal set and locked. Now do the work, then hand it in with submit_work.\n\n" +
              describeGoalForAgent(sealed),
            details: { goalId: sealed.spec.id, fingerprint: sealed.fingerprint },
          };
        },
      });
    }

    const canHandOff = task.depth < limits.maxDepth && (await delegatableAgents(agent)).length > 0;
    if (canHandOff) {
      tools.push({
        name: DELEGATE_TASK_TOOL_NAME,
        label: "Delegate Task",
        description:
          "Hand work to other agents in your organization. Each entry becomes their own task; " +
          "you get a new turn with all of their results once every one of them finishes.",
        promptSnippet: "delegate_task: hand work to agents who report to you",
        promptGuidelines: [
          "Call delegate_task with every hand-off for this turn, then end your turn with a short note.",
          "Give each agent a concrete task and how they will know it is done.",
        ],
        parameters: DELEGATE_TASK_PARAMETERS,
        effects: ["handoff.write"],
        async execute(params) {
          const refusal = blocked("delegate");
          if (refusal !== undefined) {
            return { text: refusal, isError: true };
          }
          const entries = params["tasks"];
          if (!Array.isArray(entries) || entries.length === 0) {
            return { text: 'Pass "tasks": a non-empty list of { to, task }.', isError: true };
          }
          const parsed = parseDelegationEntries(entries);
          if (parsed.invalid !== undefined) {
            return { text: parsed.invalid, isError: true };
          }
          const problems: string[] = [];
          if (task.depth + 1 > limits.maxDepth) {
            problems.push(
              `Delegation is limited to ${limits.maxDepth} levels; do this task yourself.`,
            );
          }
          if (delegations.length + parsed.delegations.length > limits.maxChildren) {
            problems.push(`You can delegate at most ${limits.maxChildren} tasks at once.`);
          }
          for (const directive of parsed.delegations) {
            const target = await directory.get(directive.to);
            if (target === undefined) {
              problems.push(`There is no agent "${directive.to}".`);
              continue;
            }
            const problem = await canDelegate(agent, target, task);
            if (problem !== undefined) {
              problems.push(problem);
            }
          }
          if (problems.length > 0) {
            return {
              text: `Nothing was delegated:\n- ${problems.join("\n- ")}`,
              isError: true,
            };
          }
          delegations.push(...(entries as JsonObject[]));
          const names = parsed.delegations.map((directive) => `"${directive.to}"`).join(", ");
          return {
            text:
              `Recorded ${parsed.delegations.length === 1 ? "a task" : `${parsed.delegations.length} tasks`} for ${names}. ` +
              "They start when you end this turn. Add more with delegate_task, or end your turn " +
              "now; you will get a new turn with their results.",
            details: { delegated: parsed.delegations.map((directive) => directive.to) },
          };
        },
      });
    }

    tools.push({
      name: SUBMIT_WORK_TOOL_NAME,
      label: "Submit Work",
      description:
        "Hand in finished work: a short summary for whoever assigned the task and the paths of " +
        "the files you made. This is the only way to finish a task; it is then checked against " +
        "its goal, and you get another turn with the feedback if a check fails.",
      promptSnippet: "submit_work: hand in finished work with a summary and the files you made",
      parameters: SUBMIT_WORK_PARAMETERS,
      effects: ["handoff.write"],
      async execute(params) {
        const refusal = blocked("hand in");
        if (refusal !== undefined) {
          return { text: refusal, isError: true };
        }
        if (delegations.length > 0) {
          return {
            text: "You delegated work this turn; wait for the results before handing in.",
            isError: true,
          };
        }
        const parsed = parseHandIn(params);
        if ("error" in parsed) {
          return { text: parsed.error, isError: true };
        }
        const problem = await options.checkHandIn?.({
          task,
          agent,
          deliverables: parsed.deliverables,
        });
        if (problem !== undefined) {
          return { text: `Not handed in: ${problem}`, isError: true };
        }
        handIn = {
          summary: parsed.summary,
          deliverables: parsed.deliverables.map((deliverable) => ({ ...deliverable })),
        };
        return {
          text:
            "Handed in. End your turn now; the work will be checked against the goal." +
            (await goalChangedNote()),
        };
      },
    });

    tools.push({
      name: DECLARE_IMPOSSIBLE_TOOL_NAME,
      label: "Declare Impossible",
      description:
        "Claim the task is impossible in principle, not merely hard, slow or unfamiliar. A " +
        "second reviewer on a different model must agree; if it does not, you keep working " +
        "with its reasoning as feedback.",
      promptSnippet:
        "declare_impossible: claim the task cannot be done even in principle (a reviewer must agree)",
      parameters: DECLARE_IMPOSSIBLE_PARAMETERS,
      effects: ["handoff.write"],
      execute(params) {
        if (handIn !== undefined || delegations.length > 0) {
          return {
            text: "You already handed in or delegated this turn; finish that first.",
            isError: true,
          };
        }
        const reason = params["reason"];
        if (typeof reason !== "string" || reason.trim().length === 0) {
          return {
            text: 'Pass a "reason" saying why the task is impossible in principle.',
            isError: true,
          };
        }
        impossible = reason.trim();
        return {
          text:
            "Recorded. End your turn now. A reviewer will check the claim; if it disagrees, " +
            "you will get the task back with its reasoning.",
        };
      },
    });

    tools.push({
      name: ASK_OWNER_TOOL_NAME,
      label: "Ask Owner",
      description:
        "Write a question down for the owner when a wrong guess would waste real money or time. " +
        "It never pauses your work: state the assumption you will act on, then keep going.",
      promptSnippet: "ask_owner: note a question for the owner and the assumption you will act on",
      parameters: ASK_OWNER_PARAMETERS,
      effects: ["handoff.write"],
      async execute(params) {
        const question = params["question"];
        const assumption = params["assumption"];
        if (typeof question !== "string" || question.trim().length === 0) {
          return { text: 'Pass the "question".', isError: true };
        }
        if (typeof assumption !== "string" || assumption.trim().length === 0) {
          return {
            text: 'Pass the "assumption" you will act on until the owner answers.',
            isError: true,
          };
        }
        const entry: AgentTaskOwnerQuestion = {
          id: createId(),
          agentId: agent.id,
          question: question.trim(),
          assumption: assumption.trim(),
          round: task.round,
          askedAt: now().toISOString(),
        };
        const saved = await update(task.taskId, (current) => ({
          ownerQuestions: [...(current.ownerQuestions ?? []), entry],
        }));
        await logEvent(saved, "plugin.delegation.owner.question", {
          questionId: entry.id,
          agentId: agent.id,
          question: entry.question,
          assumption: entry.assumption,
        });
        emit({ type: "task.owner_question", task: saved, question: entry });
        return {
          text:
            "Noted for the owner. Do not wait for an answer: carry on as if your assumption is " +
            "right. If the owner answers, you will be told at your next step.",
          details: { questionId: entry.id },
        };
      },
    });

    return {
      tools,
      collected(): JsonObject {
        if (impossible !== undefined) {
          return { [DECLARE_IMPOSSIBLE_TOOL_NAME]: { reason: impossible } };
        }
        if (handIn !== undefined) {
          return { [SUBMIT_WORK_TOOL_NAME]: handIn };
        }
        return delegations.length === 0 ? {} : { delegate_task: [...delegations] };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Turn checkpoints
  // ---------------------------------------------------------------------------

  async function readTurnCheckpoint(
    taskId: string,
    round: number,
  ): Promise<TurnCheckpoint | undefined> {
    const session = await store.getSession(turnCheckpointSessionId(taskId, round));
    const state = session?.state as
      | {
          readonly outputText?: unknown;
          readonly attemptRunId?: unknown;
          readonly runIds?: unknown;
          readonly directives?: JsonValue;
        }
      | null
      | undefined;
    if (
      session?.status !== "succeeded" ||
      typeof state !== "object" ||
      state === null ||
      typeof state.outputText !== "string" ||
      typeof state.attemptRunId !== "string"
    ) {
      return undefined;
    }
    const runIds = Array.isArray(state.runIds) ? (state.runIds as unknown[]) : [];
    return {
      outputText: state.outputText,
      attemptRunId: state.attemptRunId,
      runIds: runIds.filter((value): value is string => typeof value === "string"),
      ...(isObject(state.directives) ? { directives: state.directives } : {}),
    };
  }

  async function saveTurnCheckpoint(
    taskId: string,
    agentId: string,
    round: number,
    attemptRunId: string,
    result: AgentTaskExecutionResult,
    directives: JsonObject,
  ): Promise<void> {
    try {
      await store.saveSession({
        sessionId: turnCheckpointSessionId(taskId, round),
        runId: taskId,
        agentId,
        status: "succeeded",
        state: {
          outputText: result.outputText,
          attemptRunId,
          runIds: [...(result.runIds ?? [])],
          ...(Object.keys(directives).length === 0 ? {} : { directives }),
        },
        metadata: { kind: "turn-checkpoint", round },
      });
    } catch (error) {
      // Without the checkpoint a crash re-runs the turn; the effect journal still guards it.
      emit({ type: "error", error, taskId });
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  async function validateTurn(
    task: AgentTaskRecord,
    agent: PersistentAgentRecord,
    outputText: string,
    turnRunIds: readonly string[],
    signal: AbortSignal,
    handIn?: AgentTaskHandIn,
  ): Promise<TaskValidationResult> {
    let sealed: ReturnType<typeof sealStoredGoal>;
    try {
      sealed = sealStoredGoal(task.goal);
    } catch (error) {
      // A tampered or unreadable goal can never be satisfied; fail closed.
      const feedback = error instanceof Error ? error.message : String(error);
      await logEvent(task, "plugin.delegation.goal.failed", {
        round: task.round,
        ...(task.goal?.spec?.id === undefined ? {} : { goalId: task.goal.spec.id }),
        ...(task.goal?.fingerprint === undefined ? {} : { goalFingerprint: task.goal.fingerprint }),
        status: "INCOMPLETE",
        complete: false,
        reason: "goal_integrity",
        feedback,
      });
      return { passed: false, feedback };
    }
    if (sealed !== undefined) {
      const evidence = await collectGoalEvidence(
        store,
        { task, agent, outputText, turnRunIds, ...(handIn === undefined ? {} : { handIn }) },
        options.goals?.evidence,
      );
      const judges = options.goals?.judgesFor?.({ task, agent }) ?? options.goals?.judges;
      const report = await validateTaskGoal(sealed, evidence, {
        ...(options.goals ?? {}),
        ...(judges === undefined ? {} : { judges }),
        signal,
        ...(task.goal?.fingerprint === undefined ? {} : { fingerprint: task.goal.fingerprint }),
      });
      const summary = summarizeGoalReport(report);
      await update(task.taskId, () => ({ lastGoalReport: summary }));
      // The in-run verdict, for goal evals (ADR 0058) to cross-check against a re-run.
      await logEvent(task, "plugin.delegation.goal.validated", {
        round: task.round,
        goalId: report.goalId,
        goalFingerprint: report.goalFingerprint,
        status: report.status,
        complete: report.complete,
        required: summary.required,
        passed: summary.passed,
        failed: summary.failed,
        errored: summary.errored,
        turnRunIds: [...turnRunIds],
        evaluatedAt: report.evaluatedAt,
      });
      if (!report.complete) {
        return { passed: false, feedback: report.feedback };
      }
    }
    if (options.validate !== undefined) {
      return options.validate({
        task,
        agent,
        outputText,
        turnRunIds,
        ...(handIn === undefined ? {} : { handIn }),
        signal,
      });
    }
    return { passed: true };
  }

  // ---------------------------------------------------------------------------
  // Prompt
  // ---------------------------------------------------------------------------

  /** What an agent drafting its task's goal is told: the rules and what the host can measure. */
  function goalDraftingInstructions(): string[] {
    const metrics = Object.entries(options.goals?.metrics ?? {});
    const checks = Object.keys(options.goals?.checks ?? {});
    return [
      `No goal is set for this request yet. Before any other work, call ${SET_GOAL_TOOL_NAME} ` +
        "with the objective, the definition of done and the checks that decide completion. The " +
        "host locks the goal once it is set; only the owner can change it afterwards.",
      "- Size the goal to the request. A small question gets a small goal: one line of " +
        'definition of done and one rubric check on your answer (target "output").',
      "- Write the definition of done as plain statements the owner would check the result against.",
      "- Prefer checks on the result itself: a rubric on the deliverable, a numeric check on a " +
        "number the host measures. Check what was achieved, never who did the work.",
      metrics.length === 0
        ? "- Numeric checks are not available: the host measures no numbers for this company."
        : "- Numeric checks must read one of these host-measured metrics " +
          '({"source": {"metric": "<name>"}}) or a path into the deliverable file ' +
          '({"source": {"outputPath": "<path>", "target": "artifact:deliverable"}}), never a ' +
          "number from your own reply:",
      ...metrics.map(([name, description]) => `  - ${name}: ${description}`),
      ...(checks.length === 0
        ? []
        : [
            `- Host checks you may name with {"kind": "check", "checkRef": "<name>"}: ${checks.join(", ")}.`,
          ]),
      `- Deliverables are files: a rubric on one targets "artifact:deliverable".`,
    ];
  }

  async function buildPrompt(task: AgentTaskRecord, agent: PersistentAgentRecord): Promise<string> {
    const [chain, reports, memory] = await Promise.all([
      directory.managementChain(agent.id),
      directory.directReports(agent.id),
      directory.readMemory(agent.id),
    ]);
    const delegatable =
      scope === "direct-reports"
        ? reports
        : (await directory.list()).filter((candidate) => candidate.id !== agent.id);
    const lines: string[] = [
      `You are ${agent.title ?? agent.role} (agent id "${agent.id}", role "${agent.role}").`,
    ];
    if (agent.instructions !== undefined) {
      lines.push("", agent.instructions);
    }
    lines.push("", "## Your place in the organization");
    const manager = chain[0];
    lines.push(
      manager === undefined
        ? "You report to the owner."
        : `You report to ${manager.title ?? manager.role} ("${manager.id}").`,
    );
    if (delegatable.length > 0) {
      lines.push(
        scope === "direct-reports" ? "Your direct reports:" : "Agents you can delegate to:",
      );
      for (const report of delegatable) {
        lines.push(`- "${report.id}": ${report.title ?? report.role}`);
      }
    } else {
      lines.push("You have nobody to delegate to; do the work yourself.");
    }

    lines.push(
      "",
      "## Your memory",
      `Your memory file is ${agent.memoryPath}. It persists across tasks; update it with decisions and lessons worth keeping.`,
      `Your workspace is ${agent.workspacePath}.`,
    );
    const trimmedMemory = memory.trim();
    if (trimmedMemory.length > 0) {
      lines.push("", "```markdown", clip(trimmedMemory, limits.memoryChars, true), "```");
    }

    lines.push("", `## Task ${task.taskId}`);
    if (task.delegatedBy !== undefined) {
      lines.push(`Assigned by "${task.delegatedBy}".`);
    }
    lines.push("", task.instruction);
    const sealedGoal = sealStoredGoal(task.goal);
    if (task.goalDraft === "pending") {
      lines.push("", "## Goal", ...goalDraftingInstructions());
    } else if (sealedGoal !== undefined) {
      lines.push(
        "",
        "## Goal",
        "This task is checked automatically. It is only accepted when every required check passes. " +
          "The goal is locked: only the owner can change it.",
        "",
        describeGoalForAgent(sealedGoal),
      );
    } else if (task.goal !== undefined) {
      lines.push("", "## Definition of done");
      if (task.goal.definitionOfDone !== undefined) {
        lines.push(task.goal.definitionOfDone);
      }
      for (const criterion of task.goal.criteria ?? []) {
        lines.push(`- ${criterion}`);
      }
    }

    const finished = await childrenOf(task, task.pendingChildTaskIds);
    if (finished.length > 0) {
      lines.push("", "## Results from the work you delegated");
      for (const child of finished) {
        lines.push(
          "",
          `### "${child.agentId}": ${child.status}`,
          `Task: ${clip(child.instruction, 500)}`,
        );
        if (child.outputText !== undefined && child.outputText.length > 0) {
          lines.push("", clip(child.outputText, limits.childChars));
        }
        if (child.status !== "succeeded" && child.failureMessage !== undefined) {
          lines.push("", `Failure: ${child.failureMessage}`);
        }
      }
    }
    const decided = await decidedApprovals(task);
    if (decided.length > 0) {
      lines.push("", "## The owner's decisions on actions you asked to take");
      for (const approval of decided) {
        lines.push("", `### ${approval.action.summary}`, describeDecision(approval));
      }
      if (task.feedback === undefined && task.outputText !== undefined && task.outputText !== "") {
        lines.push(
          "",
          "Your notes from the turn before the decision:",
          clip(task.outputText, limits.childChars),
        );
      }
    }
    const notices = (task.notices ?? []).filter(
      (notice) => notice.deliveredRound === undefined || notice.deliveredRound === task.round,
    );
    if (notices.length > 0) {
      lines.push("", "## New since your last step");
      for (const notice of notices) {
        lines.push(`- ${notice.text}`);
      }
    }
    const answered = (task.ownerQuestions ?? []).filter(
      (question) => question.answer !== undefined,
    );
    const open = (task.ownerQuestions ?? []).filter((question) => question.answer === undefined);
    if (answered.length > 0 || open.length > 0) {
      lines.push("", "## Your questions for the owner");
      for (const question of answered) {
        lines.push(`- Q: ${question.question}`, `  A: ${question.answer}`);
      }
      for (const question of open) {
        lines.push(
          `- Q: ${question.question} (no answer yet; keep acting on: ${question.assumption})`,
        );
      }
    }
    if (task.feedback !== undefined) {
      lines.push("", "## Feedback on your previous attempt", task.feedback);
      if (task.outputText !== undefined && task.outputText.length > 0) {
        lines.push("", "Your previous result:", clip(task.outputText, limits.childChars));
      }
    }

    lines.push("", "## How to respond");
    if (handInMode === "tool") {
      lines.push(
        `When the work is done, call ${SUBMIT_WORK_TOOL_NAME} with a short summary for whoever ` +
          "assigned it and the paths of the files you made. Only a hand-in finishes the task; " +
          "your reply text is not read as the result.",
        `If you have no ${SUBMIT_WORK_TOOL_NAME} tool, end your reply with one fenced JSON block:`,
        "```json",
        '{"submit_work": {"summary": "<the result>", "deliverables": [{"path": "<file>"}]}}',
        "```",
      );
    } else {
      lines.push("When the task is done, reply with the final result for whoever assigned it.");
    }
    if (delegatable.length > 0 && task.depth < limits.maxDepth) {
      lines.push(
        "To hand work to others instead, call the delegate_task tool with every hand-off, then end your turn.",
        "If you have no delegate_task tool, end your reply with one fenced JSON block like this:",
        "```json",
        '{"delegate_task": [{"to": "<agent id>", "task": "<what to do and why>", "definitionOfDone": "<how they know it is done>"}]}',
        "```",
        "You will get a new turn with their results once all of them finish; then finish the task or delegate again.",
        'To have their result checked automatically, add a "goal" goal spec (objective, definitionOfDone, validators) to an entry.',
      );
    }
    lines.push(
      "Keep going until the goal is met. Hard, slow or unfamiliar is not impossible.",
      `Only if the task is impossible in principle, call ${DECLARE_IMPOSSIBLE_TOOL_NAME} with ` +
        "the argument. A reviewer on a different model must agree, or you keep going.",
      `If a wrong guess would waste real money or time, call ${ASK_OWNER_TOOL_NAME} with the ` +
        "question and the assumption you will act on, then carry on. Never stop to wait for an answer.",
    );
    return lines.join("\n");
  }

  async function decidedApprovals(task: AgentTaskRecord): Promise<readonly ApprovalRequest[]> {
    if (options.approvals === undefined) {
      return [];
    }
    const decided: ApprovalRequest[] = [];
    for (const id of task.pendingApprovalIds ?? []) {
      const approval = await options.approvals.get(id);
      if (approval !== undefined && approval.status !== "pending") {
        decided.push(approval);
      }
    }
    return decided;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const cascade: DelegationCascade = {
    jobName,
    async submit(input) {
      const agent = await directory.require(input.agentId);
      if (agent.status !== "active") {
        throw new Error(`Agent "${agent.id}" is retired.`);
      }
      const taskId = input.taskId ?? createId();
      const timestamp = now().toISOString();
      // Seal the goal up front: an invalid spec is the caller's error.
      const goal = prepareTaskGoal(input.goal);
      const task = await create({
        taskId,
        rootTaskId: taskId,
        depth: 0,
        agentId: agent.id,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        instruction: input.instruction,
        ...(goal === undefined ? {} : { goal }),
        ...(goal?.spec === undefined && input.draftGoal === true
          ? { goalDraft: "pending" as const }
          : {}),
        ...(goal?.spec === undefined
          ? {}
          : {
              goalRevision: 1,
              goalHistory: [
                goalRevisionEntry(sealStoredGoal(goal) as SealedGoal, 1, timestamp, "submit"),
              ],
            }),
        status: "queued",
        round: 0,
        attempts: 0,
        validationFailures: 0,
        childTaskIds: [],
        pendingChildTaskIds: [],
        runIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      if (task.version === 1) {
        await logEvent(task, "run.created", { agentId: agent.id, instruction: input.instruction });
        emit({ type: "task.submitted", task });
      }
      if (task.status === "queued") {
        await enqueueTurn(task);
      }
      return task;
    },
    get: load,
    async children(taskId) {
      const task = await load(taskId);
      return task === undefined ? [] : childrenOf(task);
    },
    async tree(rootTaskId) {
      const tasks: AgentTaskRecord[] = [];
      let createdBefore: string | undefined;
      for (;;) {
        const page = await store.listRuns({
          rootScopeId: taskScopeId(rootTaskId),
          limit: 200,
          ...(createdBefore === undefined ? {} : { createdBefore }),
        });
        for (const record of page) {
          const task = runToTask(record);
          if (task !== undefined) {
            tasks.push(task);
          }
        }
        if (page.length < 200) {
          break;
        }
        createdBefore = page[page.length - 1]?.createdAt;
      }
      return tasks.sort(
        (left, right) =>
          left.depth - right.depth ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.taskId.localeCompare(right.taskId),
      );
    },
    async approvalDecided(approvalId) {
      const approval = await options.approvals?.get(approvalId);
      const taskId = approval?.requester.taskId;
      if (taskId === undefined) {
        return false;
      }
      const task = await load(taskId);
      if (task === undefined || !(task.pendingApprovalIds ?? []).includes(approvalId)) {
        return false;
      }
      return resumeIfReady(task);
    },
    resumeDecidedApprovals,
    async updateGoal(taskId, edit, context = {}) {
      const task = await load(taskId);
      if (task === undefined) {
        throw new Error(`Unknown task "${taskId}".`);
      }
      const reopen = task.status === "succeeded" && task.parentTaskId === undefined;
      if (isTerminalTaskStatus(task.status) && !reopen) {
        throw new Error(`Task ${taskId} is ${task.status}; its goal can no longer change.`);
      }
      const previous = sealStoredGoal(task.goal);
      const spec = applyGoalEdit(
        previous?.spec,
        edit,
        task.rootTaskId === task.taskId ? task.taskId : `${task.rootTaskId}:${task.taskId}`,
        task.instruction,
      );
      const goal = prepareTaskGoal({
        ...(task.goal ?? {}),
        spec,
        definitionOfDone: spec.definitionOfDone.join("\n"),
      }) as AgentTaskGoal;
      const sealed = sealStoredGoal(goal) as SealedGoal;
      if (previous !== undefined && previous.fingerprint === sealed.fingerprint) {
        return task;
      }
      const timestamp = now().toISOString();
      const revision = (task.goalRevision ?? (previous === undefined ? 0 : 1)) + 1;
      const text =
        `The owner changed the definition of done (revision ${revision}). From now on your ` +
        `work is checked against:\n${spec.definitionOfDone.map((line) => `  - ${line}`).join("\n")}`;
      const notice = (): AgentTaskNotice => ({
        id: createId(),
        kind: "goal-changed",
        text,
        createdAt: timestamp,
      });
      const updated = await update(
        taskId,
        (current) => ({
          goal,
          // An owner's goal replaces a draft the agent has not written yet.
          ...(current.goalDraft === "pending" ? { goalDraft: "set" as const } : {}),
          goalRevision: revision,
          goalHistory: [
            ...(current.goalHistory ?? []),
            goalRevisionEntry(sealed, revision, timestamp, "owner", context.changedBy),
          ],
          ...(reopen
            ? {
                status: "queued" as const,
                round: current.round + 1,
                completedAt: undefined,
                validationFailures: 0,
                feedback:
                  "The owner changed the definition of done after you handed in. Check the work " +
                  "against the new version and hand it in again.",
              }
            : { notices: [...(current.notices ?? []), notice()] }),
        }),
        { allowSettled: reopen },
      );
      await logEvent(updated, "plugin.delegation.goal.changed", {
        goalId: sealed.spec.id,
        goalFingerprint: sealed.fingerprint,
        ...(previous === undefined ? {} : { previousFingerprint: previous.fingerprint }),
        revision,
        source: "owner",
        reopened: reopen,
        ...(context.changedBy === undefined ? {} : { changedBy: context.changedBy }),
      });
      emit({ type: "task.goal_changed", task: updated, source: "owner" });
      // Everyone else working under this goal hears about it at their next step.
      for (const other of await cascade.tree(task.rootTaskId)) {
        if (other.taskId !== taskId && !isTerminalTaskStatus(other.status)) {
          await cascade.notify(other.taskId, text, "goal-changed");
        }
      }
      if (reopen) {
        await logEvent(updated, "run.started", { reopened: true, revision });
        await enqueueTurn(updated);
      }
      return updated;
    },
    async notify(taskId, text, kind = "owner-note") {
      try {
        await update(taskId, (current) => ({
          notices: [
            ...(current.notices ?? []),
            { id: createId(), kind, text, createdAt: now().toISOString() },
          ],
        }));
        return true;
      } catch (error) {
        if (error instanceof TaskSettledError) {
          return false;
        }
        throw error;
      }
    },
    async answerQuestion(taskId, questionId, answer) {
      const trimmed = answer.trim();
      if (trimmed.length === 0) {
        throw new Error("The answer is empty.");
      }
      const task = await load(taskId);
      const question = task?.ownerQuestions?.find((candidate) => candidate.id === questionId);
      if (task === undefined || question === undefined) {
        throw new Error(`Task ${taskId} has no question "${questionId}".`);
      }
      const timestamp = now().toISOString();
      const settled = isTerminalTaskStatus(task.status);
      const updated = await update(
        taskId,
        (current) => ({
          ownerQuestions: (current.ownerQuestions ?? []).map((candidate) =>
            candidate.id === questionId
              ? { ...candidate, answer: trimmed, answeredAt: timestamp }
              : candidate,
          ),
          ...(settled
            ? {}
            : {
                notices: [
                  ...(current.notices ?? []),
                  {
                    id: createId(),
                    kind: "owner-answer" as const,
                    text: `The owner answered "${question.question}": ${trimmed}`,
                    createdAt: timestamp,
                  },
                ],
              }),
        }),
        { allowSettled: true },
      );
      await logEvent(updated, "plugin.delegation.owner.answer", { questionId, answer: trimmed });
      return updated;
    },
    async cancel(taskId, reason = "Cancelled by the owner.") {
      const task = await load(taskId);
      if (task === undefined || isTerminalTaskStatus(task.status)) {
        return false;
      }
      try {
        await settle(taskId, "cancelled", { failureMessage: reason });
      } catch (error) {
        if (error instanceof TaskSettledError) {
          return false;
        }
        throw error;
      }
      await queue.cancel(jobId(task.taskId, task.round));
      if (options.approvals !== undefined) {
        for (const approval of await options.approvals.list({ taskId, status: "pending" })) {
          await options.approvals.cancel(approval.approvalId, `Task ${taskId} was cancelled.`);
        }
      }
      for (const childId of task.childTaskIds) {
        await cascade.cancel(childId, `Parent task ${taskId} was cancelled.`);
      }
      return true;
    },
    async wait(taskId, waitOptions = {}) {
      const started = Date.now();
      const pollMs = waitOptions.pollIntervalMs ?? 250;
      for (;;) {
        const task = await load(taskId);
        if (task === undefined) {
          throw new Error(`Unknown task "${taskId}".`);
        }
        if (isTerminalTaskStatus(task.status)) {
          return task;
        }
        if (waitOptions.signal?.aborted) {
          throw new Error(`Stopped waiting for task ${taskId}.`);
        }
        if (waitOptions.timeoutMs !== undefined && Date.now() - started >= waitOptions.timeoutMs) {
          throw new Error(`Task ${taskId} did not finish within ${waitOptions.timeoutMs}ms.`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
    async handle(job, context) {
      try {
        return await handleTurn(job, context.signal);
      } catch (error) {
        if (error instanceof TaskSettledError) {
          return { taskId: job.payload.taskId, round: job.payload.round, outcome: "cancelled" };
        }
        if (job.attempts >= job.maxAttempts && !(error instanceof NonRetryableJobError)) {
          // Out of attempts: fail the task so the cascade can move on.
          try {
            await settle(job.payload.taskId, "failed", {
              failureMessage: error instanceof Error ? error.message : String(error),
            });
          } catch (settleError) {
            if (!(settleError instanceof TaskSettledError)) {
              emit({ type: "error", error: settleError, taskId: job.payload.taskId });
            }
          }
        }
        emit({ type: "error", error, taskId: job.payload.taskId });
        throw error;
      }
    },
    async recover() {
      let requeued = 0;
      for (const status of ["created", "running"] as const) {
        let createdBefore: string | undefined;
        for (;;) {
          const page = await store.listRuns({
            status,
            limit: 200,
            ...(createdBefore === undefined ? {} : { createdBefore }),
          });
          for (const record of page) {
            const task = runToTask(record);
            if (task === undefined) {
              continue;
            }
            if (task.status === "waiting") {
              if (await resumeIfReady(task)) {
                requeued += 1;
              }
              continue;
            }
            const job = await queue.get(jobId(task.taskId, task.round));
            if (job === undefined) {
              await enqueueTurn(task);
              requeued += 1;
            } else if (job.state === "failed" || job.state === "cancelled") {
              await queue.retry(job.id);
              requeued += 1;
            } else if (job.state === "succeeded") {
              // The turn's job finished without moving the task on (for example a
              // crash between the two writes). Give the task a fresh turn.
              await requeue(task.taskId, "Your previous turn was interrupted. Continue the task.");
              requeued += 1;
            }
          }
          if (page.length < 200) {
            break;
          }
          createdBefore = page[page.length - 1]?.createdAt;
        }
      }
      return requeued;
    },
    async drain(drainOptions = {}) {
      const maxJobs = drainOptions.maxJobs ?? 1_000;
      const workerId = drainOptions.workerId ?? "drain";
      let processed = 0;
      while (processed < maxJobs) {
        const lease = await queue.lease({ names: [jobName], workerId });
        if (lease === undefined) {
          break;
        }
        processed += 1;
        const controller = new AbortController();
        try {
          const result = await cascade.handle(lease, { signal: controller.signal });
          await queue.ack(lease.leaseId, result);
        } catch (error) {
          await queue.nack(lease.leaseId, {
            reason: error instanceof Error ? error.message : String(error),
            retryable: !(error instanceof NonRetryableJobError),
          });
        }
      }
      return processed;
    },
    start() {
      if (worker === undefined) {
        worker = createQueueWorker(queue, (job, context) => cascade.handle(job, context), {
          ...(options.worker ?? {}),
          names: [jobName],
          onEvent: (event) => {
            if (event.type === "error") {
              emit({ type: "error", error: event.error });
            }
          },
        });
      }
      worker.start();
      const pollMs = options.approvalPollIntervalMs ?? 5_000;
      if (options.approvals !== undefined && pollMs > 0 && approvalTimer === undefined) {
        approvalTimer = setInterval(() => {
          resumeDecidedApprovals().catch((error: unknown) => emit({ type: "error", error }));
        }, pollMs);
        approvalTimer.unref?.();
      }
      return worker;
    },
    async stop() {
      if (approvalTimer !== undefined) {
        clearInterval(approvalTimer);
        approvalTimer = undefined;
      }
      await worker?.stop();
    },
  };
  return cascade;
}

function describeDecision(approval: ApprovalRequest): string {
  const who =
    approval.decision?.decidedBy.displayName ??
    approval.decision?.decidedBy.subjectId ??
    "The owner";
  const comment =
    approval.decision?.comment === undefined ? "" : ` Their note: "${approval.decision.comment}".`;
  switch (approval.status) {
    case "approved": {
      const call =
        approval.action.input === undefined
          ? `call \`${approval.action.name}\` again with the same input as before`
          : [
              `call \`${approval.action.name}\` again with exactly this input:`,
              "```json",
              canonicalJson(approval.action.input),
              "```",
            ].join("\n");
      return `Approved by ${who}.${comment} To carry it out, ${call}\nIt runs once. Any other input needs a new approval.`;
    }
    case "rejected":
      return `Rejected by ${who}.${comment} Do not try it again; choose another approach or explain why the task cannot be done.`;
    case "expired":
      return "Nobody decided before the request expired. Ask again only if it is still needed.";
    default:
      return `The request was ${approval.status}${approval.closedReason === undefined ? "" : `: ${approval.closedReason}`}.`;
  }
}

interface ParsedDirectives {
  readonly delegations: readonly DelegationDirective[];
  /** The reason given with `declare_impossible` (or the older `finish_task`). */
  readonly impossible?: string;
  readonly handIn?: {
    readonly summary: string;
    readonly deliverables: readonly AgentTaskDeliverable[];
  };
  readonly invalid?: string;
}

/** Reads `delegate_task`, `submit_work` and `declare_impossible` directives from an agent's reply. */
export function readDirectives(outputText: string): ParsedDirectives {
  const data = parseActorDirectives(outputText).data;
  if (data === undefined) {
    return { delegations: [] };
  }
  return readDirectiveData(data);
}

/**
 * Reads directives from parsed data: `{ delegate_task?: [...], submit_work?: {...},
 * declare_impossible?: { reason } }`. The older `finish_task: { status: "failed", reason }` reads
 * as an impossibility claim and gets the same review.
 */
export function readDirectiveData(data: JsonObject): ParsedDirectives {
  const declared = data[DECLARE_IMPOSSIBLE_TOOL_NAME];
  const finish = data[FINISH_TASK_TOOL_NAME];
  const claim = isObject(declared)
    ? declared
    : isObject(finish) && finish["status"] === "failed"
      ? finish
      : undefined;
  if (claim !== undefined) {
    const reason = claim["reason"];
    return {
      delegations: [],
      impossible:
        typeof reason === "string" && reason.trim().length > 0
          ? reason.trim()
          : "The agent gave no reason.",
    };
  }
  const submitted = data[SUBMIT_WORK_TOOL_NAME];
  if (submitted !== undefined) {
    if (!isObject(submitted)) {
      return { delegations: [], invalid: `${SUBMIT_WORK_TOOL_NAME} must be a JSON object.` };
    }
    const parsed = parseHandIn(submitted);
    return "error" in parsed
      ? { delegations: [], invalid: parsed.error }
      : { delegations: [], handIn: parsed };
  }
  const raw = data["delegate_task"];
  if (raw === undefined) {
    return { delegations: [] };
  }
  return parseDelegationEntries(raw);
}

/**
 * Validates `delegate_task` entries, from a fenced-JSON reply or the `delegate_task` tool:
 * `{ to, task, definitionOfDone?, criteria?, goal? }` each.
 */
export function parseDelegationEntries(raw: JsonValue): ParsedDirectives {
  const entries = Array.isArray(raw) ? raw : [raw];
  const delegations: DelegationDirective[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) {
      return { delegations: [], invalid: "Each delegate_task entry must be a JSON object." };
    }
    const to = entry["to"] ?? entry["agentId"];
    const task = entry["task"] ?? entry["instruction"];
    if (
      typeof to !== "string" ||
      to.length === 0 ||
      typeof task !== "string" ||
      task.length === 0
    ) {
      return {
        delegations: [],
        invalid: 'Each delegate_task entry needs a string "to" (agent id) and "task".',
      };
    }
    const definitionOfDone = entry["definitionOfDone"];
    const criteria = entry["criteria"];
    const goal: AgentTaskGoal | undefined =
      typeof definitionOfDone === "string" || Array.isArray(criteria)
        ? {
            ...(typeof definitionOfDone === "string" ? { definitionOfDone } : {}),
            ...(Array.isArray(criteria)
              ? { criteria: criteria.filter((item): item is string => typeof item === "string") }
              : {}),
          }
        : undefined;
    let spec: AgentTaskGoal["spec"];
    if (entry["goal"] !== undefined) {
      const parsed = readDelegatedGoalSpec(entry["goal"]);
      if ("error" in parsed) {
        return {
          delegations: [],
          invalid: `The goal for "${to}" is not a valid goal spec. ${parsed.error}`,
        };
      }
      spec = parsed.spec;
    }
    const fullGoal: AgentTaskGoal | undefined =
      spec === undefined ? goal : { ...(goal ?? {}), spec };
    delegations.push({ to, task, ...(fullGoal === undefined ? {} : { goal: fullGoal }) });
  }
  return { delegations };
}

/** Validates `submit_work` arguments: a summary and up to 50 deliverable paths. */
export function parseHandIn(
  params: JsonObject,
):
  | { readonly summary: string; readonly deliverables: readonly AgentTaskDeliverable[] }
  | { readonly error: string } {
  const summary = params["summary"];
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return { error: 'Pass a "summary" of the result for whoever assigned the task.' };
  }
  const raw = params["deliverables"] ?? [];
  if (!Array.isArray(raw)) {
    return { error: '"deliverables" must be a list of { path, title? }.' };
  }
  if (raw.length > MAX_DELIVERABLES) {
    return { error: `Hand in at most ${MAX_DELIVERABLES} deliverables.` };
  }
  const deliverables: AgentTaskDeliverable[] = [];
  for (const entry of raw) {
    const path = typeof entry === "string" ? entry : isObject(entry) ? entry["path"] : undefined;
    if (typeof path !== "string" || path.trim().length === 0) {
      return { error: 'Each deliverable needs a "path".' };
    }
    const title = isObject(entry) ? entry["title"] : undefined;
    deliverables.push({
      path: path.trim(),
      ...(typeof title === "string" && title.trim().length > 0 ? { title: title.trim() } : {}),
    });
  }
  return { summary: summary.trim(), deliverables };
}

/** A hand-in as text for whoever assigned the task: the summary, then the files. */
export function renderHandIn(handIn: Pick<AgentTaskHandIn, "summary" | "deliverables">): string {
  if (handIn.deliverables.length === 0) {
    return handIn.summary;
  }
  return [
    handIn.summary,
    "",
    "Deliverables:",
    ...handIn.deliverables.map(
      (deliverable) =>
        `- ${deliverable.path}${deliverable.title === undefined ? "" : ` (${deliverable.title})`}`,
    ),
  ].join("\n");
}

function markDelivered(
  notices: readonly AgentTaskNotice[],
  round: number,
): readonly AgentTaskNotice[] {
  return notices.map((notice) =>
    notice.deliveredRound === undefined ? { ...notice, deliveredRound: round } : notice,
  );
}

function goalRevisionEntry(
  sealed: SealedGoal,
  revision: number,
  changedAt: string,
  source: AgentTaskGoalRevision["source"],
  changedBy?: string,
): AgentTaskGoalRevision {
  return {
    revision,
    fingerprint: sealed.fingerprint,
    objective: sealed.spec.objective,
    definitionOfDone: [...sealed.spec.definitionOfDone],
    changedAt,
    source,
    ...(changedBy === undefined ? {} : { changedBy }),
  };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, max: number, keepEnd = false): string {
  if (text.length <= max) {
    return text;
  }
  return keepEnd
    ? `… [${text.length - max} earlier characters omitted]\n${text.slice(text.length - max)}`
    : `${text.slice(0, max)}\n… [${text.length - max} more characters omitted]`;
}

export type { AgentTaskStatus };
