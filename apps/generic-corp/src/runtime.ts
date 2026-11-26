import { randomUUID } from "node:crypto";

import {
  AGENT_TASK_RUN_KIND,
  type AgentDirectory,
  type AgentTaskGoal,
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
import { type CompanyEventHub, createCompanyEventHub } from "./events.js";
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
  };
}

export interface ListTasksOptions {
  readonly status?: AgentTaskStatus | readonly AgentTaskStatus[];
  readonly agentId?: string;
  readonly rootOnly?: boolean;
  readonly limit?: number;
}

export interface SendMessageInput {
  readonly text: string;
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
  readMemory(agentId: string): Promise<string>;

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

export function summarizeTask(task: AgentTaskRecord): TaskSummary {
  const report = task.lastGoalReport;
  const goal =
    task.goal === undefined && report === undefined
      ? undefined
      : {
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
    instruction: task.instruction,
    round: task.round,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    ...(goal === undefined ? {} : { goal }),
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
    const threadId = event.task.metadata?.["threadId"];
    if (event.task.depth === 0 && typeof threadId === "string") {
      events.publish("thread.updated", {
        threadId,
        taskId: event.task.taskId,
        status: event.task.status,
      });
    }
  };

  const cascade = createDelegationCascade({
    ...options.cascade,
    runStore: storage.runStore,
    queue: storage.queue,
    directory,
    executor: options.executor,
    onEvent,
    now,
    createId,
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

  async function instructionFor(thread: ChatThreadRecord | undefined, text: string) {
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
    return lines.join("\n");
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

    async initialize() {
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
      const instruction = await instructionFor(thread, text);
      if (thread === undefined) {
        thread = await threads.create({ title: threadTitleFrom(text) });
      }
      const task = await cascade.submit({
        agentId: ceoId,
        instruction,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        metadata: { threadId: thread.threadId, source: "owner-chat" },
      });
      const message: ChatMessageRecord = {
        messageId: createId(),
        text,
        createdAt: now().toISOString(),
        taskId: task.taskId,
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
    readMemory: (agentId) => directory.readMemory(agentId),
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
