import { randomUUID } from "node:crypto";

import { Hono } from "hono";

export const name = "@generic-ai/plugin-hono" as const;
export const kind = "transport-hono" as const;

export interface HonoRunPayload {
  readonly input: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonoRunContext {
  readonly requestId: string;
  readonly mode: "sync" | "stream";
  readonly signal: AbortSignal;
}

export interface HonoStreamChunk {
  readonly event?: string;
  readonly id?: string;
  readonly data: unknown;
}

export type HonoRunHandler = (
  payload: HonoRunPayload,
  context: HonoRunContext,
) => Promise<unknown> | unknown;

export type HonoStreamHandler = (
  payload: HonoRunPayload,
  context: HonoRunContext,
) => AsyncIterable<HonoStreamChunk> | Promise<AsyncIterable<HonoStreamChunk>>;

export interface HonoPluginOptions {
  readonly routePrefix?: string;
  readonly run: HonoRunHandler;
  readonly stream?: HonoStreamHandler;
  readonly createRequestId?: () => string;
}

export interface HonoPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly routePrefix: string;
  readonly app: Hono;
  readonly fetch: Hono["fetch"];
}

function normalizeRoutePrefix(routePrefix: string | undefined): string {
  if (routePrefix === undefined || routePrefix.trim().length === 0 || routePrefix === "/") {
    return "";
  }

  const normalized = routePrefix.startsWith("/") ? routePrefix.trim() : `/${routePrefix.trim()}`;
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

async function readPayload(request: Request): Promise<HonoRunPayload> {
  try {
    const body = await request.json();

    if (isPlainObject(body) && "input" in body) {
      return {
        input: body["input"],
        ...(isPlainObject(body["metadata"]) ? { metadata: body["metadata"] } : {}),
      };
    }

    return {
      input: body,
    };
  } catch {
    return {
      input: undefined,
    };
  }
}

function serializeChunk(chunk: HonoStreamChunk): string {
  const lines: string[] = [];

  if (chunk.id !== undefined) {
    lines.push(`id: ${chunk.id}`);
  }

  if (chunk.event !== undefined) {
    lines.push(`event: ${chunk.event}`);
  }

  const payload =
    typeof chunk.data === "string" ? chunk.data : JSON.stringify(chunk.data, undefined, 2);
  for (const line of payload.split(/\r?\n/)) {
    lines.push(`data: ${line}`);
  }

  lines.push("", "");
  return lines.join("\n");
}

function createSseResponse(stream: AsyncIterable<HonoStreamChunk>): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          controller.enqueue(encoder.encode(serializeChunk(chunk)));
        }

        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    },
  );
}

export function createHonoPlugin(options: HonoPluginOptions): HonoPlugin {
  const routePrefix = normalizeRoutePrefix(options.routePrefix);
  const createRequestId = options.createRequestId ?? randomUUID;
  const app = new Hono();

  app.get(`${routePrefix}/health`, (context) =>
    context.json({
      transport: name,
      streaming: options.stream !== undefined,
    }),
  );

  app.post(`${routePrefix}/run`, async (context) => {
    const payload = await readPayload(context.req.raw);
    const requestId = createRequestId();
    const result = await options.run(payload, {
      requestId,
      mode: "sync",
      signal: context.req.raw.signal,
    });

    return context.json({
      requestId,
      transport: name,
      result,
    });
  });

  app.post(`${routePrefix}/run/stream`, async (context) => {
    if (options.stream === undefined) {
      return context.json(
        {
          error: "Streaming is not configured for this Hono transport.",
        },
        501,
      );
    }

    const payload = await readPayload(context.req.raw);
    const requestId = createRequestId();
    const stream = await options.stream(payload, {
      requestId,
      mode: "stream",
      signal: context.req.raw.signal,
    });

    return createSseResponse(stream);
  });

  return Object.freeze({
    name,
    kind,
    routePrefix,
    app,
    fetch: app.fetch,
  });
}
