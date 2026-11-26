import {
  type ApprovalListFilter,
  type ApprovalRequest,
  type ApprovalServiceContract,
  type ApprovalServiceEvent,
  type ApprovalStatus,
  AUTH_SCOPES,
  type AuthContext,
  type Awaitable,
  hasAuthScope,
  isApprovalError,
  type RunActor,
  toRunActor,
} from "@generic-ai/sdk";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";

/**
 * HTTP API for the owner's approval inbox. The dashboard (roadmap R14) and any
 * other client use it to list requests, read a request's audit trail, decide,
 * and follow changes live over server-sent events.
 *
 * | Method | Path | Scope |
 * | --- | --- | --- |
 * | GET | `/approvals?status=pending&taskId=&rootTaskId=&agentId=&limit=` | `runs:read` |
 * | GET | `/approvals/stream` (SSE) | `runs:read` |
 * | GET | `/approvals/:id` (request plus `events`) | `runs:read` |
 * | POST | `/approvals/:id/approve` `{ "comment"?: string }` | `approvals:decide` |
 * | POST | `/approvals/:id/reject` `{ "comment"?: string }` | `approvals:decide` |
 */
export interface ApprovalRoutesOptions {
  /**
   * Resolves the caller, for example
   * `(request) => authenticateOwnerRequest(ownerAuth, request)` from
   * `@generic-ai/plugin-auth-identity`. Required unless `allowUnauthenticated`.
   */
  readonly authenticate?: (request: Request) => Awaitable<AuthContext | undefined>;
  /**
   * Local development only: accept unauthenticated callers and record
   * decisions as `localActor`.
   */
  readonly allowUnauthenticated?: boolean;
  readonly localActor?: RunActor;
  /** Where the routes are mounted. Defaults to `/approvals`. */
  readonly routePrefix?: string;
  /** Called after every decision, for example to resume the waiting task right away. */
  readonly onDecided?: (approval: ApprovalRequest) => Awaitable<void>;
  /** SSE keep-alive interval. Defaults to 15 seconds. */
  readonly keepAliveMs?: number;
}

const STATUSES = new Set<ApprovalStatus>([
  "pending",
  "approved",
  "rejected",
  "denied",
  "expired",
  "cancelled",
]);

const LOCAL_ACTOR: RunActor = Object.freeze({
  subjectId: "local-owner",
  actorType: "human",
  credentialSource: "custom",
  displayName: "Local owner",
});

const MAX_COMMENT_CHARS = 2000;

function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "/approvals").trim();
  if (trimmed === "" || trimmed === "/") {
    return "";
  }
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return leading.endsWith("/") ? leading.slice(0, -1) : leading;
}

function parseFilter(c: Context): ApprovalListFilter | string {
  const statuses = c.req.queries("status")?.flatMap((value) => value.split(",")) ?? [];
  for (const status of statuses) {
    if (!STATUSES.has(status as ApprovalStatus)) {
      return `Unknown status "${status}".`;
    }
  }
  const limitText = c.req.query("limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
    return "limit must be a whole number from 1 to 500.";
  }
  const pick = (name: string) => {
    const value = c.req.query(name);
    return value === undefined || value === "" ? undefined : value;
  };
  const taskId = pick("taskId");
  const rootTaskId = pick("rootTaskId");
  const agentId = pick("agentId");
  const createdBefore = pick("createdBefore");
  return {
    ...(statuses.length === 0 ? {} : { status: statuses as ApprovalStatus[] }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(rootTaskId === undefined ? {} : { rootTaskId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(createdBefore === undefined ? {} : { createdBefore }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function createApprovalRoutes(
  service: ApprovalServiceContract,
  options: ApprovalRoutesOptions = {},
): Hono {
  if (options.authenticate === undefined && options.allowUnauthenticated !== true) {
    throw new Error(
      "createApprovalRoutes needs an authenticate function, or allowUnauthenticated for local development.",
    );
  }
  const prefix = normalizePrefix(options.routePrefix);
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const app = new Hono();

  async function authorize(c: Context, scope: string): Promise<RunActor | Response> {
    if (options.authenticate === undefined) {
      return options.localActor ?? LOCAL_ACTOR;
    }
    const context = await options.authenticate(c.req.raw);
    if (context === undefined) {
      return c.json({ error: "Sign in to continue." }, 401);
    }
    if (!hasAuthScope(context, scope)) {
      return c.json({ error: `This credential lacks the ${scope} scope.` }, 403);
    }
    return toRunActor(context);
  }

  app.get(`${prefix}/stream`, async (c) => {
    const actor = await authorize(c, AUTH_SCOPES.runsRead);
    if (actor instanceof Response) {
      return actor;
    }
    return streamSSE(c, async (stream) => {
      const queue: ApprovalServiceEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = service.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!stream.aborted) {
          const event = queue.shift();
          if (event === undefined) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, keepAliveMs);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = undefined;
            if (queue.length === 0 && !stream.aborted) {
              await stream.writeSSE({ event: "ping", data: "{}" });
            }
            continue;
          }
          await stream.writeSSE({
            event: event.type,
            id: `${event.approval.approvalId}:${event.approval.version}`,
            data: JSON.stringify(event.approval),
          });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.get(prefix === "" ? "/" : prefix, async (c) => {
    const actor = await authorize(c, AUTH_SCOPES.runsRead);
    if (actor instanceof Response) {
      return actor;
    }
    const filter = parseFilter(c);
    if (typeof filter === "string") {
      return c.json({ error: filter }, 400);
    }
    const approvals = await service.list(filter);
    return c.json({ approvals });
  });

  app.get(`${prefix}/:id`, async (c) => {
    const actor = await authorize(c, AUTH_SCOPES.runsRead);
    if (actor instanceof Response) {
      return actor;
    }
    const approval = await service.get(c.req.param("id"));
    if (approval === undefined) {
      return c.json({ error: "No such approval request." }, 404);
    }
    const events = await service.history(approval.approvalId);
    return c.json({ approval, events });
  });

  const decide = (decision: "approved" | "rejected") => async (c: Context) => {
    const actor = await authorize(c, AUTH_SCOPES.approvalsDecide);
    if (actor instanceof Response) {
      return actor;
    }
    let comment: string | undefined;
    const text = await c.req.text();
    if (text.trim() !== "") {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: "Body must be JSON." }, 400);
      }
      const raw = (body as { comment?: unknown } | null)?.comment;
      if (raw !== undefined && typeof raw !== "string") {
        return c.json({ error: "comment must be a string." }, 400);
      }
      if (typeof raw === "string" && raw.length > MAX_COMMENT_CHARS) {
        return c.json({ error: `comment is limited to ${MAX_COMMENT_CHARS} characters.` }, 400);
      }
      comment = raw;
    }
    try {
      const approval = await service.decide({
        approvalId: c.req.param("id") ?? "",
        decision,
        actor,
        ...(comment === undefined ? {} : { comment }),
      });
      await options.onDecided?.(approval);
      return c.json({ approval });
    } catch (error) {
      if (isApprovalError(error, "NOT_FOUND")) {
        return c.json({ error: "No such approval request." }, 404);
      }
      if (isApprovalError(error, "ALREADY_DECIDED")) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  };

  const limit = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: "Body is too large." }, 413),
  });
  app.post(`${prefix}/:id/approve`, limit, decide("approved"));
  app.post(`${prefix}/:id/reject`, limit, decide("rejected"));

  return app;
}
