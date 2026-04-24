import { describe, expect, it } from "vitest";

import { createHonoPlugin, kind, name } from "../src/index.js";

describe("@generic-ai/plugin-hono", () => {
  it("serves health, sync run, and streaming run routes", async () => {
    const transport = createHonoPlugin({
      routePrefix: "/starter",
      run: async (payload, context) => ({
        echo: payload.input,
        requestId: context.requestId,
      }),
      stream: async function* (payload) {
        yield {
          event: "status",
          data: {
            state: "started",
            input: payload.input,
          },
        };
        yield {
          event: "done",
          data: {
            ok: true,
          },
        };
      },
      createRequestId: () => "request-1",
    });

    const health = await transport.app.request("/starter/health");
    expect(transport.name).toBe(name);
    expect(transport.kind).toBe(kind);
    expect(await health.json()).toEqual({
      transport: name,
      streaming: true,
    });

    const run = await transport.app.request("/starter/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: {
          task: "demo",
        },
      }),
    });
    expect(await run.json()).toEqual({
      requestId: "request-1",
      transport: name,
      result: {
        echo: {
          task: "demo",
        },
        requestId: "request-1",
      },
    });

    const streamed = await transport.app.request("/starter/run/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: "demo",
      }),
    });
    const text = await streamed.text();

    expect(text).toContain("event: status");
    expect(text).toContain('"state": "started"');
    expect(text).toContain("event: done");
  });

  it("can authorize run routes without protecting health", async () => {
    const transport = createHonoPlugin({
      routePrefix: "/starter",
      authorize: ({ request }) => {
        if (request.headers.get("authorization") === "Bearer test-token") {
          return undefined;
        }

        return Response.json({ error: "Unauthorized" }, { status: 401 });
      },
      run: async () => ({ ok: true }),
      stream: async function* () {
        yield {
          event: "done",
          data: {
            ok: true,
          },
        };
      },
      createRequestId: () => "request-1",
    });

    const health = await transport.app.request("/starter/health");
    expect(health.status).toBe(200);

    const unauthorizedRun = await transport.app.request("/starter/run", {
      method: "POST",
      body: JSON.stringify({ input: "demo" }),
    });
    expect(unauthorizedRun.status).toBe(401);

    const authorizedStream = await transport.app.request("/starter/run/stream", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: "demo" }),
    });
    expect(authorizedStream.status).toBe(200);
    expect(await authorizedStream.text()).toContain("event: done");
  });

  it("passes a cloned request to authorization handlers", async () => {
    const authorizedBodies: unknown[] = [];
    const transport = createHonoPlugin({
      routePrefix: "/starter",
      authorize: async ({ request }) => {
        authorizedBodies.push(await request.json());
        return undefined;
      },
      run: async (payload) => ({ echo: payload.input }),
      stream: async function* (payload) {
        yield {
          event: "done",
          data: payload.input,
        };
      },
      createRequestId: () => "request-1",
    });

    const run = await transport.app.request("/starter/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: "sync-body" }),
    });
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({
      result: {
        echo: "sync-body",
      },
    });

    const stream = await transport.app.request("/starter/run/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: "stream-body" }),
    });
    expect(stream.status).toBe(200);
    expect(await stream.text()).toContain("stream-body");
    expect(authorizedBodies).toEqual([{ input: "sync-body" }, { input: "stream-body" }]);
  });
});
