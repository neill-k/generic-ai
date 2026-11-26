import { randomUUID } from "node:crypto";

import type {
  AgentTaskExecutionResult,
  AgentTaskExecutor,
  ApprovalRequest,
  ApprovalServiceContract,
  CanonicalEvent,
  CanonicalEventName,
  DurableQueueContract,
  DurableQueueLease,
  JsonObject,
  JsonValue,
  QueueWorker,
  QueueWorkerJobContext,
  QueueWorkerOptions,
  RunStoreContract,
} from "@generic-ai/sdk";
import {
  canonicalJson,
  createQueueWorker,
  isRunStoreError,
  NonRetryableJobError,
  parseActorDirectives,
} from "@generic-ai/sdk";

import type { AgentDirectory, PersistentAgentRecord } from "./agents.js";
import {
  type AgentTaskGoal,
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
}

export interface TaskValidationResult {
  readonly passed: boolean;
  /** What to fix. Shown to the agent on its next attempt. */
  readonly feedback?: string;
}

/** Gate on finishing a task. Roadmap R24 plugs goal validators in here. */
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
  | { readonly type: "error"; readonly error: unknown; readonly taskId?: string };

export interface CreateDelegationCascadeOptions {
  readonly runStore: RunStoreContract;
  readonly queue: DurableQueueContract<AgentTaskJobPayload, AgentTaskJobResult>;
  readonly directory: AgentDirectory;
  readonly executor: AgentTaskExecutor;
  readonly validate?: TaskValidator;
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
  /** Who an agent may delegate to. Defaults to `direct-reports`. */
  readonly delegationScope?: DelegationScope;
  /** Deepest delegation allowed (root task is depth 0). Defaults to 6. */
  readonly maxDepth?: number;
  /** Most turns a single task may take. Defaults to 12. */
  readonly maxRounds?: number;
  /** Most children one delegation may create. Defaults to 8. */
  readonly maxChildrenPerDelegation?: number;
  /** Failed validations before a task fails. Defaults to 3. */
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
  /** Stable id makes submission idempotent. Generated when omitted. */
  readonly taskId?: string;
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
  maxRounds: 12,
  maxChildrenPerDelegation: 8,
  maxValidationAttempts: 3,
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
    task: Pick<AgentTaskRecord, "taskId" | "rootTaskId" | "parentTaskId">,
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
      const child = await create({
        taskId: `${task.taskId}.${task.round}.${index + 1}`,
        rootTaskId: task.rootTaskId,
        parentTaskId: task.taskId,
        depth: task.depth + 1,
        agentId: directive.to,
        delegatedBy: agent.id,
        instruction: directive.task,
        ...(directive.goal === undefined ? {} : { goal: directive.goal }),
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
    const attemptNumber = initial.attempts + 1;
    const attemptRunId = `${taskId}:turn-${round}:attempt-${attemptNumber}`;
    const task = await update(taskId, (current) => ({
      status: "running",
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

    const prompt = await buildPrompt(task, agent);
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

    const afterTurn = await load(taskId);
    if (afterTurn === undefined || isTerminalTaskStatus(afterTurn.status)) {
      return { taskId, round, outcome: "cancelled" };
    }
    if (result.runIds !== undefined && result.runIds.length > 0) {
      await update(taskId, (current) => ({
        runIds: [...new Set([...current.runIds, ...(result.runIds ?? [])])],
      }));
    }
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

    const directives = readDirectives(result.outputText);
    if (directives.failure !== undefined) {
      await settle(taskId, "failed", {
        failureMessage: directives.failure,
        outputText: result.outputText,
      });
      return { taskId, round, outcome: "failed" };
    }
    if (directives.invalid !== undefined) {
      await requeue(taskId, directives.invalid);
      return { taskId, round, outcome: "requeued" };
    }
    if (directives.delegations.length > 0) {
      const current = (await load(taskId)) as AgentTaskRecord;
      return delegate(current, agent, directives.delegations);
    }

    if (options.validate !== undefined) {
      const current = (await load(taskId)) as AgentTaskRecord;
      const verdict = await options.validate({
        task: current,
        agent,
        outputText: result.outputText,
      });
      if (!verdict.passed) {
        const failures = current.validationFailures + 1;
        const feedback = verdict.feedback ?? "The result did not pass validation.";
        await logEvent(current, "session.failed", {
          round,
          validation: "failed",
          feedback,
        });
        if (failures >= limits.maxValidationAttempts) {
          await settle(taskId, "failed", {
            outputText: result.outputText,
            failureMessage: `Result failed validation ${failures} times. Last feedback: ${feedback}`,
          });
          return { taskId, round, outcome: "failed" };
        }
        await requeue(taskId, `Your last result did not pass validation:\n${feedback}`, {
          validationFailures: failures,
          outputText: result.outputText,
        });
        return { taskId, round, outcome: "requeued" };
      }
    }

    await settle(taskId, "succeeded", { outputText: result.outputText });
    return { taskId, round, outcome: "finished" };
  }

  // ---------------------------------------------------------------------------
  // Prompt
  // ---------------------------------------------------------------------------

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
    if (task.goal !== undefined) {
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
    if (task.feedback !== undefined) {
      lines.push("", "## Feedback on your previous attempt", task.feedback);
      if (task.outputText !== undefined && task.outputText.length > 0) {
        lines.push("", "Your previous result:", clip(task.outputText, limits.childChars));
      }
    }

    lines.push(
      "",
      "## How to respond",
      "When the task is done, reply with the final result for whoever assigned it.",
    );
    if (delegatable.length > 0 && task.depth < limits.maxDepth) {
      lines.push(
        "To hand work to others instead, end your reply with one fenced JSON block like this:",
        "```json",
        '{"delegate_task": [{"to": "<agent id>", "task": "<what to do and why>", "definitionOfDone": "<how they know it is done>"}]}',
        "```",
        "You will get a new turn with their results once all of them finish; then finish the task or delegate again.",
      );
    }
    lines.push(
      "If the task cannot be done, end with:",
      "```json",
      '{"finish_task": {"status": "failed", "reason": "<why>"}}',
      "```",
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
      const task = await create({
        taskId,
        rootTaskId: taskId,
        depth: 0,
        agentId: agent.id,
        instruction: input.instruction,
        ...(input.goal === undefined ? {} : { goal: input.goal }),
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
  readonly failure?: string;
  readonly invalid?: string;
}

/** Reads `delegate_task` and `finish_task` directives from an agent's reply. */
export function readDirectives(outputText: string): ParsedDirectives {
  const data = parseActorDirectives(outputText).data;
  if (data === undefined) {
    return { delegations: [] };
  }
  const finish = data["finish_task"];
  if (isObject(finish) && finish["status"] === "failed") {
    const reason = finish["reason"];
    return {
      delegations: [],
      failure: typeof reason === "string" && reason.length > 0 ? reason : "The agent gave up.",
    };
  }
  const raw = data["delegate_task"];
  if (raw === undefined) {
    return { delegations: [] };
  }
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
    delegations.push({ to, task, ...(goal === undefined ? {} : { goal }) });
  }
  return { delegations };
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
