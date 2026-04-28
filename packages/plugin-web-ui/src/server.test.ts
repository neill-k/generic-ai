import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHonoWebUiTransport, createWebUiPlugin } from "./server.js";

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

    const health = await transport.app.request("/console/api/health");
    expect(await health.json()).toMatchObject({
      plugin: "@generic-ai/plugin-web-ui",
      config: {
        ok: true,
        primaryAgent: "starter",
      },
      templates: {
        total: 10,
        runnable: 4,
        preview: 6,
      },
    });

    const templates = (await (await transport.app.request("/console/api/templates")).json()) as {
      templates: Array<{ id: string; status: string }>;
    };
    expect(templates.templates.find((template) => template.id === "hierarchical")?.status).toBe(
      "runnable",
    );
    expect(templates.templates.find((template) => template.id === "blackboard")?.status).toBe(
      "preview",
    );
  });

  it("requires token and same-origin headers for mutating routes", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({ workspaceRoot: root, sessionToken: "test-token" });
    const transport = createHonoWebUiTransport(plugin);

    const missingToken = await transport.app.request("/console/api/templates/hierarchical/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(missingToken.status).toBe(403);

    const badOrigin = await transport.app.request("/console/api/templates/hierarchical/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://example.test",
        "x-generic-ai-web-ui-token": "test-token",
      },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(badOrigin.status).toBe(403);

    const ok = await transport.app.request("/console/api/templates/hierarchical/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        "x-generic-ai-web-ui-token": "test-token",
      },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
  });

  it("applies runnable templates only with an idempotency key", async () => {
    const root = await seedWorkspace();
    const plugin = createWebUiPlugin({ workspaceRoot: root, sessionToken: "test-token" });

    const previewOnly = await plugin.applyTemplate("blackboard", { dryRun: true });
    expect(previewOnly.ok).toBe(false);

    const missingKey = await plugin.applyTemplate("hierarchical", { dryRun: false });
    expect(missingKey.ok).toBe(false);

    const applied = await plugin.applyTemplate("hierarchical", {
      dryRun: false,
      idempotencyKey: "apply-hierarchical",
    });
    expect(applied.ok).toBe(true);
    expect(await readFile(join(root, ".generic-ai", "harnesses", "hierarchical.yaml"), "utf8")).toContain(
      "protocol: hierarchy",
    );

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

    const posted = await transport.app.request("/console/api/chat/threads/demo/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-generic-ai-web-ui-token": "test-token",
      },
      body: JSON.stringify({ content: "hello" }),
    });
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

    const posted = await transport.app.request("/console/api/chat/threads/failing/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-generic-ai-web-ui-token": "test-token",
      },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(posted.status).toBe(200);
    const detail = (await posted.json()) as {
      readonly thread: { readonly status: string };
      readonly messages: readonly { readonly role: string; readonly content: string }[];
      readonly events: readonly { readonly type: string; readonly data: { readonly message?: string } }[];
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
