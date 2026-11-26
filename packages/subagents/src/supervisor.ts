// Adapted from Prime Agent (PrimeIntellect-ai/prime-agent: crates/pa-core/src/session_engine/rlm_host.rs,
// crates/pa-core/src/session_engine/agent_messaging.rs, crates/pa-daemon/src/rlm_children).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.
//
// Prime Agent runs each child in its own daemon worker. Here every agent of a tree lives in one
// process: a node per agent holds its inbox, progress notes, and a supervisor for its children, and
// a child's session comes from an injected factory.

import { randomUUID } from "node:crypto";

import type { AgentThinkingLevel } from "@generic-ai/agent";

import { Inbox } from "./inbox.js";
import {
  type AgentFamilyMember,
  type AgentFamilyRelationship,
  type AgentMessageDeliveryStatus,
  assertAgentMessageQueueCapacity,
  assertDirectAgentMessageTarget,
  createAgentMessageId,
  createAgentMessagePrompt,
  DEFAULT_AGENT_MESSAGE_MAX_CHARS,
  DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
  inverseRelationship,
  normalizeAgentMessage,
  resolveFamilyMember,
} from "./messaging.js";
import { normalizeProgressNote, type ProgressNoteOutcome, ProgressNotes } from "./progress.js";
import {
  ANSWER_TEXT_MAX_CHARS,
  capText,
  childLabel,
  codePointLength,
  compactText,
} from "./text.js";

export const SUBAGENT_NAME_MAX_LENGTH = 64;
export const COLLECT_MAX_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
export const DEFAULT_SUBAGENT_MAX_RUNNING = 8;
export const THINKING_LEVELS: readonly AgentThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export type SubagentStatus = "running" | "completed" | "error" | "cancelled";

/** What a child session factory is asked to build. */
export interface ChildSessionRequest {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  /** Model reference from the spawn call, for the factory to resolve. */
  readonly model?: string | undefined;
  readonly thinking?: AgentThinkingLevel | undefined;
  readonly cwd?: string | undefined;
  /** The child's own node: its messaging, inbox, progress notes, and children. */
  readonly node: AgentNode;
}

/** How one task of a child ended. */
export interface ChildRunResult {
  readonly answer?: string | undefined;
  readonly error?: string | undefined;
  readonly aborted?: boolean | undefined;
  readonly toolUseCount?: number | undefined;
}

/** A child agent's session. One task runs at a time; a message to a settled child starts another. */
export interface ChildSession {
  /** Run one task to completion. Stop early when `signal` aborts. */
  run(prompt: string, signal: AbortSignal): Promise<ChildRunResult>;
  /** Deliver a message to the running task. */
  steer(message: string): void;
  /** Messages delivered but not yet read by the model. */
  pendingMessageCount?(): number;
  dispose?(): void | Promise<void>;
}

export type ChildSessionFactory = (
  request: ChildSessionRequest,
) => ChildSession | Promise<ChildSession>;

export type SubagentEvent =
  | {
      readonly type: "spawned";
      readonly parentId: string;
      readonly id: string;
      readonly name: string;
      readonly depth: number;
      readonly label: string;
    }
  | {
      readonly type: "settled";
      readonly id: string;
      readonly name: string;
      readonly status: SubagentStatus;
      readonly durationMs: number;
      readonly toolUseCount: number;
      readonly error?: string;
    }
  | { readonly type: "deleted"; readonly id: string; readonly name: string }
  | { readonly type: "renamed"; readonly id: string; readonly from: string; readonly to: string }
  | {
      readonly type: "message";
      readonly messageId: string;
      readonly fromId: string;
      readonly toId: string;
      readonly receiverRole: AgentFamilyRelationship;
      readonly deliveryStatus: AgentMessageDeliveryStatus;
    }
  | {
      readonly type: "progress";
      readonly id: string;
      readonly name: string;
      readonly message: string;
    };

export interface SubagentTreeOptions {
  /** Builds each child's session. */
  readonly factory: ChildSessionFactory;
  /** Deepest level a child may run at; the root is depth 0. Defaults to 3. */
  readonly maxDepth?: number | undefined;
  /** Running children one agent may have at once. Defaults to 8. */
  readonly maxRunningChildren?: number | undefined;
  readonly maxMessageChars?: number | undefined;
  readonly maxPendingMessages?: number | undefined;
  readonly progressNoteIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly onEvent?: ((event: SubagentEvent) => void) | undefined;
}

