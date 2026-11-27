import { randomUUID } from "node:crypto";

import {
  AGENT_TASK_RUN_KIND,
  type AgentDirectory,
  type AgentTaskGoal,
  type AgentTaskImpossibilityClaim,
  type AgentTaskRecord,
  type AgentTaskStatus,
  type CreateDelegationCascadeOptions,
  createAgentDirectory,
  createDelegationCascade,
  type DelegationCascade,
  type DelegationCascadeEvent,
  type PersistentAgentRecord,
  runToTask,
} from "@generic-ai/plugin-delegation";
import type { AgentTaskExecutor, RunActor } from "@generic-ai/sdk";

import { type CompanyConfig, ceoOf, companyAgentSeeds, tierOf } from "./company.js";
import { type CompanyCosts, summarizeCompanyCosts } from "./costs.js";
import { type CompanyDrive, type DriveEntry, describeDriveForAgent } from "./drive.js";
import { type CompanyEventHub, createCompanyEventHub } from "./events.js";
import { type CompanyMemory, createCompanyMemory } from "./memory.js";
import type { CompanyStorage } from "./storage.js";
import {
  type ChatMessageRecord,
  type ChatThreadRecord,
  createThreadStore,
  type ThreadStore,
  threadTitleFrom,
} from "./threads.js";

/**
 * The running company: the persistent agents seeded from the company config,
 * the durable delegation cascade that moves work through the org chart, chat
 * threads with the CEO, and the live event hub. The HTTP API is a thin layer
 * over this object.
 */
export interface CompanyRuntimeOptions {
  readonly company: CompanyConfig;
  readonly storage: CompanyStorage;
  /** Root for agent homes (memory file and workspace per agent). */
  readonly agentsRoot: string;
  readonly executor: AgentTaskExecutor;
  /**
   * The company drive. When set, every goal gets a working folder on it, agents are told where
   * the drive and their goal's folder are, owner messages can attach drive files, and a
   * cancelled goal's folder is kept and marked abandoned.
   */
  readonly drive?: CompanyDrive;
  /**
   * The company memory (handbook plus private memory per agent; see memory.ts). Defaults to one
   * kept in the company's storage. Every agent turn gets its handbook and memory section.
   */
  readonly memory?: CompanyMemory;
  /**
   * Whether agent turns get the memory section (handbook and private memory). Defaults to true;
   * the baseline comparison turns it off to measure what memory is worth.
   */
  readonly memoryInPrompts?: boolean;
  /** Cascade limits and goal options (judges, checks). */
  readonly cascade?: Omit<
    CreateDelegationCascadeOptions,
    "runStore" | "queue" | "directory" | "executor" | "onEvent" | "now" | "createId"
  >;
  /** Messages of earlier exchanges in a thread shown to the CEO. Defaults to 6. */
  readonly threadContextMessages?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly log?: (message: string) => void;
}

export type ChatReplyStatus = AgentTaskStatus;

export interface ChatExchange {
  readonly message: ChatMessageRecord;
  readonly reply: {
    readonly agentId: string;
    readonly taskId: string;
    readonly status: ChatReplyStatus | "missing";
    readonly text?: string;
    readonly error?: string;
    readonly completedAt?: string;
  };
}

export interface ChatThreadView {
  readonly threadId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly exchanges: readonly ChatExchange[];
}

export interface OrgChartNode {
  readonly id: string;
  readonly role: string;
  readonly title?: string;
  readonly tier: string;
  readonly model?: string;
  readonly status: PersistentAgentRecord["status"];
  /** Tasks this agent is working on or waiting on right now. */
  readonly activeTasks: number;
  readonly reports: readonly OrgChartNode[];
}

export interface BoardColumn {
  readonly status: AgentTaskStatus;
  readonly tasks: readonly TaskSummary[];
}

export interface TaskSummary {
  readonly taskId: string;
  readonly rootTaskId: string;
  readonly parentTaskId?: string;
  readonly agentId: string;
  readonly delegatedBy?: string;
  readonly depth: number;
  readonly status: AgentTaskStatus;
  /** Short label: the owner's own words for a chat request, else the instruction. */
  readonly title: string;
  readonly instruction: string;
  readonly round: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly goal?: {
    readonly definitionOfDone?: string;
    readonly lastStatus?: string;
    readonly passed?: number;
    readonly required?: number;
    /** Goal version: 1 when first set, one more for each owner edit. */
    readonly revision?: number;
    /** True while the agent is still drafting the goal with `set_goal`. */
    readonly drafting?: boolean;
  };
  /** Questions the agent wrote down for the owner that have no answer yet. */
  readonly openQuestions?: number;
  /** Files handed in with `submit_work`. */
  readonly deliverables?: readonly string[];
  /** Set when a second reviewer agreed the task is impossible in principle. */
  readonly impossible?: { readonly reason: string; readonly reasoning?: string };
}

