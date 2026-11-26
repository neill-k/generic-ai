import type { AgentTaskStatus } from "@generic-ai/plugin-delegation";
import { AUTH_SCOPES, type AuthContext, hasAuthScope, toRunActor } from "@generic-ai/sdk";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { CompanyEvent } from "./events.js";
import { BOARD_COLUMNS, type CompanyRuntime, summarizeTask } from "./runtime.js";

/**
 * The Generic Corp HTTP API (roadmap R13). JSON over Hono, mounted at
 * `/api`, plus `/api/events` for live server-sent events.
 *
 * Every route needs an authenticated owner: reads need `runs:read`, anything
 * that starts or stops work needs `runs:execute`.
 */
export type CompanyApiAuthenticate = (
  request: Request,
) => Promise<AuthContext | Response> | AuthContext | Response;

export interface CompanyApiOptions {
  readonly authenticate: CompanyApiAuthenticate;
  /** Largest JSON body accepted. Defaults to 256 KiB. */
  readonly maxBodyBytes?: number;
  /** SSE keep-alive interval. Defaults to 15 seconds. */
  readonly keepAliveMs?: number;
}

export const API_ROUTE_PREFIX = "/api" as const;

type ApiEnv = { Variables: { auth: AuthContext } };

const TASK_STATUSES: ReadonlySet<string> = new Set(BOARD_COLUMNS);
const MAX_MESSAGE_CHARS = 32_000;

class ApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

