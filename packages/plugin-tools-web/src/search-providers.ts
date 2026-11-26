import type {
  WebFetcher,
  WebSearchProvider,
  WebSearchProviderRequest,
  WebSearchResult,
} from "./index.js";

/**
 * Ready-made `web_search` providers. Each one calls a search API over HTTPS with the host's fetch;
 * results still pass through the web tools' host allow/block policy before agents see them.
 */

export interface SearchProviderHttpOptions {
  /** Defaults to the global fetch. Tests pass a fake. */
  readonly fetcher?: WebFetcher;
}

export interface BraveSearchProviderOptions extends SearchProviderHttpOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  /** Two-letter country code for result ranking, for example `us`. */
  readonly country?: string;
  readonly safeSearch?: "off" | "moderate" | "strict";
}

export interface TavilySearchProviderOptions extends SearchProviderHttpOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly searchDepth?: "basic" | "advanced";
}

export interface SearxngSearchProviderOptions extends SearchProviderHttpOptions {
  /** Base URL of a SearXNG instance with the JSON format enabled, for example `http://searxng:8080`. */
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export type WebSearchProviderConfig =
  | ({ readonly provider: "brave" } & Omit<BraveSearchProviderOptions, "fetcher">)
  | ({ readonly provider: "tavily" } & Omit<TavilySearchProviderOptions, "fetcher">)
  | ({ readonly provider: "searxng" } & Omit<SearxngSearchProviderOptions, "fetcher">);

export class WebSearchProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WebSearchProviderError";
  }
}

const MAX_SNIPPET_CHARS = 500;

function plainText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) {
    return undefined;
  }
  return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toResults(
  entries: unknown,
  snippetKey: string,
  limit: number,
): readonly WebSearchResult[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const results: WebSearchResult[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry["url"] !== "string") {
      continue;
    }
    const snippet = plainText(entry[snippetKey]);
    results.push({
      title: plainText(entry["title"]) ?? entry["url"],
      url: entry["url"],
      ...(snippet === undefined ? {} : { snippet }),
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function requireNonEmpty(value: string | undefined, provider: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WebSearchProviderError(provider, `${provider} search needs a non-empty ${field}.`);
  }
  return value.trim();
}

async function readJson(provider: string, response: Response): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new WebSearchProviderError(
      provider,
      `${provider} search failed with HTTP ${response.status}${
        body.length > 0 ? `: ${body.slice(0, 200)}` : ""
      }`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new WebSearchProviderError(provider, `${provider} search returned invalid JSON.`);
  }
}

function fetcherOf(options: SearchProviderHttpOptions): WebFetcher {
  return options.fetcher ?? ((input, init) => fetch(input, init));
}

/** Brave Search API (`X-Subscription-Token`). */
export function createBraveSearchProvider(options: BraveSearchProviderOptions): WebSearchProvider {
  const apiKey = requireNonEmpty(options.apiKey, "brave", "apiKey");
  const endpoint = options.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
  const fetcher = fetcherOf(options);
  return {
    name: "brave",
    async search(request: WebSearchProviderRequest) {
      const url = new URL(endpoint);
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(Math.min(request.limit, 20)));
      if (options.country !== undefined) {
        url.searchParams.set("country", options.country);
      }
      if (options.safeSearch !== undefined) {
        url.searchParams.set("safesearch", options.safeSearch);
      }
      const response = await fetcher(url, {
        method: "GET",
        headers: { accept: "application/json", "x-subscription-token": apiKey },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const body = await readJson("brave", response);
      const web = isRecord(body) ? body["web"] : undefined;
      return toResults(isRecord(web) ? web["results"] : undefined, "description", request.limit);
    },
  };
}

/** Tavily search API (bearer token). */
export function createTavilySearchProvider(
  options: TavilySearchProviderOptions,
): WebSearchProvider {
  const apiKey = requireNonEmpty(options.apiKey, "tavily", "apiKey");
  const endpoint = options.endpoint ?? "https://api.tavily.com/search";
  const fetcher = fetcherOf(options);
  return {
    name: "tavily",
    async search(request: WebSearchProviderRequest) {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: request.query,
          max_results: Math.min(request.limit, 20),
          search_depth: options.searchDepth ?? "basic",
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const body = await readJson("tavily", response);
      return toResults(isRecord(body) ? body["results"] : undefined, "content", request.limit);
    },
  };
}

/** A self-hosted SearXNG instance (`/search?format=json`). No third-party account needed. */
export function createSearxngSearchProvider(
  options: SearxngSearchProviderOptions,
): WebSearchProvider {
  const baseUrl = requireNonEmpty(options.baseUrl, "searxng", "baseUrl");
  const fetcher = fetcherOf(options);
  return {
    name: "searxng",
    async search(request: WebSearchProviderRequest) {
      const url = new URL("search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
      url.searchParams.set("q", request.query);
      url.searchParams.set("format", "json");
      const response = await fetcher(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const body = await readJson("searxng", response);
      return toResults(isRecord(body) ? body["results"] : undefined, "content", request.limit);
    },
  };
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Resolve `${VAR}` placeholders from `env`. A missing variable is an error, never an empty key. */
export function resolveSearchPlaceholders(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  provider: string,
): string {
  return value.replace(PLACEHOLDER, (_match, variable: string) => {
    const resolved = env[variable];
    if (resolved === undefined || resolved.length === 0) {
      throw new WebSearchProviderError(
        provider,
        `${provider} search needs environment variable ${variable}, which is not set.`,
      );
    }
    return resolved;
  });
}

/**
 * Build a provider from config, for example `{ provider: "brave", apiKey: "${BRAVE_API_KEY}" }`.
 * `${VAR}` placeholders in `apiKey`, `baseUrl` and `endpoint` resolve from `env` (default
 * `process.env`) so keys stay out of config files.
 */
export function createWebSearchProvider(
  config: WebSearchProviderConfig,
  options: SearchProviderHttpOptions & {
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): WebSearchProvider {
  const env = options.env ?? process.env;
  const resolve = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : resolveSearchPlaceholders(value, env, config.provider);
  const http = options.fetcher === undefined ? {} : { fetcher: options.fetcher };
  const endpoint = "endpoint" in config ? resolve(config.endpoint) : undefined;
  switch (config.provider) {
    case "brave":
      return createBraveSearchProvider({
        ...http,
        apiKey: resolve(config.apiKey) ?? "",
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(config.country === undefined ? {} : { country: config.country }),
        ...(config.safeSearch === undefined ? {} : { safeSearch: config.safeSearch }),
      });
    case "tavily":
      return createTavilySearchProvider({
        ...http,
        apiKey: resolve(config.apiKey) ?? "",
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(config.searchDepth === undefined ? {} : { searchDepth: config.searchDepth }),
      });
    case "searxng": {
      const apiKey = resolve(config.apiKey);
      return createSearxngSearchProvider({
        ...http,
        baseUrl: resolve(config.baseUrl) ?? "",
        ...(apiKey === undefined ? {} : { apiKey }),
      });
    }
    default:
      throw new WebSearchProviderError(
        String((config as { provider?: unknown }).provider),
        "Unknown web search provider; use brave, tavily or searxng.",
      );
  }
}
