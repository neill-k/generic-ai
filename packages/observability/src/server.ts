import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getObservabilityMetricCatalog } from "./metrics.js";
import {
  MemoryObservabilityRepository,
  SqliteObservabilityRepository,
} from "./repository.js";
import { createDeterministicObservabilityReport } from "./reports.js";
import { createObservabilityLiveEventBus } from "./sse.js";
import type { ObservabilityEventRecord, ObservabilityMetricQuery, ObservabilityRepository, ObservabilityRunListFilter } from "./types.js";
export {
  BaseObservabilityRepository,
  MemoryObservabilityRepository,
  SqliteObservabilityRepository,
  canonicalEventToObservabilityEvent,
} from "./repository.js";
export { getObservabilityMetricCatalog } from "./metrics.js";
export {
  createDeterministicObservabilityReport,
  renderObservabilityReportMarkdown,
} from "./reports.js";
export { createObservabilityLiveEventBus } from "./sse.js";
export {
  byteSize,
  metadataOnlySummary,
  redactJsonValue,
  summarizePayload,
} from "./redaction.js";
export type * from "./types.js";
export type { ObservabilityLiveEvent, ObservabilityLiveEventBus } from "./sse.js";

export interface GenericAIObservabilityRoutesOptions {
  readonly repository?: ObservabilityRepository;
  readonly workspaceId?: string;
  readonly prefix?: string;
  readonly authorize?: (request: Request) => boolean | Promise<boolean>;
  readonly localSessionToken?: string;
  readonly allowNonLoopback?: boolean;
  readonly enableMutatingRoutes?: boolean;
  readonly eventBus?: ReturnType<typeof createObservabilityLiveEventBus>;
}

export interface GenericAIObservabilityRoutes {
  readonly app: Hono;
  readonly fetch: Hono["fetch"];
  readonly repository: ObservabilityRepository;
  readonly eventBus: ReturnType<typeof createObservabilityLiveEventBus>;
  readonly localSessionToken?: string;
  readonly prefix: string;
}