interface TreeContext {
  readonly factory: ChildSessionFactory;
  readonly maxDepth: number;
  readonly maxRunningChildren: number;
  readonly maxMessageChars: number;
  readonly maxPendingMessages: number;
  readonly progressNoteIntervalMs: number | undefined;
  readonly now: () => number;
  readonly emit: (event: SubagentEvent) => void;
}

export interface SpawnInput {
  readonly prompt: unknown;
  readonly name?: unknown;
  readonly model?: unknown;
  readonly thinking?: unknown;
  readonly cwd?: unknown;
}

export interface SpawnHandle {
  readonly id: string;
  readonly name: string;
  readonly depth: number;
  readonly model?: string;
}

/** One roster row. */
export interface SubagentEntry {
  readonly id: string;
  readonly name: string;
  readonly status: SubagentStatus;
  readonly label: string;
  readonly depth: number;
  readonly model?: string;
  readonly cwd?: string;
  readonly toolUseCount: number;
  readonly durationMs: number;
  readonly answerPreview?: string;
  readonly repliedSinceTask: boolean;
  readonly progressNote?: string;
  readonly runningChildren: number;
}

/** One collect result. A timeout returns the current state, never an error. */
export interface ChildResult {
  readonly id: string;
  readonly name: string;
  readonly status: SubagentStatus;
  readonly settled: boolean;
  readonly answerPreview?: string;
  /** The full final answer, capped at 65,536 characters. */
  readonly answerText?: string;
  readonly error?: string;
  readonly durationMs: number;
  readonly toolUseCount: number;
  readonly repliedSinceTask: boolean;
  readonly progressNote?: string;
}

export interface DeleteResult {
  readonly subagent: SubagentEntry;
  readonly outcome: "deleted";
}

export interface AgentMessageReceipt {
  readonly id: string;
  readonly target: { readonly id: string; readonly name: string };
  readonly message: string;
  readonly deliveryStatus: AgentMessageDeliveryStatus;
  readonly receiverRole: AgentFamilyRelationship;
  readonly deliveredAt?: string;
  readonly queuedAt?: string;
}

export interface BroadcastReceipt {
  readonly receipts: readonly (
    | AgentMessageReceipt
    | { readonly target: string; readonly error: string }
  )[];
}

export interface SendAgentMessageInput {
  readonly message: unknown;
  readonly receiverRole: unknown;
  readonly receiverName?: unknown;
}

interface IncomingMessage {
  readonly id: string;
  readonly prompt: string;
  readonly message: string;
  readonly sender: AgentNode;
  readonly fromRelationship: AgentFamilyRelationship;
}

interface NodeDelivery {
  deliver(message: IncomingMessage): AgentMessageDeliveryStatus;
  pending(): number;
}

/** The part of an agent the root node needs to deliver messages to it. */
export interface MessageTargetAgent {
  readonly state: { readonly isStreaming: boolean };
  steer(message: { role: "user"; content: string; timestamp: number }): void;
  peekQueuedMessages(): readonly unknown[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalString(value: unknown, field: string, operation: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${operation} ${field} must be a string`);
  }
  return value;
}

/** Trim a subagent name and check it is non-empty, at most 64 characters, and not a broadcast word. */
export function normalizeSubagentName(
  value: unknown,
  operation = "spawn_agent",
): string | undefined {
  const raw = optionalString(value, "name", operation);
  if (raw === undefined) {
    return undefined;
  }
  const name = raw.trim();
  if (name.length === 0) {
    throw new Error(`${operation} name must not be empty`);
  }
  if (codePointLength(name) > SUBAGENT_NAME_MAX_LENGTH) {
    throw new Error(`${operation} name must be at most ${SUBAGENT_NAME_MAX_LENGTH} characters`);
  }
  return assertDirectAgentMessageTarget(name);
}

/** Check a thinking level against the supported levels. */
export function normalizeThinkingLevel(
  value: unknown,
  operation = "spawn_agent",
): AgentThinkingLevel | undefined {
  const raw = optionalString(value, "thinking", operation);
  if (raw === undefined) {
    return undefined;
  }
  const level = raw.trim().toLowerCase();
  const match = THINKING_LEVELS.find((candidate) => candidate === level);
  if (match === undefined) {
    throw new Error(`${operation} thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return match;
}

/** Check a collect timeout: a whole number of milliseconds from 0 to 2^31 - 1. */
export function normalizeCollectTimeout(value: unknown, operation = "collect_agents"): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > COLLECT_MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `${operation} timeout_ms must be a non-negative integer up to ${COLLECT_MAX_TIMEOUT_MS}`,
    );
  }
  return value;
}

