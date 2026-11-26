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

  it("rejects request bodies over the configured byte limit", async () => {
    const transport = createHonoPlugin({
      routePrefix: "/starter",
      maxBodyBytes: 16,
      run: async () => ({ ok: true }),
    });

    const response = await transport.app.request("/starter/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: "this body is too large" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body exceeds the 16 byte limit.",
    });
  });

  it("authenticates before reading the body and passes the auth context to handlers", async () => {
    const seen: unknown[] = [];
    let bodyRead = false;
    const transport = createHonoPlugin({
      authenticate: ({ request, mode }) => {
        if (request.headers.get("authorization") !== "Bearer fake-test-credential") {
          return {
            ok: false,
            response: new Response(JSON.stringify({ error: "nope" }), { status: 401 }),
          };
        }
        return {
          ok: true,
          auth: {
            subject: {
              subjectId: "owner",
              actorType: "human",
              scopes: [mode],
              claims: {},
            },
            credentialSource: "bearer",
            audit: {},
          },
        };
      },
      run: (payload, context) => {
        bodyRead = true;
        seen.push(context.auth?.subject.scopes);
        return payload.input;
      },
      stream: async function* (_payload, context) {
        seen.push(context.auth?.subject.scopes);
        yield { data: "ok" };
      },
    });

    const denied = await transport.app.request("/run", { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    expect(bodyRead).toBe(false);

    const headers = { authorization: "Bearer fake-test-credential" };
    expect((await transport.app.request("/run", { method: "POST", headers, body: "1" })).status).toBe(
      200,
    );
    const stream = await transport.app.request("/run/stream", { method: "POST", headers, body: "1" });
    await stream.text();
    expect(seen).toEqual([["sync"], ["stream"]]);
  });

  it("runs authorize before authenticate", async () => {
    let authenticated = false;
    const transport = createHonoPlugin({
      authorize: () => new Response("blocked", { status: 403 }),
      authenticate: () => {
        authenticated = true;
        return { ok: true };
      },
      run: () => "unreachable",
    });
    const response = await transport.app.request("/run", { method: "POST", body: "{}" });
    expect(response.status).toBe(403);
    expect(authenticated).toBe(false);
  });
});