export function createGenericAIObservabilityRoutes(
  options: GenericAIObservabilityRoutesOptions = {},
): GenericAIObservabilityRoutes {
  const repository = options.repository ?? new MemoryObservabilityRepository();
  const workspaceId = options.workspaceId ?? "default";
  const prefix = normalizePrefix(options.prefix ?? "");
  const app = new Hono();
  const routes = new Hono();
  const localSessionToken =
    options.authorize === undefined ? (options.localSessionToken ?? randomUUID()) : undefined;
  const eventBus = options.eventBus ?? createObservabilityLiveEventBus();

  routes.use("*", async (context, next) => {
    const security = await authorizeRequest(context.req.raw, {
      ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
      ...(localSessionToken === undefined ? {} : { localSessionToken }),
      allowNonLoopback: options.allowNonLoopback === true,
    });
    if (!security.allowed) {
      return context.json({ error: security.reason }, security.status);
    }

    return next();
  });

  routes.get("/health", (context) =>
    context.json({
      ok: true,
      package: "@generic-ai/observability",
      workspaceId,
      posture: "metadata_only",
      payloadCapture: false,
      localSessionRequired: localSessionToken !== undefined,
    }),
  );

  routes.get("/runs", async (context) => {
    const status = context.req.query("status") as ObservabilityRunListFilter["status"] | undefined;
    const from = context.req.query("from");
    const to = context.req.query("to");
    const limit = context.req.query("limit");
    const filter: ObservabilityRunListFilter = {
      workspaceId: context.req.query("workspaceId") ?? workspaceId,
      ...(status === undefined ? {} : { status }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    };
    const runs = await repository.listRuns(filter);
    return context.json({ runs });
  });

  routes.get("/runs/:id", async (context) => {
    const run = await repository.getRun(context.req.query("workspaceId") ?? workspaceId, context.req.param("id"));
    return run ? context.json({ run }) : context.json({ error: "not_found" }, 404);
  });

  routes.get("/runs/:id/events", async (context) => {
    const events = await repository.listEvents({
      workspaceId: context.req.query("workspaceId") ?? workspaceId,
      runId: context.req.param("id"),
      ...(context.req.query("fromSequence") === undefined
        ? {}
        : { fromSequence: Number(context.req.query("fromSequence")) }),
      ...(context.req.query("limit") === undefined
        ? {}
        : { limit: Number(context.req.query("limit")) }),
    });
    return context.json({ events });
  });

  routes.get("/runs/:id/trace", async (context) => {
    const trace = await repository.getTrace(
      context.req.query("workspaceId") ?? workspaceId,
      context.req.param("id"),
    );
    return trace ? context.json({ trace }) : context.json({ error: "not_found" }, 404);
  });

  routes.get("/runs/:id/report", async (context) => {
    const trace = await repository.getTrace(
      context.req.query("workspaceId") ?? workspaceId,
      context.req.param("id"),
    );
    return trace
      ? context.json({ report: createDeterministicObservabilityReport(trace) })
      : context.json({ error: "not_found" }, 404);
  });

  routes.get("/metrics/catalog", (context) =>
    context.json({ metrics: getObservabilityMetricCatalog() }),
  );

  routes.get("/metrics/query", async (context) => {
    const names = context.req.queries("name") ?? [];
    const from = context.req.query("from");
    const to = context.req.query("to");
    const limit = context.req.query("limit");
    const query: ObservabilityMetricQuery = {
      workspaceId: context.req.query("workspaceId") ?? workspaceId,
      ...(names.length === 0 ? {} : { names }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    };
    return context.json({ metrics: await repository.queryMetrics(query) });
  });

  routes.get("/events/live", (context) => {
    const fromSequence =
      context.req.query("fromSequence") === undefined
        ? undefined
        : Number(context.req.query("fromSequence"));
    return eventBus.toSseResponse(
      context.req.raw,
      fromSequence === undefined ? {} : { fromSequence },
    );
  });

  const disabledMutating = async () =>
    new Response(JSON.stringify({ error: "disabled_by_default" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  routes.post("/reports", disabledMutating);
  routes.post("/exports/otel", disabledMutating);
  routes.get("/runs/:id/payloads", disabledMutating);
  routes.post("/runs/:id/pin", async (context) => {
    if (options.enableMutatingRoutes !== true) {
      return disabledMutating();
    }
    const run = await repository.setPin(
      context.req.query("workspaceId") ?? workspaceId,
      context.req.param("id"),
      true,
    );
    return context.json({ run });
  });
  routes.post("/runs/:id/unpin", async (context) => {
    if (options.enableMutatingRoutes !== true) {
      return disabledMutating();
    }
    const run = await repository.setPin(
      context.req.query("workspaceId") ?? workspaceId,
      context.req.param("id"),
      false,
    );
    return context.json({ run });
  });

  if (prefix.length === 0) {
    app.route("/", routes);
  } else {
    app.route(prefix, routes);
  }

  return {
    app,
    fetch: app.fetch.bind(app),
    repository,
    eventBus,
    ...(localSessionToken === undefined ? {} : { localSessionToken }),
    prefix,
  };
}

export async function ingestObservabilityEvent(input: {
  readonly repository: ObservabilityRepository;
  readonly workspaceId: string;
  readonly event: ObservabilityEventRecord;
  readonly eventBus?: ReturnType<typeof createObservabilityLiveEventBus>;
}): Promise<ObservabilityEventRecord> {
  const result = await input.repository.appendEvent({
    workspaceId: input.workspaceId,
    event: input.event,
  });
  if (result.inserted) {
    input.eventBus?.publish("run.event", {
      workspaceId: result.event.workspaceId,
      runId: result.event.runId,
      eventId: result.event.id,
      sequence: result.event.sequence,
      name: result.event.name,
    });
  }
  return result.event;
}

export function createSqliteObservabilityRepository(
  options: ConstructorParameters<typeof SqliteObservabilityRepository>[0],
): SqliteObservabilityRepository {
  return new SqliteObservabilityRepository(options);
}

export function createMemoryObservabilityRepository(
  options: ConstructorParameters<typeof MemoryObservabilityRepository>[0] = {},
): MemoryObservabilityRepository {
  return new MemoryObservabilityRepository(options);
}

async function authorizeRequest(
  request: Request,
  options: {
    readonly authorize?: (request: Request) => boolean | Promise<boolean>;
    readonly localSessionToken?: string;
    readonly allowNonLoopback: boolean;
  },
): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly status: 401 | 403; readonly reason: string }> {
  if (!options.allowNonLoopback && !isLoopbackRequest(request)) {
    return { allowed: false, status: 403, reason: "loopback_required" };
  }

  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    const originCheck = hasTrustedOrigin(request);
    if (!originCheck) {
      return { allowed: false, status: 403, reason: "origin_rejected" };
    }
  }

  if (options.authorize !== undefined) {
    const allowed = await options.authorize(request);
    return allowed ? { allowed: true } : { allowed: false, status: 403, reason: "unauthorized" };
  }

  if (!options.localSessionToken || tokenFromRequest(request) !== options.localSessionToken) {
    return { allowed: false, status: 401, reason: "local_session_token_required" };
  }

  return { allowed: true };
}

function tokenFromRequest(request: Request): string | undefined {
  const headerToken = request.headers.get("x-generic-ai-observability-token");
  if (headerToken) {
    return headerToken;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  return authorization.slice("bearer ".length).trim();
}

function isLoopbackRequest(request: Request): boolean {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  return isLoopbackHost(url.hostname) && isLoopbackHost(host.split(":")[0] ?? "");
}

function hasTrustedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }

  const requestUrl = new URL(request.url);
  const originUrl = new URL(origin);
  return originUrl.hostname === requestUrl.hostname && originUrl.port === requestUrl.port;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.")
  );
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length === 0 || trimmed === "/") {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