function errorResponse(c: Context, status: number, message: string) {
  return c.json({ error: message }, status as 400);
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    const text = await c.req.text();
    parsed = text.trim().length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, "The request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function readMessageText(body: Record<string, unknown>): string {
  const text = body["text"];
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ApiError(400, 'Send the message as {"text": "..."}.');
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new ApiError(413, `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
  }
  return text;
}

function readLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(400, "limit must be a positive integer.");
  }
  return Math.min(value, max);
}

function readStatuses(raw: string | undefined): AgentTaskStatus[] | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const statuses = raw.split(",").map((value) => value.trim());
  for (const status of statuses) {
    if (!TASK_STATUSES.has(status)) {
      throw new ApiError(400, `Unknown task status "${status}".`);
    }
  }
  return statuses as AgentTaskStatus[];
}

function sseFrame(event: CompanyEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ at: event.at, ...event.data })}\n\n`;
}

export function createCompanyApi(
  runtime: CompanyRuntime,
  options: CompanyApiOptions,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const keepAliveMs = options.keepAliveMs ?? 15_000;

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return errorResponse(c, error.status, error.message);
    }
    if (error instanceof RangeError) {
      return errorResponse(c, 404, error.message);
    }
    return errorResponse(c, 500, "Something went wrong. Check the server log.");
  });

  app.use(
    "*",
    bodyLimit({
      maxSize: options.maxBodyBytes ?? 256 * 1024,
      onError: (c) => errorResponse(c, 413, "The request body is too large."),
    }),
  );

  app.use("*", async (c, next) => {
    const result = await options.authenticate(c.req.raw);
    if (result instanceof Response) {
      return result;
    }
    const method = c.req.method.toUpperCase();
    const scope =
      method === "GET" || method === "HEAD" ? AUTH_SCOPES.runsRead : AUTH_SCOPES.runsExecute;
    if (!hasAuthScope(result, scope)) {
      return errorResponse(c, 403, `This credential lacks the "${scope}" scope.`);
    }
    c.set("auth", result);
    await next();
    c.header("cache-control", "no-store");
    return undefined;
  });

  app.get("/company", (c) =>
    c.json({
      name: runtime.company.name,
      ...(runtime.company.mission === undefined ? {} : { mission: runtime.company.mission }),
      ceoId: runtime.ceoId,
      storage: runtime.storage.driver,
    }),
  );

  // --- Agents and the org chart -------------------------------------------

  app.get("/agents", async (c) => c.json({ agents: await runtime.listAgents() }));

  app.get("/org-chart", async (c) => c.json({ root: await runtime.orgChart() }));

  app.get("/agents/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = await runtime.directory.get(agentId);
    if (agent === undefined) {
      throw new ApiError(404, `Agent ${agentId} was not found.`);
    }
    const [memory, tasks, reports, chain] = await Promise.all([
      runtime.readMemory(agentId).catch(() => ""),
      runtime.listTasks({ agentId, limit: 50 }),
      runtime.directory.directReports(agentId),
      runtime.directory.managementChain(agentId),
    ]);
    return c.json({
      agent,
      memory,
      reports: reports.map((report) => report.id),
      managementChain: chain.map((manager) => manager.id),
      tasks: tasks.map(summarizeTask),
    });
  });

  app.get("/agents/:agentId/costs", async (c) =>
    c.json(await runtime.costs({ agentId: c.req.param("agentId") })),
  );

  // --- Chat with the CEO ---------------------------------------------------

  app.get("/threads", async (c) => c.json({ threads: await runtime.listThreads() }));

  app.post("/threads", async (c) => {
    const text = readMessageText(await readJsonObject(c));
    const { thread, task } = await runtime.sendMessage({
      text,
      actor: toRunActor(c.get("auth")),
    });
    return c.json({ thread, taskId: task.taskId }, 201);
  });

  app.get("/threads/:threadId", async (c) => {
    const thread = await runtime.getThread(c.req.param("threadId"));
    if (thread === undefined) {
      throw new ApiError(404, "Thread not found.");
    }
    return c.json({ thread });
  });

  app.post("/threads/:threadId/messages", async (c) => {
    const text = readMessageText(await readJsonObject(c));
    const { thread, task } = await runtime.sendMessage({
      text,
      threadId: c.req.param("threadId"),
      actor: toRunActor(c.get("auth")),
    });
    return c.json({ thread, taskId: task.taskId }, 201);
  });

  app.patch("/threads/:threadId", async (c) => {
    const body = await readJsonObject(c);
    const title = body["title"];
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new ApiError(400, 'Send the new title as {"title": "..."}.');
    }
    const threadId = c.req.param("threadId");
    if ((await runtime.threads.get(threadId)) === undefined) {
      throw new ApiError(404, "Thread not found.");
    }
    await runtime.threads.rename(threadId, title);
    return c.json({ thread: await runtime.getThread(threadId) });
  });

  // --- Tasks and the board -------------------------------------------------

  app.get("/tasks", async (c) => {
    const statuses = readStatuses(c.req.query("status"));
    const agentId = c.req.query("agentId");
    const tasks = await runtime.listTasks({
      ...(statuses === undefined ? {} : { status: statuses }),
      ...(agentId === undefined ? {} : { agentId }),
      rootOnly: c.req.query("root") === "1" || c.req.query("root") === "true",
      limit: readLimit(c.req.query("limit"), 100, 1000),
    });
    return c.json({ tasks: tasks.map(summarizeTask) });
  });

  app.get("/tasks/:taskId", async (c) => {
    const task = await runtime.cascade.get(c.req.param("taskId"));
    if (task === undefined) {
      throw new ApiError(404, "Task not found.");
    }
    const children = await runtime.cascade.children(task.taskId);
    return c.json({ task, children: children.map(summarizeTask) });
  });

  app.get("/tasks/:taskId/tree", async (c) => {
    const task = await runtime.cascade.get(c.req.param("taskId"));
    if (task === undefined) {
      throw new ApiError(404, "Task not found.");
    }
    const tree = await runtime.cascade.tree(task.rootTaskId);
    return c.json({ rootTaskId: task.rootTaskId, tasks: tree.map(summarizeTask) });
  });

  app.get("/tasks/:taskId/events", async (c) => {
    const task = await runtime.cascade.get(c.req.param("taskId"));
    if (task === undefined) {
      throw new ApiError(404, "Task not found.");
    }
    const taskEvents = await runtime.storage.runStore.readEvents(task.taskId);
    const runs = await Promise.all(
      task.runIds.map(async (runId) => ({
        runId,
        events: await runtime.storage.runStore.readEvents(runId),
      })),
    );
    return c.json({ taskId: task.taskId, events: taskEvents, runs });
  });

  app.post("/tasks/:taskId/cancel", async (c) => {
    const body = await readJsonObject(c);
    const reason = typeof body["reason"] === "string" ? body["reason"] : "Cancelled by the owner.";
    const taskId = c.req.param("taskId");
    if ((await runtime.cascade.get(taskId)) === undefined) {
      throw new ApiError(404, "Task not found.");
    }
    const cancelled = await runtime.cascade.cancel(taskId, reason);
    return c.json({ cancelled, task: await runtime.cascade.get(taskId) });
  });

  app.get("/board", async (c) =>
    c.json({ columns: await runtime.board({ limit: readLimit(c.req.query("limit"), 300, 2000) }) }),
  );

  // --- Costs ----------------------------------------------------------------

  app.get("/costs", async (c) =>
    c.json(await runtime.costs({ limit: readLimit(c.req.query("limit"), 1000, 10_000) })),
  );

  // --- Live events ---------------------------------------------------------

  app.get("/events", (c) => {
    const lastEventId = Number(c.req.header("last-event-id") ?? c.req.query("since") ?? "0");
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (keepAlive !== undefined) {
        clearInterval(keepAlive);
        keepAlive = undefined;
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            close();
          }
        };
        send(`retry: 3000\n: connected ${runtime.events.lastId}\n\n`);
        if (Number.isInteger(lastEventId) && lastEventId > 0) {
          for (const event of runtime.events.since(lastEventId)) {
            send(sseFrame(event));
          }
        }
        unsubscribe = runtime.events.subscribe((event) => send(sseFrame(event)));
        keepAlive = setInterval(() => send(": keep-alive\n\n"), keepAliveMs);
        c.req.raw.signal.addEventListener("abort", () => {
          close();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      },
      cancel: close,
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  app.notFound((c) => errorResponse(c, 404, "Not found."));

  return app;
}
