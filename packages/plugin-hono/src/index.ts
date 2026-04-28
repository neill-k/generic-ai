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
  readonly mode: "health" | "sync" | "stream";
  readonly signal: AbortSignal;
}

export interface HonoAuthorizeContext extends HonoRunContext {
  readonly request: Request;
}

export type HonoAuthorizeHandler = (
  context: HonoAuthorizeContext,
) => Promise<Response | undefined> | Response | undefined;

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
  readonly health?: (context: HonoRunContext) => Promise<unknown> | unknown;
  readonly authorize?: HonoAuthorizeHandler;
  readonly run: HonoRunHandler;
  readonly stream?: HonoStreamHandler;
  readonly createRequestId?: () => string;
  readonly maxBodyBytes?: number;
}

export interface HonoPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly routePrefix: string;
  readonly app: Hono;
  readonly fetch: Hono["fetch"];
}

function normalizeRoutePrefix(routePrefix: string | undefined): string {
  if (routePrefix === undefined) {
    return "";
  }

  const trimmed = routePrefix.trim();
  if (trimmed.length === 0 || trimmed === "/") {
    return "";
  }

  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
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

class InvalidRequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestBodyError";
  }
}

function normalizeMaxBodyBytes(value: number | undefined): number {
  const normalized = value ?? 1_048_576;
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error("maxBodyBytes must be a positive integer.");
  }

  return normalized;
}

async function readRequestText(request: Request, maxBodyBytes: number): Promise<string> {
  const body = request.body;
  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let rawBody = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        throw new InvalidRequestBodyError(`Request body exceeds the ${maxBodyBytes} byte limit.`);
      }

      rawBody += decoder.decode(value, { stream: true });
    }

    rawBody += decoder.decode();
    return rawBody;
  } finally {
    reader.releaseLock();
  }
}

async function readPayload(request: Request, maxBodyBytes: number): Promise<HonoRunPayload> {
  const rawBody = await readRequestText(request, maxBodyBytes);

  if (rawBody.trim().length === 0) {
    return {
      input: undefined,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    throw new InvalidRequestBodyError("Request body is not valid JSON.");
  }

  if (isPlainObject(body) && "input" in body) {
    return {
      input: body["input"],
      ...(isPlainObject(body["metadata"]) ? { metadata: body["metadata"] } : {}),
    };
  }

  return {
    input: body,
  };
}

export function serializeHonoSseChunk(chunk: HonoStreamChunk): string {
  const lines: string[] = [];

  if (chunk.id !== undefined) {
    lines.push(`id: ${chunk.id}`);
  }

  if (chunk.event !== undefined) {
    lines.push(`event: ${chunk.event}`);
  }

  // JSON.stringify(undefined) returns `undefined`, which would then blow up on
  // `.split()`. Emit an empty SSE data frame for nullish payloads so handlers
  // that yield `data: undefined` don't crash the stream.
  const payload =
    chunk.data === undefined || chunk.data === null
      ? ""
      : typeof chunk.data === "string"
        ? chunk.data
        : JSON.stringify(chunk.data, undefined, 2);
  for (const line of payload.split(/\r?\n/)) {
    lines.push(`data: ${line}`);
  }

  lines.push("", "");
  return lines.join("\n");
}

export function createHonoSseResponse(
  stream: AsyncIterable<HonoStreamChunk>,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const iterator = stream[Symbol.asyncIterator]();

  async function cleanup(): Promise<void> {
    try {
      await iterator.return?.();
    } catch {
      // Ignore cleanup failures - we're already aborting.
    }
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const onAbort = (): void => {
          void cleanup();
        };

        if (signal.aborted) {
          onAbort();
          controller.close();
          return;
        }

        signal.addEventListener("abort", onAbort, { once: true });

        try {
          while (true) {
            if (signal.aborted) {
              break;
            }

            const next = await iterator.next();
            if (next.done) {
              break;
            }

            controller.enqueue(encoder.encode(serializeHonoSseChunk(next.value)));
          }

          controller.close();
        } catch (error) {
          controller.error(error);
          await cleanup();
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
      async cancel() {
        await cleanup();
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

async function authorizeRequest(
  authorize: HonoAuthorizeHandler | undefined,
  context: HonoAuthorizeContext,
): Promise<Response | undefined> {
  if (authorize === undefined) {
    return undefined;
  }

  return await authorize(context);
}

export function createHonoPlugin(options: HonoPluginOptions): HonoPlugin {
  const routePrefix = normalizeRoutePrefix(options.routePrefix);
  const createRequestId = options.createRequestId ?? randomUUID;
  const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes);
  const app = new Hono();

  app.get(`${routePrefix}/health`, async (context) => {
    const requestId = createRequestId();
    const result =
      options.health === undefined
        ? {
            transport: name,
            streaming: options.stream !== undefined,
          }
        : await options.health({
            requestId,
            mode: "health",
            signal: context.req.raw.signal,
          });

    return context.json(result);
  });

  app.post(`${routePrefix}/run`, async (context) => {
    const requestId = createRequestId();
    const unauthorized = await authorizeRequest(options.authorize, {
      request: context.req.raw.clone(),
      requestId,
      mode: "sync",
      signal: context.req.raw.signal,
    });
    if (unauthorized !== undefined) {
      return unauthorized;
    }

    let payload: HonoRunPayload;
    try {
      payload = await readPayload(context.req.raw, maxBodyBytes);
    } catch (error) {
      if (error instanceof InvalidRequestBodyError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }

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

    const requestId = createRequestId();
    const unauthorized = await authorizeRequest(options.authorize, {
      request: context.req.raw.clone(),
      requestId,
      mode: "stream",
      signal: context.req.raw.signal,
    });
    if (unauthorized !== undefined) {
      return unauthorized;
    }

    let payload: HonoRunPayload;
    try {
      payload = await readPayload(context.req.raw, maxBodyBytes);
    } catch (error) {
      if (error instanceof InvalidRequestBodyError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }

    const stream = await options.stream(payload, {
      requestId,
      mode: "stream",
      signal: context.req.raw.signal,
    });

    return createHonoSseResponse(stream, context.req.raw.signal);
  });

  return Object.freeze({
    name,
    kind,
    routePrefix,
    app,
    fetch: app.fetch,
  });
}
