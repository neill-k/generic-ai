import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWebToolsPlugin } from "../src/index.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-web-"));
  tempRoots.push(root);

  try {
    return await run(root);
  } finally {
    tempRoots.splice(tempRoots.indexOf(root), 1);
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("@generic-ai/plugin-tools-web", () => {
  it("creates web fetch and search tools anchored to the workspace root", async () => {
    await withTempRoot(async (root) => {
      const plugin = createWebToolsPlugin({
        root,
        searchProvider: {
          name: "test-provider",
          search: async () => [],
        },
      });

      expect(plugin.name).toBe("@generic-ai/plugin-tools-web");
      expect(plugin.kind).toBe("tools-web");
      expect(plugin.root).toBe(root);
      expect(plugin.piTools.map((tool) => tool.name)).toEqual(["web_fetch", "web_search"]);
    });
  });

  it("fetches html and converts it into readable text", async () => {
    await withTempRoot(async (root) => {
      const plugin = createWebToolsPlugin({
        root,
        allowedHosts: ["docs.example.com"],
        searchProvider: {
          name: "test-provider",
          search: async () => [],
        },
        fetcher: async () =>
          new Response(
            "<html><head><title>Example Docs</title></head><body><h1>Getting Started</h1><p>Hello <strong>world</strong>.</p><a href=\"https://docs.example.com/setup\">Setup</a></body></html>",
            {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          ),
      });

      const result = await plugin.fetch({
        url: "https://docs.example.com/start",
      });

      expect(result.title).toBe("Example Docs");
      expect(result.status).toBe(200);
      expect(result.contentType).toBe("text/html");
      expect(result.content).toContain("Getting Started");
      expect(result.content).toContain("Hello world.");
      expect(result.content).toContain("Setup (https://docs.example.com/setup)");

      const toolResult = await plugin.piTools[0].execute("call-1", {
        url: "https://docs.example.com/start",
      });
      expect(toolResult.content[0]?.text).toContain("Fetched https://docs.example.com/start");
      expect(toolResult.details.finalUrl).toBe("https://docs.example.com/start");
    });
  });

  it("filters search results through the configured host policy", async () => {
    await withTempRoot(async (root) => {
      const plugin = createWebToolsPlugin({
        root,
        allowedHosts: ["docs.example.com", "*.example.dev"],
        blockedHosts: ["blocked.example.dev"],
        searchProvider: {
          name: "stub-search",
          search: async ({ query, limit }) => {
            expect(query).toBe("generic ai");
            expect(limit).toBe(5);

            return [
              {
                title: "Docs",
                url: "https://docs.example.com/start",
                snippet: "Primary documentation.",
              },
              {
                title: "Blocked",
                url: "https://blocked.example.dev/secret",
                snippet: "Should be filtered.",
              },
              {
                title: "Guides",
                url: "https://guides.example.dev/intro",
              },
            ];
          },
        },
      });

      const result = await plugin.search({
        query: "generic ai",
        limit: 5,
      });

      expect(result.provider).toBe("stub-search");
      expect(result.filteredCount).toBe(1);
      expect(result.results).toEqual([
        {
          title: "Docs",
          url: "https://docs.example.com/start",
          snippet: "Primary documentation.",
        },
        {
          title: "Guides",
          url: "https://guides.example.dev/intro",
        },
      ]);
    });
  });

  it("rejects invalid urls before fetching", async () => {
    await withTempRoot(async (root) => {
      const plugin = createWebToolsPlugin({
        root,
        searchProvider: {
          name: "test-provider",
          search: async () => [],
        },
      });

      await expect(
        plugin.fetch({
          url: "not-a-url",
        }),
      ).rejects.toThrow(/valid absolute url/i);
    });
  });

  it("surfaces http failures", async () => {
    await withTempRoot(async (root) => {
      const plugin = createWebToolsPlugin({
        root,
        searchProvider: {
          name: "test-provider",
          search: async () => [],
        },
        fetcher: async () =>
          new Response("Not found", {
            status: 404,
            statusText: "Not Found",
            headers: { "content-type": "text/plain" },
          }),
      });

      await expect(
        plugin.fetch({
          url: "https://example.com/missing",
        }),
      ).rejects.toThrow(/status 404 not found/i);
    });
  });

  it("times out slow fetch requests", async () => {
    await withTempRoot(async (root) => {
      const plugin = createWebToolsPlugin({
        root,
        searchProvider: {
          name: "test-provider",
          search: async () => [],
        },
        fetcher: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          }),
      });

      await expect(
        plugin.fetch({
          url: "https://example.com/slow",
          timeoutMs: 10,
        }),
      ).rejects.toThrow(/timed out/i);
    });
  });
});