/** One agent in a tree: the root session or a subagent. */
export class AgentNode {
  readonly id: string;
  readonly depth: number;
  readonly parent: AgentNode | undefined;
  readonly inbox: Inbox;
  readonly progress: ProgressNotes;
  readonly children: SubagentSupervisor;
  /** @internal */
  readonly tree: TreeContext;
  #name: string;
  #delivery: NodeDelivery | undefined;

  /** @internal Use `createSubagentRoot`; children are made by `spawn`. */
  constructor(input: {
    readonly id: string;
    readonly name: string;
    readonly depth: number;
    readonly parent?: AgentNode | undefined;
    readonly tree: TreeContext;
  }) {
    this.id = input.id;
    this.#name = input.name;
    this.depth = input.depth;
    this.parent = input.parent;
    this.tree = input.tree;
    this.inbox = new Inbox({ now: input.tree.now });
    this.progress = new ProgressNotes({
      now: input.tree.now,
      ...(input.tree.progressNoteIntervalMs === undefined
        ? {}
        : { minIntervalMs: input.tree.progressNoteIntervalMs }),
    });
    this.children = new SubagentSupervisor(this);
  }

  get name(): string {
    return this.#name;
  }

  /** True when this agent may spawn children. */
  get canSpawn(): boolean {
    return this.depth < this.tree.maxDepth;
  }

  /** @internal */
  setName(name: string): void {
    this.#name = name;
  }

  /** @internal */
  setDelivery(delivery: NodeDelivery | undefined): void {
    this.#delivery = delivery;
  }

  /**
   * Deliver messages for this agent to `agent`: steered into a running turn, or kept in the inbox
   * while it is idle. Returns the function that stops delivery.
   */
  bindAgent(agent: MessageTargetAgent): () => void {
    const delivery: NodeDelivery = {
      deliver: (message) => {
        if (agent.state.isStreaming) {
          agent.steer({ role: "user", content: message.prompt, timestamp: this.tree.now() });
          return "delivered";
        }
        this.#queue(message);
        return "queued";
      },
      pending: () => agent.peekQueuedMessages().length,
    };
    this.#delivery = delivery;
    return () => {
      if (this.#delivery === delivery) {
        this.#delivery = undefined;
      }
    };
  }

