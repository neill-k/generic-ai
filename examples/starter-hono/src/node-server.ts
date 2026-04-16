import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";

export interface StartFetchServerOptions {
  readonly host: string;
  readonly port: number;
}

export interface StartedFetchServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

type FetchHandler = (request: Request) => Promise<Response> | Response;

function toHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    result.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  return result;
}

async function forwardFetch(handler: FetchHandler, request: Request, response: ServerResponse) {
  const result = await handler(request);
  const responseBody = result.body;

  response.statusCode = result.status;
  response.statusMessage = result.statusText;
  result.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  if (responseBody === null) {
    response.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(responseBody);
    body.on("error", reject);
    response.on("error", reject);
    response.on("finish", () => resolve());
    body.pipe(response);
  });
}

export async function startFetchServer(
  handler: FetchHandler,
  options: StartFetchServerOptions,
): Promise<StartedFetchServer> {
  const server = createServer(async (req, res) => {
    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    try {
      const method = req.method ?? "GET";
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
      const request = new Request(
        new URL(req.url ?? "/", `http://${req.headers.host ?? `${options.host}:${options.port}`}`),
        {
          method,
          headers: toHeaders(req.headers),
          ...(body === undefined ? {} : { body, duplex: "half" as const }),
          signal: abortController.signal,
        },
      );

      await forwardFetch(handler, request, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Starter example server did not expose a TCP address.");
  }

  return Object.freeze({
    server,
    host: options.host,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  });
}
