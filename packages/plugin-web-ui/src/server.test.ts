import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHonoWebUiTransport, createWebUiPlugin } from "./server.js";

const TRUSTED_PEER_ADDRESS_SYMBOL = Symbol.for("@generic-ai/http.peerAddress");

function localRequest(path: string, init?: RequestInit): Request {
  const request = new Request(`http://localhost${path}`, init);
  Object.defineProperty(request, TRUSTED_PEER_ADDRESS_SYMBOL, {
    enumerable: false,
    value: "127.0.0.1",
  });
  return request;
}

function remoteRequest(path: string, init?: RequestInit): Request {
  const request = new Request(`http://localhost${path}`, init);
  Object.defineProperty(request, TRUSTED_PEER_ADDRESS_SYMBOL, {
    enumerable: false,
    value: "203.0.113.10",
  });
  return request;
}

async function seedWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "generic-ai-web-ui-"));
  await mkdir(join(root, ".generic-ai", "agents"), { recursive: true });
  await writeFile(
    join(root, ".generic-ai", "framework.yaml"),
    ["schemaVersion: v1", "name: Web UI fixture", "primaryAgent: starter"].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, ".generic-ai", "agents", "starter.yaml"),
    ["displayName: Starter", "model: gpt-5.5", "tools: []", "plugins: []"].join("\n"),
    "utf8",
  );
  return root;
}

