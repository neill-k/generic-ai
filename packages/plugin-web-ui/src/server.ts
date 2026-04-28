import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  applyCanonicalConfigTransaction,
  getCanonicalConfigTransactionSnapshot,
  previewCanonicalConfigTransaction,
  resolveCanonicalConfig,
} from "@generic-ai/plugin-config-yaml";
import { createHonoSseResponse, type HonoStreamChunk } from "@generic-ai/plugin-hono";
import type { ResolvedConfig, StorageContract, StorageKey, StorageRecord } from "@generic-ai/sdk";
import { Hono } from "hono";

import { createBuiltInTemplateRegistry } from "./templates.js";
import {
  kind,
  name,
  type WebUiChatEvent,
  type WebUiChatMessage,
  type WebUiChatThread,
  type WebUiChatThreadDetail,
  type WebUiChatThreadStatus,
  type WebUiConfigApplyInput,
  type WebUiConfigMutationResult,
  type WebUiConfigPreviewInput,
  type WebUiConfigSnapshot,
  type WebUiHealth,
  type WebUiPlugin,
  type WebUiPluginOptions,
  type WebUiPostMessageInput,
  type WebUiTemplateApplyInput,
  type WebUiTemplateDefinition,
  type WebUiTemplateSummary,
  type WebUiTransportSecurityOptions,
} from "./types.js";

export interface HonoWebUiTransportOptions {
  readonly routePrefix?: string;
  readonly security?: WebUiTransportSecurityOptions;
  readonly createRequestId?: () => string;
}

export interface HonoWebUiTransport {
  readonly name: typeof name;
  readonly kind: "web-ui-hono";
  readonly routePrefix: string;
  readonly app: Hono;
  readonly fetch: Hono["fetch"];
  readonly sessionToken: string;
}

type StoredThread = WebUiChatThread;
type StoredMessage = WebUiChatMessage;
type StoredEvent = WebUiChatEvent;
type StoredIdempotency = WebUiConfigMutationResult;

