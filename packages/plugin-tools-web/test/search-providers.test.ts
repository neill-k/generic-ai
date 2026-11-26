import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBraveSearchProvider,
  createSearxngSearchProvider,
  createTavilySearchProvider,
  createWebSearchProvider,
  createWebToolsPlugin,
  type WebFetcher,
  WebSearchProviderError,
} from "../src/index.js";

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(body: unknown, status = 200): { fetcher: WebFetcher; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetcher: WebFetcher = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, calls };
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("web search providers", () => {
  it("queries Brave and cleans up its snippets", async () => {
    const { fetcher, calls } = fakeFetch({
      web: {
        results: [
          {
            title: "Generic <strong>AI</strong>",
            url: "https://example.com/a",
            description: "A <strong>harness</strong> &amp; framework",
          },
          { title: "No url" },
          { title: "B", url: "https://example.com/b" },
        ],
      },
    });
    const provider = createBraveSearchProvider({ apiKey: "brave-key", fetcher, country: "us" });
    const results = await provider.search({ query: "generic ai", limit: 5 });

    expect(provider.name).toBe("brave");
    expect(results).toEqual([
      { title: "Generic AI", url: "https://example.com/a", snippet: "A harness & framework" },
      { title: "B", url: "https://example.com/b" },
    ]);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("generic ai");
    expect(url.searchParams.get("count")).toBe("5");
    expect(url.searchParams.get("country")).toBe("us");
    expect(header(calls[0]?.init, "x-subscription-token")).toBe("brave-key");
  });

  it("posts to Tavily with a bearer token and respects the limit", async () => {
    const { fetcher, calls } = fakeFetch({
      results: [
        { title: "One", url: "https://one.test", content: "first" },
        { title: "Two", url: "https://two.test", content: "second" },
      ],
    });
    const provider = createTavilySearchProvider({ apiKey: "tvly-key", fetcher });
    const results = await provider.search({ query: "q", limit: 1 });

    expect(results).toEqual([{ title: "One", url: "https://one.test", snippet: "first" }]);
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(header(calls[0]?.init, "authorization")).toBe("Bearer tvly-key");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      query: "q",
      max_results: 1,
      search_depth: "basic",
    });
  });

  it("queries a SearXNG instance in JSON format", async () => {
    const { fetcher, calls } = fakeFetch({
      results: [{ title: "Self hosted", url: "https://s.test", content: "ok" }],
    });
    const provider = createSearxngSearchProvider({ baseUrl: "http://searxng:8080", fetcher });
    expect(await provider.search({ query: "q", limit: 3 })).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.href.startsWith("http://searxng:8080/search?")).toBe(true);
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("reports HTTP failures with the provider name and status", async () => {
    const { fetcher } = fakeFetch("rate limited", 429);
    const error = await createBraveSearchProvider({ apiKey: "k", fetcher })
      .search({ query: "q", limit: 1 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebSearchProviderError);
    expect((error as WebSearchProviderError).status).toBe(429);
    expect((error as Error).message).toContain("HTTP 429: rate limited");
  });

  it("builds providers from config with placeholder keys and refuses missing keys", async () => {
    const { fetcher, calls } = fakeFetch({ web: { results: [] } });
    const placeholder = ["$", "{", "BRAVE_API_KEY", "}"].join("");
    const provider = createWebSearchProvider(
      { provider: "brave", apiKey: placeholder },
      { fetcher, env: { BRAVE_API_KEY: "from-env" } },
    );
    await provider.search({ query: "q", limit: 1 });
    expect(header(calls[0]?.init, "x-subscription-token")).toBe("from-env");

    expect(() =>
      createWebSearchProvider({ provider: "tavily", apiKey: placeholder }, { env: {} }),
    ).toThrow(/BRAVE_API_KEY, which is not set/);
    expect(() => createWebSearchProvider({ provider: "brave", apiKey: " " }, { env: {} })).toThrow(
      /non-empty apiKey/,
    );
  });

  it("plugs into web_search, where host policy still filters results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-web-search-"));
    tempRoots.push(root);
    const { fetcher } = fakeFetch({
      results: [
        { title: "Allowed", url: "https://docs.example.com/page", content: "keep" },
        { title: "Blocked", url: "https://blocked.example.org/page", content: "drop" },
      ],
    });
    const plugin = createWebToolsPlugin({
      root,
      searchProvider: createTavilySearchProvider({ apiKey: "k", fetcher }),
      blockedHosts: ["blocked.example.org"],
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const response = await plugin.search({ query: "docs" });
    expect(response.provider).toBe("tavily");
    expect(response.results.map((result) => result.title)).toEqual(["Allowed"]);
    expect(response.filteredCount).toBe(1);
  });
});