export interface ListTasksOptions {
  readonly status?: AgentTaskStatus | readonly AgentTaskStatus[];
  readonly agentId?: string;
  readonly rootOnly?: boolean;
  readonly limit?: number;
}

export interface SendMessageInput {
  readonly text: string;
  /** Drive paths of files the owner attached (uploaded or dropped into the chat). */
  readonly attachments?: readonly string[];
  readonly threadId?: string;
  readonly actor?: RunActor;
  readonly goal?: AgentTaskGoal;
}

export interface CompanyRuntime {
  readonly company: CompanyConfig;
  readonly ceoId: string;
  readonly storage: CompanyStorage;
  readonly directory: AgentDirectory;
  readonly cascade: DelegationCascade;
  readonly threads: ThreadStore;
  readonly events: CompanyEventHub;
  readonly drive?: CompanyDrive;
  readonly memory: CompanyMemory;
  /** Seeds agents and recovers interrupted work. Call once before `start`. */
  initialize(): Promise<void>;
  /** Starts the queue worker that runs agent turns. */
  start(): void;
  stop(): Promise<void>;

  sendMessage(input: SendMessageInput): Promise<{ thread: ChatThreadView; task: AgentTaskRecord }>;
  getThread(threadId: string): Promise<ChatThreadView | undefined>;
  listThreads(): Promise<readonly Omit<ChatThreadView, "exchanges">[]>;

  listAgents(): Promise<readonly PersistentAgentRecord[]>;
  orgChart(): Promise<OrgChartNode>;

  listTasks(options?: ListTasksOptions): Promise<readonly AgentTaskRecord[]>;
  board(options?: { readonly limit?: number }): Promise<readonly BoardColumn[]>;
  costs(options?: { readonly agentId?: string; readonly limit?: number }): Promise<CompanyCosts>;
}

export const BOARD_COLUMNS: readonly AgentTaskStatus[] = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
];

const ACTIVE_STATUSES: ReadonlySet<AgentTaskStatus> = new Set(["queued", "running", "waiting"]);