describe("@generic-ai/plugin-web-ui server", () => {
  it("serves health, config, and the bounded template catalog", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({ workspaceRoot: root, sessionToken: "test-token" });
    const transport = createHonoWebUiTransport(plugin);

    const health = await transport.app.request(localRequest("/console/api/health"));
    expect(await health.json()).toMatchObject({
      plugin: "@generic-ai/plugin-web-ui",
      config: {
        ok: true,
        primaryAgent: "starter",
      },
      templates: {
        total: 11,
        runnable: 5,
        preview: 6,
      },
    });

    const templates = (await (
      await transport.app.request(localRequest("/console/api/templates"))
    ).json()) as {
      templates: Array<{ id: string; status: string }>;
    };
    expect(templates.templates.find((template) => template.id === "hierarchical")?.status).toBe(
      "runnable",
    );
    expect(
      templates.templates.find((template) => template.id === "codex-cli-agent-loop")?.status,
    ).toBe("runnable");
    expect(templates.templates.find((template) => template.id === "blackboard")?.status).toBe(
      "preview",
    );
  });

  it("requires token and same-origin headers for mutating routes", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({ workspaceRoot: root, sessionToken: "test-token" });
    const transport = createHonoWebUiTransport(plugin);

    const missingToken = await transport.app.request(
      localRequest("/console/api/templates/hierarchical/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      }),
    );
    expect(missingToken.status).toBe(403);

    const badOrigin = await transport.app.request(
      localRequest("/console/api/templates/hierarchical/apply", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://example.test",
          "x-generic-ai-web-ui-token": "test-token",
        },
        body: JSON.stringify({ dryRun: true }),
      }),
    );
    expect(badOrigin.status).toBe(403);

    const ok = await transport.app.request(
      localRequest("/console/api/templates/hierarchical/apply", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          "x-generic-ai-web-ui-token": "test-token",
        },
        body: JSON.stringify({ dryRun: true }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
  });

  it("rejects Host-spoofed non-loopback requests without remote authorization", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({ workspaceRoot: root, sessionToken: "test-token" });
    const transport = createHonoWebUiTransport(plugin);

    const session = await transport.app.request(remoteRequest("/console/api/session"));
    expect(session.status).toBe(403);
    expect(await session.json()).toMatchObject({
      error: "Web UI refuses non-loopback requests without explicit authorize and allowRemote.",
    });
  });

  it("applies runnable templates only with an idempotency key", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({ workspaceRoot: root, sessionToken: "test-token" });

    const previewOnly = await plugin.applyTemplate("blackboard", { dryRun: true });
    expect(previewOnly.ok).toBe(false);

    const missingKey = await plugin.applyTemplate("hierarchical", { dryRun: false });
    expect(missingKey.ok).toBe(false);

    const codexDryRun = await plugin.applyTemplate("codex-cli-agent-loop", { dryRun: true });
    expect(codexDryRun.ok).toBe(true);
    if (!codexDryRun.ok) {
      return;
    }
    expect(
      codexDryRun.plan.files.some((file) =>
        file.relativePath.endsWith(join(".generic-ai", "harnesses", "codex-cli-agent-loop.yaml")),
      ),
    ).toBe(true);

    const applied = await plugin.applyTemplate("hierarchical", {
      dryRun: false,
      idempotencyKey: "apply-hierarchical",
    });
    expect(applied.ok).toBe(true);
    expect(
      await readFile(join(root, ".generic-ai", "harnesses", "hierarchical.yaml"), "utf8"),
    ).toContain("protocol: hierarchy");

    const replayed = await plugin.applyTemplate("hierarchical", {
      dryRun: false,
      idempotencyKey: "apply-hierarchical",
    });
    expect(replayed).toEqual(applied);
  });

  it("persists chat messages and exposes replayable SSE events", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({
      workspaceRoot: root,
      sessionToken: "test-token",
      harnessRunner: ({ message }) => ({ content: `echo: ${message.content}` }),
    });
    const transport = createHonoWebUiTransport(plugin);

    const posted = await transport.app.request(
      localRequest("/console/api/chat/threads/demo/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-generic-ai-web-ui-token": "test-token",
        },
        body: JSON.stringify({ content: "hello" }),
      }),
    );
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({
      thread: { id: "demo", status: "completed" },
    });

    const iterator = plugin.streamThreadEvents("demo", 0)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    await iterator.return?.();
    expect(first.value?.type).toBe("thread.created");
    expect(second.value?.type).toBe("message.created");
  });

  it("allocates unique event sequence IDs under concurrent thread activity", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({
      workspaceRoot: root,
      sessionToken: "test-token",
      harnessRunner: ({ message }) => ({ content: `done: ${message.content}` }),
    });

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        plugin.postMessage(
          "concurrent",
          { content: `message ${index}` },
          new AbortController().signal,
        ),
      ),
    );

    const detail = await plugin.getThread("concurrent");
    expect(detail).toBeDefined();
    const events = detail?.events ?? [];
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
  });

  it("keeps stored agent selection sticky when later messages omit it", async () => {
    const root = await seedWorkspace();
    await writeFile(
      join(root, ".generic-ai", "framework.yaml"),
      ["schemaVersion: v1", "name: Web UI fixture", "primaryAgent: other"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, ".generic-ai", "agents", "other.yaml"),
      ["displayName: Other", "model: gpt-5.5", "tools: []", "plugins: []"].join("\n"),
      "utf8",
    );
    const selectedAgentIds: Array<string | undefined> = [];
    const plugin = createWebUiPlugin({
      workspaceRoot: root,
      sessionToken: "test-token",
      harnessRunner: ({ agent, message }) => {
        selectedAgentIds.push(agent?.id);
        return { content: `handled: ${message.content}` };
      },
    });

    await plugin.postMessage(
      "sticky",
      { content: "first", selectedAgentId: "starter" },
      new AbortController().signal,
    );
    await plugin.postMessage("sticky", { content: "second" }, new AbortController().signal);

    expect(selectedAgentIds).toEqual(["starter", "starter"]);
    expect((await plugin.getThread("sticky"))?.thread).toMatchObject({
      selectedAgentId: "starter",
    });
  });

  it("passes request aborts and manual interrupts through one runner signal", async () => {
    const root = await seedWorkspace();
    const requestAbort = new AbortController();
    let runnerSignal: AbortSignal | undefined;
    let resolveRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolveStarted) => {
      resolveRunnerStarted = resolveStarted;
    });
    const plugin = createWebUiPlugin({
      workspaceRoot: root,
      sessionToken: "test-token",
      harnessRunner: ({ signal }) => {
        runnerSignal = signal;
        resolveRunnerStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("runner aborted")), {
            once: true,
          });
        });
      },
    });

    const posted = plugin.postMessage("abort", { content: "long" }, requestAbort.signal);
    await runnerStarted;
    requestAbort.abort();
    const detail = await posted;

    expect(runnerSignal?.aborted).toBe(true);
    expect(detail.thread.status).toBe("interrupted");
  });

  it("returns a 400 for invalid JSON request bodies", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({ workspaceRoot: root, sessionToken: "test-token" });
    const transport = createHonoWebUiTransport(plugin);

    const response = await transport.app.request(
      localRequest("/console/api/chat/threads/bad-json/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-generic-ai-web-ui-token": "test-token",
        },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid JSON request body." });
  });

  it("stores a visible assistant error when the runner fails", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({
      workspaceRoot: root,
      sessionToken: "test-token",
      harnessRunner: () => {
        throw new Error("provider credentials missing");
      },
    });
    const transport = createHonoWebUiTransport(plugin);

    const posted = await transport.app.request(
      localRequest("/console/api/chat/threads/failing/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-generic-ai-web-ui-token": "test-token",
        },
        body: JSON.stringify({ content: "hello" }),
      }),
    );

    expect(posted.status).toBe(200);
    const detail = (await posted.json()) as {
      readonly thread: { readonly status: string };
      readonly messages: readonly { readonly role: string; readonly content: string }[];
      readonly events: readonly {
        readonly type: string;
        readonly data: { readonly message?: string };
      }[];
    };
    expect(detail.thread.status).toBe("failed");
    expect(detail.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "hello" }),
        expect.objectContaining({
          role: "assistant",
          content: "Run failed: provider credentials missing",
        }),
      ]),
    );
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.failed",
          data: { message: "Run failed: provider credentials missing" },
        }),
      ]),
    );
  });
});
