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
});