  #queue(message: IncomingMessage): void {
    this.inbox.push({
      kind: "agent-message",
      sender: message.sender.name,
      text: message.message,
      details: {
        id: message.id,
        prompt: message.prompt,
        fromRelationship: message.fromRelationship,
      },
    });
  }

  /** @internal */
  receive(message: IncomingMessage): AgentMessageDeliveryStatus {
    if (this.#delivery === undefined) {
      this.#queue(message);
      return "queued";
    }
    return this.#delivery.deliver(message);
  }

  /** @internal */
  pendingMessages(): number {
    return this.#delivery?.pending() ?? 0;
  }

  /** The parent, live siblings, and live children of this agent. */
  familyNodes(): { readonly relationship: AgentFamilyRelationship; readonly node: AgentNode }[] {
    const family: { relationship: AgentFamilyRelationship; node: AgentNode }[] = [];
    if (this.parent !== undefined) {
      family.push({ relationship: "parent", node: this.parent });
      for (const sibling of this.parent.children.liveNodes()) {
        if (sibling !== this) {
          family.push({ relationship: "sibling", node: sibling });
        }
      }
    }
    for (const child of this.children.liveNodes()) {
      family.push({ relationship: "child", node: child });
    }
    return family;
  }

  family(): AgentFamilyMember[] {
    return this.familyNodes().map(({ relationship, node }) => ({
      relationship,
      id: node.id,
      name: node.name,
    }));
  }

  #deliverTo(
    target: AgentNode,
    receiverRole: AgentFamilyRelationship,
    message: string,
  ): AgentMessageReceipt {
    assertAgentMessageQueueCapacity(target.pendingMessages(), this.tree.maxPendingMessages);
    const fromRelationship = inverseRelationship(receiverRole);
    const id = createAgentMessageId();
    const prompt = createAgentMessagePrompt({ message, senderName: this.name, fromRelationship });
    const deliveryStatus = target.receive({ id, prompt, message, sender: this, fromRelationship });
    if (receiverRole === "parent") {
      this.parent?.children.markReplied(this.id);
    }
    this.tree.emit({
      type: "message",
      messageId: id,
      fromId: this.id,
      toId: target.id,
      receiverRole,
      deliveryStatus,
    });
    const at = new Date(this.tree.now()).toISOString();
    return {
      id,
      target: { id: target.id, name: target.name },
      message,
      deliveryStatus,
      receiverRole,
      ...(deliveryStatus === "delivered" ? { deliveredAt: at } : { queuedAt: at }),
    };
  }

  /** Send a message to the parent, or to a sibling or child by name, id, or alias. */
  sendMessage(input: SendAgentMessageInput): AgentMessageReceipt {
    if (typeof input.message !== "string") {
      throw new Error("send_agent_message message must be a string");
    }
    const message = normalizeAgentMessage(input.message, this.tree.maxMessageChars);
    const family = this.familyNodes();
    const member = resolveFamilyMember(this.family(), input.receiverRole, input.receiverName);
    const target = family.find(
      (entry) => entry.relationship === member.relationship && entry.node.id === member.id,
    )?.node;
    if (target === undefined) {
      throw new Error(`No ${member.relationship} matches ${JSON.stringify(member.id)}`);
    }
    return this.#deliverTo(target, member.relationship, message);
  }

  /** Send one message to every family member. A failed delivery is recorded, not thrown. */
  broadcast(rawMessage: unknown): BroadcastReceipt {
    if (typeof rawMessage !== "string") {
      throw new Error("send_agent_message message must be a string");
    }
    const message = normalizeAgentMessage(rawMessage, this.tree.maxMessageChars);
    return {
      receipts: this.familyNodes().map(({ relationship, node }) => {
        try {
          return this.#deliverTo(node, relationship, message);
        } catch (error) {
          return { target: node.id, error: errorMessage(error) };
        }
      }),
    };
  }

  /** Record a progress note for the parent's roster. At most one note per 10 seconds is kept. */
  note(raw: unknown): ProgressNoteOutcome {
    const message = normalizeProgressNote(raw);
    const outcome = this.progress.note(message);
    if (outcome.accepted) {
      this.tree.emit({ type: "progress", id: this.id, name: this.name, message });
    }
    return outcome;
  }
}

interface ChildRecord {
  readonly id: string;
  readonly node: AgentNode;
  readonly label: string;
  readonly model: string | undefined;
  readonly cwd: string | undefined;
  session: ChildSession | undefined;
  status: SubagentStatus;
  runStartedAt: number;
  settledAt: number | undefined;
  answerPreview: string | undefined;
  answerText: string | undefined;
  error: string | undefined;
  toolUseCount: number;
  repliedSinceTask: boolean;
  controller: AbortController;
  done: Promise<void>;
  deleted: boolean;
}

/** The children of one agent: spawn, list, collect, rename, and delete. */
export class SubagentSupervisor {
  readonly #node: AgentNode;
  #records: ChildRecord[] = [];
  #tombstones: ChildRecord[] = [];
  #nextDefaultName = 1;

  constructor(node: AgentNode) {
    this.#node = node;
  }