function taskTitle(task: AgentTaskRecord): string {
  const ownerText = task.metadata?.["ownerText"];
  const source = typeof ownerText === "string" ? ownerText : task.instruction;
  const line =
    source
      .split(/\r?\n/)
      .find((entry) => entry.trim().length > 0)
      ?.trim() ?? task.taskId;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function impossibleView(claim: AgentTaskImpossibilityClaim): {
  readonly reason: string;
  readonly reasoning?: string;
} {
  return {
    reason: claim.reason,
    ...(claim.review === undefined ? {} : { reasoning: claim.review.reasoning }),
  };
}

export function summarizeTask(task: AgentTaskRecord): TaskSummary {
  const report = task.lastGoalReport;
  const openQuestions = (task.ownerQuestions ?? []).filter(
    (question) => question.answer === undefined,
  ).length;
  const goal =
    task.goal === undefined && report === undefined && task.goalDraft === undefined
      ? undefined
      : {
          ...(task.goalRevision === undefined ? {} : { revision: task.goalRevision }),
          ...(task.goalDraft === "pending" ? { drafting: true } : {}),
          ...(task.goal?.definitionOfDone === undefined
            ? {}
            : { definitionOfDone: task.goal.definitionOfDone }),
          ...(report === undefined
            ? {}
            : { lastStatus: report.status, passed: report.passed, required: report.required }),
        };
  return {
    taskId: task.taskId,
    rootTaskId: task.rootTaskId,
    ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
    agentId: task.agentId,
    ...(task.delegatedBy === undefined ? {} : { delegatedBy: task.delegatedBy }),
    depth: task.depth,
    status: task.status,
    title: taskTitle(task),
    instruction: task.instruction,
    round: task.round,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    ...(goal === undefined ? {} : { goal }),
    ...(openQuestions === 0 ? {} : { openQuestions }),
    ...(task.handIn === undefined
      ? {}
      : { deliverables: task.handIn.deliverables.map((deliverable) => deliverable.path) }),
    ...(task.impossible === undefined ? {} : { impossible: impossibleView(task.impossible) }),
  };
}

function cascadeEventData(event: DelegationCascadeEvent): Readonly<Record<string, unknown>> {
  if (event.type === "error") {
    return {
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      message: event.error instanceof Error ? event.error.message : String(event.error),
    };
  }
  if (event.type === "tool.effect.replayed" || event.type === "tool.effect.uncertain") {
    return {
      taskId: event.taskId,
      toolName: event.record.toolName,
      effects: event.record.effects,
      status: event.record.status,
    };
  }
  return {
    task: summarizeTask(event.task),
    ...(event.type === "task.delegated" ? { children: event.children.map(summarizeTask) } : {}),
    ...(event.type === "task.requeued" ? { reason: event.reason } : {}),
    ...(event.type === "task.goal_changed" ? { source: event.source } : {}),
    ...(event.type === "task.owner_question" ? { question: event.question } : {}),
    ...(event.type === "task.impossibility_reviewed" ? { claim: event.claim } : {}),
    ...(event.type === "task.awaiting_approval"
      ? {
          approvals: event.approvals.map((approval) => ({
            approvalId: approval.approvalId,
            action: approval.action.name,
            summary: approval.action.summary,
          })),
        }
      : {}),
  };
}

export function createCompanyRuntime(options: CompanyRuntimeOptions): CompanyRuntime {
  const { company, storage } = options;
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const ceoId = ceoOf(company).id;
  const contextMessages = options.threadContextMessages ?? 6;
  const events = createCompanyEventHub({ now });
  const threads = createThreadStore(storage.kv, { now, createId });
  const directory = createAgentDirectory({ store: storage.agents, root: options.agentsRoot, now });

  const onEvent = (event: DelegationCascadeEvent) => {
    if (event.type === "error") {
      events.publish("runtime.error", cascadeEventData(event));
      options.log?.(
        `Cascade error${event.taskId === undefined ? "" : ` on ${event.taskId}`}: ${String(
          event.error instanceof Error ? event.error.message : event.error,
        )}`,
      );
      return;
    }
    events.publish(event.type, cascadeEventData(event));
    if (event.type === "tool.effect.replayed" || event.type === "tool.effect.uncertain") {
      return;
    }
    if (drive !== undefined && event.task.depth === 0) {
      const ending =
        event.type === "task.succeeded"
          ? "done"
          : event.type === "task.failed"
            ? "failed"
            : event.type === "task.cancelled"
              ? "abandoned"
              : undefined;
      if (ending !== undefined) {
        void drive
          .closeGoal(event.task.taskId, ending, event.task.failureMessage)
          .then((record) => {
            if (record !== undefined) {
              events.publish("drive.goal.updated", { ...record });
            }
          })
          .catch((error: unknown) => {
            options.log?.(`Could not record how goal ${event.task.taskId} ended: ${String(error)}`);
          });
      }
    }
    const threadId = event.task.metadata?.["threadId"];
    if (event.task.depth === 0 && typeof threadId === "string") {
      events.publish("thread.updated", {
        threadId,
        taskId: event.task.taskId,
        status: event.task.status,
      });
    }
  };

  const drive = options.drive;
  const memory =
    options.memory ??
    createCompanyMemory({
      kv: storage.kv,
      now,
      legacyNotes: (agentId) => directory.readMemory(agentId),
    });
  const executor: AgentTaskExecutor = async (input) => {
    let prompt = input.prompt;
    if (drive !== undefined) {
      prompt = withDriveSection(
        prompt,
        describeDriveForAgent({ agentId: input.agentId, goalId: input.rootTaskId }),
      );
    }
    if (options.memoryInPrompts === false) {
      return options.executor({ ...input, prompt });
    }
    const taskAt = input.prompt.search(/^## Task /m);
    const memorySection = await memory.promptSection(input.agentId, {
      query: taskAt === -1 ? input.prompt : input.prompt.slice(taskAt),
    });
    return options.executor({ ...input, prompt: withDriveSection(prompt, memorySection) });
  };

  const cascade = createDelegationCascade({
    // Long results reach the manager as a drive file and an excerpt, not a clipped paste.
    ...(drive === undefined
      ? {}
      : {
          saveChildResult: (child: AgentTaskRecord) =>
            drive.saveHandoff(
              child.rootTaskId,
              `${child.agentId}-${child.taskId}.md`,
              child.outputText ?? "",
            ),
        }),
    ...options.cascade,
    runStore: storage.runStore,
    queue: storage.queue,
    directory,
    executor,
    onEvent,
    now,
    createId,
    // Memory comes from the company memory (memory.ts), not the old notes file.
    memoryFile: false,
  });

  async function listTasks(listOptions: ListTasksOptions = {}): Promise<AgentTaskRecord[]> {
    const statuses =
      listOptions.status === undefined
        ? undefined
        : new Set(Array.isArray(listOptions.status) ? listOptions.status : [listOptions.status]);
    const limit = listOptions.limit ?? 200;
    // Task records and harness runs share the run store; over-fetch, then filter to tasks.
    const records = await storage.runStore.listRuns({ limit: Math.max(limit * 5, 500) });
    const tasks: AgentTaskRecord[] = [];
    for (const record of records) {
      if (record.metadata?.["kind"] !== AGENT_TASK_RUN_KIND) {
        continue;
      }
      const task = runToTask(record);
      if (task === undefined) {
        continue;
      }
      if (statuses !== undefined && !statuses.has(task.status)) {
        continue;
      }
      if (listOptions.agentId !== undefined && task.agentId !== listOptions.agentId) {
        continue;
      }
      if (listOptions.rootOnly === true && task.depth !== 0) {
        continue;
      }
      tasks.push(task);
      if (tasks.length >= limit) {
        break;
      }
    }
    return tasks;
  }

  async function exchangeFor(message: ChatMessageRecord): Promise<ChatExchange> {
    const task = await cascade.get(message.taskId);
    if (task === undefined) {
      return { message, reply: { agentId: ceoId, taskId: message.taskId, status: "missing" } };
    }
    const settled = task.status === "succeeded" || task.status === "failed";
    return {
      message,
      reply: {
        agentId: task.agentId,
        taskId: task.taskId,
        status: task.status,
        ...(settled && task.outputText !== undefined ? { text: task.outputText } : {}),
        ...(task.failureMessage === undefined ? {} : { error: task.failureMessage }),
        ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
      },
    };
  }

  async function viewThread(thread: ChatThreadRecord): Promise<ChatThreadView> {
    return {
      threadId: thread.threadId,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      exchanges: await Promise.all(thread.messages.map(exchangeFor)),
    };
  }

  async function instructionFor(
    thread: ChatThreadRecord | undefined,
    text: string,
    attachments: readonly DriveEntry[] = [],
  ) {
    const lines: string[] = [];
    const earlier = thread?.messages.slice(-contextMessages) ?? [];
    if (earlier.length > 0) {
      lines.push("Earlier in this conversation with the owner:");
      for (const message of earlier) {
        const exchange = await exchangeFor(message);
        lines.push(`Owner: ${message.text}`);
        const answer = exchange.reply.text ?? exchange.reply.error;
        lines.push(`You (${exchange.reply.status}): ${answer ?? "(no answer yet)"}`);
      }
      lines.push("", "New message from the owner:");
    } else {
      lines.push("Message from the owner:");
    }
    lines.push(text);
    if (attachments.length > 0) {
      lines.push("", "The owner attached these files on the company drive:");
      for (const file of attachments) {
        lines.push(`- ${file.path} (${describeSize(file.size ?? 0)}, ${file.mimeType ?? "file"})`);
      }
    }
    return lines.join("\n");
  }

  async function attachedFiles(paths: readonly string[]): Promise<DriveEntry[]> {
    if (paths.length === 0) {
      return [];
    }
    if (drive === undefined) {
      throw new RangeError("This company has no drive to attach files from.");
    }
    const files: DriveEntry[] = [];
    for (const filePath of new Set(paths)) {
      const entry = await drive.stat(filePath).catch(() => undefined);
      if (entry === undefined || entry.kind !== "file") {
        throw new RangeError(`The attachment ${filePath} is not a file on the drive.`);
      }
      files.push(entry);
    }
    return files;
  }

  async function buildOrgChart(): Promise<OrgChartNode> {
    const agents = await directory.list();
    const active = await listTasks({ status: [...ACTIVE_STATUSES], limit: 1000 });
    const busy = new Map<string, number>();
    for (const task of active) {
      busy.set(task.agentId, (busy.get(task.agentId) ?? 0) + 1);
    }
    const children = new Map<string, PersistentAgentRecord[]>();
    for (const agent of agents) {
      if (agent.reportsTo !== undefined) {
        children.set(agent.reportsTo, [...(children.get(agent.reportsTo) ?? []), agent]);
      }
    }
    const build = (agent: PersistentAgentRecord, seen: Set<string>): OrgChartNode => {
      seen.add(agent.id);
      const tier = agent.metadata?.["tier"];
      return {
        id: agent.id,
        role: agent.role,
        ...(agent.title === undefined ? {} : { title: agent.title }),
        tier: typeof tier === "string" ? tier : tierOf(company, agent.id),
        ...(agent.model === undefined ? {} : { model: agent.model }),
        status: agent.status,
        activeTasks: busy.get(agent.id) ?? 0,
        reports: (children.get(agent.id) ?? [])
          .filter((report) => !seen.has(report.id))
          .map((report) => build(report, seen)),
      };
    };
    const ceo = agents.find((agent) => agent.id === ceoId) ?? (await directory.require(ceoId));
    return build(ceo, new Set());
  }

  return {
    company,
    ceoId,
    storage,
    directory,
    cascade,
    threads,
    events,
    ...(drive === undefined ? {} : { drive }),
    memory,

    async initialize() {
      await drive?.ensure();
      const seeded = await directory.seed(companyAgentSeeds(company));
      for (const agent of await directory.list()) {
        await directory.ensureWorkspace(agent.id);
      }
      const recovered = await cascade.recover();
      options.log?.(
        `Company "${company.name}": ${seeded.created.length} agents created, ${seeded.updated.length} updated, ` +
          `${seeded.retired.length} retired; ${recovered} interrupted tasks re-queued.`,
      );
    },

    start() {
      cascade.start();
    },

    stop: () => cascade.stop(),

    async sendMessage(input) {
      const text = input.text.trim();
      if (text.length === 0) {
        throw new RangeError("The message is empty.");
      }
      let thread = input.threadId === undefined ? undefined : await threads.get(input.threadId);
      if (input.threadId !== undefined && thread === undefined) {
        throw new RangeError(`Thread ${input.threadId} was not found.`);
      }
      const attachments = await attachedFiles(input.attachments ?? []);
      const instruction = await instructionFor(thread, text, attachments);
      if (thread === undefined) {
        thread = await threads.create({ title: threadTitleFrom(text) });
      }
      const taskId = createId();
      await drive?.openGoal({
        goalId: taskId,
        title: threadTitleFrom(text),
        threadId: thread.threadId,
      });
      const task = await cascade.submit({
        taskId,
        agentId: ceoId,
        instruction,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        // Every request gets a goal (decision 6): a template's goal when the owner sent one,
        // otherwise the CEO drafts it with set_goal before any work starts.
        ...(input.goal === undefined ? { draftGoal: true } : { goal: input.goal }),
        metadata: { threadId: thread.threadId, source: "owner-chat", ownerText: text },
      });
      const message: ChatMessageRecord = {
        messageId: createId(),
        text,
        createdAt: now().toISOString(),
        taskId: task.taskId,
        ...(attachments.length === 0 ? {} : { attachments: attachments.map((file) => file.path) }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
      };
      const updated = await threads.append(thread.threadId, message);
      events.publish("thread.updated", {
        threadId: updated.threadId,
        taskId: task.taskId,
        status: task.status,
      });
      return { thread: await viewThread(updated), task };
    },

    async getThread(threadId) {
      const thread = await threads.get(threadId);
      return thread === undefined ? undefined : viewThread(thread);
    },

    async listThreads() {
      return (await threads.list()).map(({ messages: _messages, ...thread }) => thread);
    },

    listAgents: () => directory.list({ includeRetired: true }),
    orgChart: buildOrgChart,
    listTasks,

    async board(boardOptions = {}) {
      const tasks = await listTasks({ limit: boardOptions.limit ?? 300 });
      return BOARD_COLUMNS.map((status) => ({
        status,
        tasks: tasks.filter((task) => task.status === status).map(summarizeTask),
      }));
    },

    async costs(costOptions = {}) {
      const completed = await listTasks({ rootOnly: true, status: "succeeded", limit: 10_000 });
      return summarizeCompanyCosts(storage.runStore, {
        completedRequestIds: new Set(completed.map((task) => task.taskId)),
        ...(costOptions.agentId === undefined ? {} : { agentId: costOptions.agentId }),
        ...(costOptions.limit === undefined ? {} : { limit: costOptions.limit }),
      });
    },
  };
}

function describeSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Puts the drive section before the task in an agent's prompt, or at the end. */
export function withDriveSection(prompt: string, section: string): string {
  const marker = prompt.search(/^## Task /m);
  if (marker === -1) {
    return `${prompt}\n\n${section}`;
  }
  return `${prompt.slice(0, marker)}${section}\n\n${prompt.slice(marker)}`;
}