const WEB_UI_NAMESPACE = "plugin-web-ui";
const THREADS_COLLECTION = "chat_threads";
const MESSAGES_COLLECTION = "chat_messages";
const EVENTS_COLLECTION = "chat_events";
const IDEMPOTENCY_COLLECTION = "idempotency";
const DEFAULT_ROUTE_PREFIX = "/console/api";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function formatRunnerFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Run failed: ${message}`;
}

class MemoryStorageContract implements StorageContract {
  readonly kind = "storage" as const;
  readonly driver = "web-ui-memory";
  readonly #records = new Map<string, StorageRecord>();

  async get<TValue>(key: StorageKey): Promise<StorageRecord<TValue> | undefined> {
    return this.#records.get(formatStorageKey(key)) as StorageRecord<TValue> | undefined;
  }

  async set<TValue>(record: StorageRecord<TValue>): Promise<void> {
    this.#records.set(formatStorageKey(record.key), record as StorageRecord);
  }

  async delete(key: StorageKey): Promise<boolean> {
    return this.#records.delete(formatStorageKey(key));
  }

  async list(filter: Parameters<StorageContract["list"]>[0] = {}): Promise<readonly StorageRecord[]> {
    return [...this.#records.values()].filter((record) => {
      if (filter.namespace !== undefined && record.key.namespace !== filter.namespace) {
        return false;
      }
      if (filter.collection !== undefined && record.key.collection !== filter.collection) {
        return false;
      }
      if (filter.prefix !== undefined && !record.key.id.startsWith(filter.prefix)) {
        return false;
      }
      return true;
    });
  }

  async clear(filter: Parameters<StorageContract["clear"]>[0] = {}): Promise<void> {
    for (const record of await this.list(filter)) {
      this.#records.delete(formatStorageKey(record.key));
    }
  }
}

class AsyncEventQueue<TValue> implements AsyncIterable<TValue> {
  readonly #pending: TValue[] = [];
  readonly #waiters: Array<(value: IteratorResult<TValue>) => void> = [];
  #closed = false;

  push(value: TValue): void {
    if (this.#closed) {
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }

    this.#pending.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TValue> {
    return {
      next: async () => {
        const value = this.#pending.shift();
        if (value !== undefined) {
          return { done: false, value };
        }

        if (this.#closed) {
          return { done: true, value: undefined };
        }

        return await new Promise<IteratorResult<TValue>>((resolveNext) => {
          this.#waiters.push(resolveNext);
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

export function createWebUiPlugin(options: WebUiPluginOptions): WebUiPlugin {
  const workspaceRoot = resolve(options.workspaceRoot);
  const storage = options.storage ?? new MemoryStorageContract();
  const templates = options.templates ?? createBuiltInTemplateRegistry();
  const idFactory = options.idFactory ?? randomUUID;
  const sessionToken = options.sessionToken ?? randomUUID();
  const subscribers = new Map<string, Set<AsyncEventQueue<WebUiChatEvent>>>();
  const activeRuns = new Map<string, AbortController>();

  function now(): string {
    const value = options.now?.() ?? new Date();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
  }

  async function store<TValue>(collection: string, id: string, value: TValue): Promise<void> {
    await storage.set({
      key: { namespace: WEB_UI_NAMESPACE, collection, id },
      value,
      updatedAt: now(),
    });
  }

  async function get<TValue>(collection: string, id: string): Promise<TValue | undefined> {
    return (await storage.get<TValue>({ namespace: WEB_UI_NAMESPACE, collection, id }))?.value;
  }

  async function list<TValue>(collection: string, prefix?: string): Promise<readonly TValue[]> {
    const records = await storage.list({
      namespace: WEB_UI_NAMESPACE,
      collection,
      ...(prefix === undefined ? {} : { prefix }),
    });
    return records.map((record) => record.value as TValue);
  }

  async function getConfig(): Promise<WebUiConfigSnapshot> {
    const snapshot = await getCanonicalConfigTransactionSnapshot(workspaceRoot);
    const resolved = await resolveCanonicalConfig(workspaceRoot);
    if (!resolved.ok) {
      return {
        ...snapshot,
        failures: resolved.failures.map((failure) => ({
          code: "VERIFY_FAILED",
          message: failure.message,
          ...(failure.concern === undefined ? {} : { concern: failure.concern }),
          ...(failure.key === undefined ? {} : { key: failure.key }),
          ...(failure.filePath === undefined ? {} : { filePath: failure.filePath }),
        })),
      };
    }

    return {
      ...snapshot,
      config: resolved.config as unknown as ResolvedConfig,
      failures: [],
    };
  }

  async function nextEventSequence(threadId: string): Promise<number> {
    const events = await list<StoredEvent>(EVENTS_COLLECTION, `${threadId}:`);
    return events.length + 1;
  }

  async function emitEvent(
    threadId: string,
    type: WebUiChatEvent["type"],
    data: Record<string, unknown>,
  ): Promise<WebUiChatEvent> {
    const sequence = await nextEventSequence(threadId);
    const event: WebUiChatEvent = {
      id: `${threadId}:${String(sequence).padStart(6, "0")}`,
      sequence,
      threadId,
      type,
      occurredAt: now(),
      data,
    };
    await store(EVENTS_COLLECTION, event.id, event);

    for (const queue of subscribers.get(threadId) ?? []) {
      queue.push(event);
    }

    return event;
  }

  async function saveThread(thread: WebUiChatThread): Promise<WebUiChatThread> {
    await store(THREADS_COLLECTION, thread.id, thread);
    return thread;
  }

  async function ensureThread(
    threadId: string,
    input: Pick<WebUiPostMessageInput, "selectedAgentId" | "selectedHarnessId"> = {},
  ): Promise<WebUiChatThread> {
    const existing = await get<StoredThread>(THREADS_COLLECTION, threadId);
    if (existing !== undefined) {
      return existing;
    }

    const createdAt = now();
    const thread: WebUiChatThread = {
      id: threadId,
      title: "New thread",
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      ...(input.selectedAgentId === undefined ? {} : { selectedAgentId: input.selectedAgentId }),
      ...(input.selectedHarnessId === undefined ? {} : { selectedHarnessId: input.selectedHarnessId }),
    };
    await saveThread(thread);
    await emitEvent(thread.id, "thread.created", { thread });
    return thread;
  }

  async function addMessage(
    threadId: string,
    role: WebUiChatMessage["role"],
    content: string,
  ): Promise<WebUiChatMessage> {
    const message: WebUiChatMessage = {
      id: idFactory(),
      threadId,
      role,
      content,
      createdAt: now(),
    };
    await store(MESSAGES_COLLECTION, message.id, message);
    await emitEvent(threadId, "message.created", { message });
    return message;
  }

  async function detail(thread: WebUiChatThread): Promise<WebUiChatThreadDetail> {
    const messages = (await list<StoredMessage>(MESSAGES_COLLECTION))
      .filter((message) => message.threadId === thread.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const events = [...(await list<StoredEvent>(EVENTS_COLLECTION, `${thread.id}:`))].sort(
      (left, right) => left.sequence - right.sequence,
    );
    return { thread, messages, events };
  }

  async function setThreadStatus(
    thread: WebUiChatThread,
    status: WebUiChatThreadStatus,
  ): Promise<WebUiChatThread> {
    return await saveThread({
      ...thread,
      status,
      updatedAt: now(),
    });
  }

  return Object.freeze({
    name,
    kind,
    workspaceRoot,
    sessionToken,
    async health(routePrefix: string): Promise<WebUiHealth> {
      const config = await getConfig();
      const templateList = templates.list();
      return {
        plugin: name,
        workspaceRoot,
        routePrefix,
        config: {
          ok: config.failures.length === 0,
          revision: config.revision,
          ...(config.config?.framework.primaryAgent === undefined
            ? {}
            : { primaryAgent: config.config.framework.primaryAgent }),
          ...(config.config?.framework.primaryHarness === undefined
            ? {}
            : { primaryHarness: config.config.framework.primaryHarness }),
        },
        templates: {
          total: templateList.length,
          runnable: templateList.filter((template) => template.status === "runnable").length,
          preview: templateList.filter((template) => template.status === "preview").length,
        },
        security: {
          loopbackOnly: true,
          requiresSessionTokenForMutation: true,
        },
      };
    },
    getConfig,
    async previewConfig(input: WebUiConfigPreviewInput): Promise<WebUiConfigMutationResult> {
      const result = await previewCanonicalConfigTransaction(workspaceRoot, {
        edits: input.edits,
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      });
      return result.ok ? { ok: true, plan: result.plan, failures: [] } : result;
    },
    async applyConfig(input: WebUiConfigApplyInput): Promise<WebUiConfigMutationResult> {
      if (input.idempotencyKey !== undefined) {
        const stored = await get<StoredIdempotency>(
          IDEMPOTENCY_COLLECTION,
          `config:${input.idempotencyKey}`,
        );
        if (stored !== undefined) {
          return stored;
        }
      }

      const result = await applyCanonicalConfigTransaction(workspaceRoot, {
        edits: input.edits,
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      });
      const normalized: WebUiConfigMutationResult = result.ok
        ? { ok: true, plan: result.plan, config: result.config, failures: [] }
        : result;

      if (input.idempotencyKey !== undefined) {
        await store(IDEMPOTENCY_COLLECTION, `config:${input.idempotencyKey}`, normalized);
      }
      return normalized;
    },
    listTemplates(): readonly WebUiTemplateSummary[] {
      return templates.list().map(toTemplateSummary);
    },
    getTemplate(id: string): WebUiTemplateDefinition | undefined {
      return templates.get(id);
    },
    async applyTemplate(
      id: string,
      input: WebUiTemplateApplyInput,
    ): Promise<WebUiConfigMutationResult> {
      const template = templates.get(id);
      if (template === undefined) {
        return {
          ok: false,
          failures: [{ code: "INVALID_EDIT", message: `Unknown template "${id}".` }],
        };
      }

      if (template.status !== "runnable") {
        return {
          ok: false,
          failures: [
            {
              code: "INVALID_EDIT",
              message: `Template "${id}" is preview-only: ${template.previewReason ?? "not runnable"}.`,
            },
          ],
        };
      }

      if (input.dryRun ?? true) {
        const result = await previewCanonicalConfigTransaction(workspaceRoot, {
          edits: template.edits,
          ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        });
        return result.ok ? { ok: true, plan: result.plan, failures: [] } : result;
      }

      if (input.idempotencyKey === undefined || input.idempotencyKey.trim().length === 0) {
        return {
          ok: false,
          failures: [
            {
              code: "INVALID_EDIT",
              message: "Mutating template apply requires an idempotencyKey.",
            },
          ],
        };
      }

      const stored = await get<StoredIdempotency>(
        IDEMPOTENCY_COLLECTION,
        `template:${id}:${input.idempotencyKey}`,
      );
      if (stored !== undefined) {
        return stored;
      }

      const result = await applyCanonicalConfigTransaction(workspaceRoot, {
        edits: template.edits,
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      });
      const normalized: WebUiConfigMutationResult = result.ok
        ? { ok: true, plan: result.plan, config: result.config, failures: [] }
        : result;
      await store(IDEMPOTENCY_COLLECTION, `template:${id}:${input.idempotencyKey}`, normalized);
      return normalized;
    },
    async listThreads(): Promise<readonly WebUiChatThread[]> {
      return [...(await list<StoredThread>(THREADS_COLLECTION))].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    },
    async getThread(threadId: string): Promise<WebUiChatThreadDetail | undefined> {
      const thread = await get<StoredThread>(THREADS_COLLECTION, threadId);
      return thread === undefined ? undefined : await detail(thread);
    },
    async postMessage(
      threadId: string,
      input: WebUiPostMessageInput,
      signal: AbortSignal,
    ): Promise<WebUiChatThreadDetail> {
      let thread = await ensureThread(threadId, input);
      if (thread.title === "New thread") {
        thread = await saveThread({
          ...thread,
          title: input.content.slice(0, 80) || "New thread",
          updatedAt: now(),
        });
      }

      const message = await addMessage(thread.id, "user", input.content);
      const runAbort = new AbortController();
      activeRuns.set(thread.id, runAbort);
      thread = await setThreadStatus(thread, "running");
      await emitEvent(thread.id, "run.started", { messageId: message.id });

      try {
        const config = await getConfig();
        const agentId = input.selectedAgentId ?? config.config?.framework.primaryAgent;
        const harnessId = input.selectedHarnessId ?? config.config?.framework.primaryHarness;
        const runnerResult =
          options.harnessRunner === undefined
            ? {
                content:
                  "No harness runner is configured for this host. The console stored the message and preserved the run boundary.",
                status: "completed" as const,
              }
            : await options.harnessRunner({
                thread,
                message,
                ...(config.config === undefined ? {} : { config: config.config }),
                ...(agentId === undefined || config.config?.agents[agentId] === undefined
                  ? {}
                  : { agent: config.config.agents[agentId] }),
                ...(harnessId === undefined || config.config?.harnesses?.[harnessId] === undefined
                  ? {}
                  : { harness: config.config.harnesses[harnessId] }),
                signal: signal.aborted ? signal : runAbort.signal,
              });

        await addMessage(thread.id, "assistant", runnerResult.content);
        thread = await setThreadStatus(thread, runnerResult.status ?? "completed");
        await emitEvent(thread.id, thread.status === "failed" ? "run.failed" : "run.completed", {
          status: thread.status,
          ...(runnerResult.metadata === undefined ? {} : { metadata: runnerResult.metadata }),
        });
      } catch (error) {
        const failureMessage = formatRunnerFailure(error);
        await addMessage(thread.id, "assistant", failureMessage);
        thread = await setThreadStatus(thread, signal.aborted || runAbort.signal.aborted ? "interrupted" : "failed");
        await emitEvent(thread.id, thread.status === "interrupted" ? "run.interrupted" : "run.failed", {
          message: failureMessage,
        });
      } finally {
        activeRuns.delete(thread.id);
      }

      return await detail(thread);
    },
    async interruptThread(threadId: string): Promise<WebUiChatThreadDetail | undefined> {
      activeRuns.get(threadId)?.abort();
      const thread = await get<StoredThread>(THREADS_COLLECTION, threadId);
      if (thread === undefined) {
        return undefined;
      }

      const updated = await setThreadStatus(thread, "interrupted");
      await emitEvent(threadId, "run.interrupted", {});
      return await detail(updated);
    },
    async *streamThreadEvents(
      threadId: string,
      fromSequence = 0,
    ): AsyncIterable<WebUiChatEvent> {
      const existing = (await list<StoredEvent>(EVENTS_COLLECTION, `${threadId}:`))
        .filter((event) => event.sequence > fromSequence)
        .sort((left, right) => left.sequence - right.sequence);
      for (const event of existing) {
        yield event;
      }

      const queue = new AsyncEventQueue<WebUiChatEvent>();
      const set = subscribers.get(threadId) ?? new Set<AsyncEventQueue<WebUiChatEvent>>();
      set.add(queue);
      subscribers.set(threadId, set);
      try {
        for await (const event of queue) {
          yield event;
        }
      } finally {
        queue.close();
        set.delete(queue);
        if (set.size === 0) {
          subscribers.delete(threadId);
        }
      }
    },
  });
}

export function createHonoWebUiTransport(
  plugin: WebUiPlugin,
  options: HonoWebUiTransportOptions = {},
): HonoWebUiTransport {
  const routePrefix = normalizeRoutePrefix(options.routePrefix ?? DEFAULT_ROUTE_PREFIX);
  const app = new Hono();

  app.use(`${routePrefix}/*`, async (context, next) => {
    const exposureFailure = validateExposure(context.req.raw, options.security ?? {});
    if (exposureFailure !== undefined) {
      return exposureFailure;
    }

    const unauthorized = await options.security?.authorize?.(context.req.raw);
    if (unauthorized !== undefined) {
      return unauthorized;
    }

    return await next();
  });

  app.get(`${routePrefix}/health`, async (context) => context.json(await plugin.health(routePrefix)));
  app.get(`${routePrefix}/session`, (context) =>
    context.json({ sessionToken: options.security?.sessionToken ?? plugin.sessionToken }),
  );
  app.get(`${routePrefix}/config`, async (context) => context.json(await plugin.getConfig()));
  app.post(`${routePrefix}/config/preview`, async (context) => {
    const blocked = await authorizeMutation(context.req.raw, plugin.sessionToken, options.security);
    if (blocked !== undefined) {
      return blocked;
    }
    return context.json(await plugin.previewConfig(await readJsonBody<WebUiConfigPreviewInput>(context.req.raw)));
  });
  app.post(`${routePrefix}/config/apply`, async (context) => {
    const blocked = await authorizeMutation(context.req.raw, plugin.sessionToken, options.security);
    if (blocked !== undefined) {
      return blocked;
    }
    return context.json(await plugin.applyConfig(await readJsonBody<WebUiConfigApplyInput>(context.req.raw)));
  });
  app.get(`${routePrefix}/templates`, (context) => context.json({ templates: plugin.listTemplates() }));
  app.get(`${routePrefix}/templates/:id`, (context) => {
    const template = plugin.getTemplate(context.req.param("id"));
    return template === undefined ? context.json({ error: "Template not found." }, 404) : context.json(template);
  });
  app.post(`${routePrefix}/templates/:id/apply`, async (context) => {
    const blocked = await authorizeMutation(context.req.raw, plugin.sessionToken, options.security);
    if (blocked !== undefined) {
      return blocked;
    }
    return context.json(
      await plugin.applyTemplate(
        context.req.param("id"),
        await readJsonBody<WebUiTemplateApplyInput>(context.req.raw),
      ),
    );
  });
  app.get(`${routePrefix}/chat/threads`, async (context) =>
    context.json({ threads: await plugin.listThreads() }),
  );
  app.get(`${routePrefix}/chat/threads/:id`, async (context) => {
    const thread = await plugin.getThread(context.req.param("id"));
    return thread === undefined ? context.json({ error: "Thread not found." }, 404) : context.json(thread);
  });
  app.post(`${routePrefix}/chat/threads/:id/messages`, async (context) => {
    const blocked = await authorizeMutation(context.req.raw, plugin.sessionToken, options.security);
    if (blocked !== undefined) {
      return blocked;
    }
    return context.json(
      await plugin.postMessage(
        context.req.param("id"),
        await readJsonBody<WebUiPostMessageInput>(context.req.raw),
        context.req.raw.signal,
      ),
    );
  });
  app.post(`${routePrefix}/chat/threads/:id/interrupt`, async (context) => {
    const blocked = await authorizeMutation(context.req.raw, plugin.sessionToken, options.security);
    if (blocked !== undefined) {
      return blocked;
    }
    const thread = await plugin.interruptThread(context.req.param("id"));
    return thread === undefined ? context.json({ error: "Thread not found." }, 404) : context.json(thread);
  });
  app.get(`${routePrefix}/chat/threads/:id/events`, async (context) => {
    const lastEventId = context.req.raw.headers.get("last-event-id");
    const fromQuery = context.req.query("fromSequence");
    const fromSequence = Number.parseInt(fromQuery ?? lastEventId ?? "0", 10);
    const events = plugin.streamThreadEvents(
      context.req.param("id"),
      Number.isFinite(fromSequence) ? fromSequence : 0,
    );

    return createHonoSseResponse(toSseChunks(events), context.req.raw.signal);
  });

  return Object.freeze({
    name,
    kind: "web-ui-hono" as const,
    routePrefix,
    app,
    fetch: app.fetch,
    sessionToken: plugin.sessionToken,
  });
}

async function* toSseChunks(events: AsyncIterable<WebUiChatEvent>): AsyncIterable<HonoStreamChunk> {
  for await (const event of events) {
    yield {
      id: String(event.sequence),
      event: event.type,
      data: event,
    };
  }
}

async function readJsonBody<TValue>(request: Request): Promise<TValue> {
  const raw = await request.text();
  return (raw.trim().length === 0 ? {} : JSON.parse(raw)) as TValue;
}

async function authorizeMutation(
  request: Request,
  sessionToken: string,
  security: WebUiTransportSecurityOptions = {},
): Promise<Response | undefined> {
  if (SAFE_METHODS.has(request.method)) {
    return undefined;
  }

  const originFailure = validateOrigin(request);
  if (originFailure !== undefined) {
    return originFailure;
  }

  const token = security.sessionToken ?? sessionToken;
  const headerToken = request.headers.get("x-generic-ai-web-ui-token");
  const authorization = request.headers.get("authorization");
  if (headerToken === token || authorization === `Bearer ${token}`) {
    return undefined;
  }

  return jsonError("Missing or invalid local web UI session token.", 403);
}

function validateExposure(
  request: Request,
  security: WebUiTransportSecurityOptions,
): Response | undefined {
  const url = new URL(request.url);
  if (isLoopbackHostname(url.hostname)) {
    return undefined;
  }

  if (security.allowRemote === true && security.authorize !== undefined) {
    return undefined;
  }

  return jsonError("Web UI refuses non-loopback requests without explicit authorize and allowRemote.", 403);
}

function validateOrigin(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return undefined;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return jsonError("Invalid Origin header.", 403);
  }

  const requestUrl = new URL(request.url);
  if (originUrl.protocol === requestUrl.protocol && originUrl.host === requestUrl.host) {
    return undefined;
  }

  return jsonError("Cross-origin mutation rejected by the Generic AI web UI.", 403);
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.startsWith("127.")
  );
}

function normalizeRoutePrefix(routePrefix: string): string {
  const trimmed = routePrefix.trim();
  if (trimmed.length === 0 || trimmed === "/") {
    return "";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function formatStorageKey(key: StorageKey): string {
  return `${key.namespace}:${key.collection}:${key.id}`;
}

function toTemplateSummary(template: WebUiTemplateDefinition): WebUiTemplateSummary {
  return {
    id: template.id,
    label: template.label,
    summary: template.summary,
    status: template.status,
    effects: template.effects,
    ...(template.previewReason === undefined ? {} : { previewReason: template.previewReason }),
  };
}