  get #tree(): TreeContext {
    return this.#node.tree;
  }

  /** @internal */
  liveNodes(): AgentNode[] {
    return this.#records.map((record) => record.node);
  }

  /** @internal */
  markReplied(childId: string): void {
    const record = this.#records.find((candidate) => candidate.id === childId);
    if (record !== undefined) {
      record.repliedSinceTask = true;
    }
  }

  #assertNameAvailable(name: string, except?: ChildRecord): void {
    if (this.#records.some((record) => record !== except && record.node.name === name)) {
      throw new Error(
        `Agent name "${name}" is unavailable: an agent of that name already exists at depth ${
          this.#node.depth + 1
        } under this parent`,
      );
    }
  }

  #defaultName(): string {
    for (;;) {
      const name = `agent-${this.#nextDefaultName}`;
      this.#nextDefaultName += 1;
      if (!this.#records.some((record) => record.node.name === name)) {
        return name;
      }
    }
  }

  /** Start a child on a task. Resolves once the child is running, not when it finishes. */
  async spawn(input: SpawnInput): Promise<SpawnHandle> {
    const operation = "spawn_agent";
    if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
      throw new Error(`${operation} prompt must be a non-empty string`);
    }
    const prompt = input.prompt;
    const requestedName = normalizeSubagentName(input.name, operation);
    const model = optionalString(input.model, "model", operation)?.trim() || undefined;
    const thinking = normalizeThinkingLevel(input.thinking, operation);
    const cwd = optionalString(input.cwd, "cwd", operation)?.trim() || undefined;
    if (!this.#node.canSpawn) {
      throw new Error(
        `${operation} is not available at depth ${this.#node.depth}: the deepest subagent level is ${this.#tree.maxDepth}`,
      );
    }
    const running = this.#records.filter((record) => record.status === "running").length;
    if (running >= this.#tree.maxRunningChildren) {
      throw new Error(
        `Too many running subagents: ${running} running, limit is ${this.#tree.maxRunningChildren}`,
      );
    }
    if (requestedName !== undefined) {
      this.#assertNameAvailable(requestedName);
    }
    const name = requestedName ?? this.#defaultName();
    const id = `sub_${randomUUID()}`;
    const node = new AgentNode({
      id,
      name,
      depth: this.#node.depth + 1,
      parent: this.#node,
      tree: this.#tree,
    });
    const record: ChildRecord = {
      id,
      node,
      label: childLabel(prompt),
      model,
      cwd,
      session: undefined,
      status: "running",
      runStartedAt: this.#tree.now(),
      settledAt: undefined,
      answerPreview: undefined,
      answerText: undefined,
      error: undefined,
      toolUseCount: 0,
      repliedSinceTask: false,
      controller: new AbortController(),
      done: Promise.resolve(),
      deleted: false,
    };
    // Hold the name while the session is built.
    this.#records.push(record);
    try {
      record.session = await this.#tree.factory({
        id,
        name,
        prompt,
        node,
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(cwd === undefined ? {} : { cwd }),
      });
    } catch (error) {
      this.#records = this.#records.filter((candidate) => candidate !== record);
      throw error;
    }
    node.setDelivery({
      deliver: (message) => this.#deliverToChild(record, message),
      pending: () => record.session?.pendingMessageCount?.() ?? 0,
    });
    this.#tree.emit({
      type: "spawned",
      parentId: this.#node.id,
      id,
      name,
      depth: node.depth,
      label: record.label,
    });
    this.#startRun(record, prompt);
    return { id, name, depth: node.depth, ...(model === undefined ? {} : { model }) };
  }

  #startRun(record: ChildRecord, prompt: string): void {
    const session = record.session;
    if (session === undefined) {
      return;
    }
    const controller = new AbortController();
    record.controller = controller;
    record.status = "running";
    record.runStartedAt = this.#tree.now();
    record.settledAt = undefined;
    record.error = undefined;
    record.repliedSinceTask = false;
    record.node.progress.clear();
    record.done = (async () => {
      let result: ChildRunResult;
      try {
        result = await session.run(prompt, controller.signal);
      } catch (error) {
        result = { error: errorMessage(error), aborted: controller.signal.aborted };
      }
      this.#settle(record, result, controller);
    })();
  }

  #settle(record: ChildRecord, result: ChildRunResult, controller: AbortController): void {
    if (record.controller !== controller) {
      return;
    }
    record.toolUseCount += result.toolUseCount ?? 0;
    record.settledAt = this.#tree.now();
    if (result.answer !== undefined && result.answer.trim().length > 0) {
      record.answerText = capText(result.answer, ANSWER_TEXT_MAX_CHARS);
      record.answerPreview = compactText(result.answer);
    }
    if (record.deleted || result.aborted === true || controller.signal.aborted) {
      record.status = "cancelled";
    } else if (result.error !== undefined) {
      record.status = "error";
      record.error = result.error;
    } else {
      record.status = "completed";
    }
    const durationMs = record.settledAt - record.runStartedAt;
    if (!record.deleted) {
      this.#node.inbox.push({
        kind: record.status === "error" ? "child-failed" : "child-exited",
        sender: record.node.name,
        text: record.error ?? record.answerPreview ?? "",
        details: { id: record.id, status: record.status },
      });
    }
    this.#tree.emit({
      type: "settled",
      id: record.id,
      name: record.node.name,
      status: record.status,
      durationMs,
      toolUseCount: record.toolUseCount,
      ...(record.error === undefined ? {} : { error: record.error }),
    });
  }

  #deliverToChild(record: ChildRecord, message: IncomingMessage): AgentMessageDeliveryStatus {
    if (record.deleted || record.session === undefined) {
      throw new Error(`Agent "${record.node.name}" was deleted`);
    }
    if (record.status === "running") {
      record.session.steer(message.prompt);
    } else {
      this.#startRun(record, message.prompt);
    }
    return "delivered";
  }

  #matches(record: ChildRecord, target: string): boolean {
    return record.id === target || record.node.name === target;
  }

  #resolve(target: string, kind: "subagent" | "child"): ChildRecord {
    const matches = this.#records.filter((record) => this.#matches(record, target));
    const [only] = matches;
    if (matches.length === 1 && only !== undefined) {
      return only;
    }
    if (matches.length === 0) {
      throw new Error(`No direct ${kind} matches "${target}" in the current parent session`);
    }
    throw new Error(`${kind} selector "${target}" is ambiguous in the current parent session`);
  }

  #resolveWithTombstone(
    target: string,
    kind: "subagent" | "child",
  ): { readonly record: ChildRecord; readonly deleted: boolean } {
    try {
      return { record: this.#resolve(target, kind), deleted: false };
    } catch (miss) {
      const deleted = this.#tombstones.filter((record) => this.#matches(record, target));
      const [only] = deleted;
      if (deleted.length === 1 && only !== undefined) {
        return { record: only, deleted: true };
      }
      if (deleted.length > 1) {
        throw new Error(`${kind} selector "${target}" is ambiguous in the current parent session`);
      }
      throw miss;
    }
  }

  #duration(record: ChildRecord): number {
    return (record.settledAt ?? this.#tree.now()) - record.runStartedAt;
  }

  #entry(record: ChildRecord): SubagentEntry {
    const note = record.node.progress.latest()?.message;
    return {
      id: record.id,
      name: record.node.name,
      status: record.status,
      label: record.label,
      depth: record.node.depth,
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
      toolUseCount: record.toolUseCount,
      durationMs: this.#duration(record),
      ...(record.answerPreview === undefined ? {} : { answerPreview: record.answerPreview }),
      repliedSinceTask: record.repliedSinceTask,
      ...(note === undefined ? {} : { progressNote: note }),
      runningChildren: record.node.children.runningCount(),
    };
  }

  #result(record: ChildRecord): ChildResult {
    const note = record.node.progress.latest()?.message;
    return {
      id: record.id,
      name: record.node.name,
      status: record.status,
      settled: record.status !== "running",
      ...(record.answerPreview === undefined ? {} : { answerPreview: record.answerPreview }),
      ...(record.answerText === undefined ? {} : { answerText: record.answerText }),
      ...(record.error === undefined ? {} : { error: record.error }),
      durationMs: this.#duration(record),
      toolUseCount: record.toolUseCount,
      repliedSinceTask: record.repliedSinceTask,
      ...(note === undefined ? {} : { progressNote: note }),
    };
  }

  runningCount(): number {
    return this.#records.filter((record) => record.status === "running").length;
  }

  /** The live children, in spawn order. */
  list(): SubagentEntry[] {
    return this.#records.map((record) => this.#entry(record));
  }

  /**
   * Results for the named children, or every live child. With a timeout, wait up to that long for
   * the running ones to settle; a timeout returns their current state.
   */
  async collect(
    targets: readonly string[] = [],
    timeoutMs: unknown = 0,
    signal?: AbortSignal,
  ): Promise<ChildResult[]> {
    const timeout = normalizeCollectTimeout(timeoutMs);
    const live: ChildRecord[] = [];
    const deleted: ChildRecord[] = [];
    if (targets.length === 0) {
      live.push(...this.#records);
    }
    for (const raw of targets) {
      const target = typeof raw === "string" ? raw.trim() : "";
      if (target.length === 0) {
        throw new Error("collect_agents targets must be non-empty strings");
      }
      const resolved = this.#resolveWithTombstone(target, "child");
      (resolved.deleted ? deleted : live).push(resolved.record);
    }
    const running = live.filter((record) => record.status === "running");
    if (timeout > 0 && running.length > 0 && signal?.aborted !== true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      await Promise.race([
        Promise.all(running.map((record) => record.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeout);
          onAbort = resolve;
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
      }
    }
    return [...live, ...deleted].map((record) => this.#result(record));
  }

  /** Stop a child (and its children) and remove it. Deleting an already deleted child repeats the receipt. */
  async delete(rawTarget: unknown): Promise<DeleteResult> {
    const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
    if (target.length === 0) {
      throw new Error("delete_agent target must be a non-empty string");
    }
    const resolved = this.#resolveWithTombstone(target, "subagent");
    const record = resolved.record;
    if (!resolved.deleted) {
      record.deleted = true;
      this.#records = this.#records.filter((candidate) => candidate !== record);
      this.#tombstones.push(record);
      record.node.setDelivery(undefined);
      record.controller.abort();
      await record.node.children.shutdown();
      await record.done;
      await record.session?.dispose?.();
      this.#tree.emit({ type: "deleted", id: record.id, name: record.node.name });
    }
    return { subagent: this.#entry(record), outcome: "deleted" };
  }

  /** Rename a child. Names stay unique among one parent's live children. */
  rename(rawTarget: unknown, rawName: unknown): string {
    const operation = "rename_agent";
    const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
    if (target.length === 0) {
      throw new Error(`${operation} target must be a non-empty string`);
    }
    if (typeof rawName !== "string") {
      throw new Error(`${operation} name must be a string`);
    }
    const name = normalizeSubagentName(rawName, operation) ?? "";
    const record = this.#resolve(target, "subagent");
    this.#assertNameAvailable(name, record);
    const from = record.node.name;
    record.node.setName(name);
    if (from !== name) {
      this.#tree.emit({ type: "renamed", id: record.id, from, to: name });
    }
    return name;
  }

  /** Stop every running child and its descendants, and wait for them to settle. */
  async shutdown(): Promise<void> {
    const records = [...this.#records];
    for (const record of records) {
      if (record.status === "running") {
        record.controller.abort();
      }
    }
    await Promise.all(
      records.map(async (record) => {
        await record.node.children.shutdown();
        await record.done;
      }),
    );
    await Promise.all(records.map(async (record) => record.session?.dispose?.()));
  }
}

/** Create the root of an agent tree: the top-level session that spawns the first children. */
export function createSubagentRoot(
  options: SubagentTreeOptions & {
    readonly id?: string | undefined;
    readonly name?: string | undefined;
  },
): AgentNode {
  const onEvent = options.onEvent;
  const tree: TreeContext = {
    factory: options.factory,
    maxDepth: options.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH,
    maxRunningChildren: options.maxRunningChildren ?? DEFAULT_SUBAGENT_MAX_RUNNING,
    maxMessageChars: options.maxMessageChars ?? DEFAULT_AGENT_MESSAGE_MAX_CHARS,
    maxPendingMessages: options.maxPendingMessages ?? DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
    progressNoteIntervalMs: options.progressNoteIntervalMs,
    now: options.now ?? Date.now,
    emit: (event) => {
      try {
        onEvent?.(event);
      } catch {
        // A listener error must not break the tree.
      }
    },
  };
  return new AgentNode({
    id: options.id ?? `root_${randomUUID()}`,
    name: options.name ?? "main",
    depth: 0,
    tree,
  });
}
