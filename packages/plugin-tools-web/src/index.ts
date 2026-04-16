import { createWorkspaceLayout, type WorkspaceRootInput } from "@generic-ai/plugin-workspace-fs";
import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const name = "@generic-ai/plugin-tools-web" as const;
export const kind = "tools-web" as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONTENT_CHARS = 12_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_REDIRECTS = 5;

const WEB_FETCH_PARAMETERS = Type.Object({
  url: Type.String({
    description: "HTTP or HTTPS URL to fetch.",
  }),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 60_000,
      description: "Request timeout in milliseconds.",
    }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      minimum: 256,
      maximum: 50_000,
      description: "Maximum response characters to keep after normalization.",
    }),
  ),
});

const WEB_SEARCH_PARAMETERS = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Search query to send to the configured provider.",
  }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "Maximum number of results to return.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 60_000,
      description: "Provider timeout in milliseconds.",
    }),
  ),
});

const HTML_ENTITY_MAP: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "...",
  lt: "<",
  mdash: "--",
  nbsp: " ",
  ndash: "-",
  quot: '"',
});

type TextContent = {
  readonly type: "text";
  readonly text: string;
};

export interface ToolResult<TDetails> {
  readonly content: readonly TextContent[];
  readonly details: TDetails;
}

export type ToolUpdateCallback<TDetails> = (partialResult: ToolResult<TDetails>) => void;

export interface PiCompatibleTool<TParams extends TSchema = TSchema, TDetails = unknown> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback<TDetails>,
  ): Promise<ToolResult<TDetails>>;
}

export interface UrlPolicySnapshot {
  readonly allowedHosts: readonly string[];
  readonly blockedHosts: readonly string[];
}

export interface WebFetchRequest {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly maxChars?: number;
}

export interface WebFetchResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly contentType: string;
  readonly title?: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly fetchedAt: string;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
}

export interface WebSearchRequest {
  readonly query: string;
  readonly limit?: number;
  readonly timeoutMs?: number;
}

export interface WebSearchProviderRequest {
  readonly query: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface WebSearchProvider {
  readonly name: string;
  search(request: WebSearchProviderRequest): Promise<readonly WebSearchResult[]>;
}

export interface WebSearchResponse {
  readonly query: string;
  readonly provider: string;
  readonly results: readonly WebSearchResult[];
  readonly filteredCount: number;
  readonly searchedAt: string;
}

export type WebFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WebToolsOptions {
  readonly root: WorkspaceRootInput;
  readonly searchProvider: WebSearchProvider;
  readonly fetcher?: WebFetcher;
  readonly headers?: WebHeadersInit;
  readonly allowedHosts?: readonly string[];
  readonly blockedHosts?: readonly string[];
  readonly defaultTimeoutMs?: number;
  readonly maxContentChars?: number;
  readonly now?: () => string | number | Date;
}

export type WebFetchTool = PiCompatibleTool<typeof WEB_FETCH_PARAMETERS, WebFetchResult>;
export type WebSearchTool = PiCompatibleTool<typeof WEB_SEARCH_PARAMETERS, WebSearchResponse>;

export interface WebToolsPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  readonly policy: UrlPolicySnapshot;
  readonly searchProvider: string;
  readonly piTools: readonly [WebFetchTool, WebSearchTool];
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse>;
}

interface RedirectedResponse {
  readonly response: Response;
  readonly finalUrl: URL;
  readonly redirected: boolean;
}

interface NormalizedTextResponse {
  readonly contentType: string;
  readonly title?: string;
  readonly content: string;
  readonly truncated: boolean;
}

type WebHeadersInit =
  | Headers
  | Readonly<Record<string, string>>
  | ReadonlyArray<readonly [string, string]>;

function normalizeTimestamp(value: WebToolsOptions["now"]): string {
  const current = value?.() ?? Date.now();
  const date = current instanceof Date ? current : new Date(current);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError("WebToolsOptions.now() must return a valid date-like value.");
  }

  return date.toISOString();
}

function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return trimmed;
}

function normalizeHostPatterns(patterns: readonly string[] | undefined): readonly string[] {
  return Object.freeze(
    (patterns ?? [])
      .map((pattern) => pattern.trim().toLowerCase())
      .filter((pattern) => pattern.length > 0),
  );
}

function matchesHostPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }

  return hostname === pattern;
}

function assertAllowedUrl(input: string, policy: UrlPolicySnapshot, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (policy.blockedHosts.some((pattern) => matchesHostPattern(hostname, pattern))) {
    throw new Error(`${label} targets blocked host "${hostname}".`);
  }

  if (
    policy.allowedHosts.length > 0 &&
    !policy.allowedHosts.some((pattern) => matchesHostPattern(hostname, pattern))
  ) {
    throw new Error(`${label} targets host "${hostname}" which is not on the allow list.`);
  }

  return parsed;
}

function createAbortSignal(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): { readonly signal: AbortSignal; cleanup(): void; didTimeout(): boolean } {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const abortFromParent = (): void => {
    controller.abort(signal?.reason);
  };

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup(): void {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      signal?.removeEventListener("abort", abortFromParent);
    },
    didTimeout(): boolean {
      return timedOut;
    },
  };
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function mergeHeaders(headersInit: WebHeadersInit | undefined): Headers {
  const headers = new Headers();

  if (headersInit instanceof Headers) {
    headersInit.forEach((value, key) => {
      headers.set(key, value);
    });
  } else if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      headers.set(key, value);
    }
  } else if (headersInit) {
    for (const [key, value] of Object.entries(headersInit)) {
      headers.set(key, value);
    }
  }

  if (!headers.has("accept")) {
    headers.set(
      "accept",
      "text/html, text/plain, application/json, application/xml, text/xml;q=0.9, */*;q=0.1",
    );
  }

  return headers;
}

async function fetchWithRedirects(
  fetcher: WebFetcher,
  requestUrl: URL,
  headers: Headers,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  policy: UrlPolicySnapshot,
): Promise<RedirectedResponse> {
  const execution = createAbortSignal(timeoutMs, signal);
  let currentUrl = requestUrl;
  let redirected = false;

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetcher(currentUrl, {
        headers,
        redirect: "manual",
        signal: execution.signal,
      });

      if (!isRedirectStatus(response.status)) {
        return {
          response,
          finalUrl: currentUrl,
          redirected,
        };
      }

      if (redirectCount === MAX_REDIRECTS) {
        throw new Error(`Fetching ${requestUrl} exceeded ${MAX_REDIRECTS} redirects.`);
      }

      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect response from ${currentUrl} did not include a Location header.`);
      }

      currentUrl = assertAllowedUrl(new URL(location, currentUrl).toString(), policy, "Redirect target");
      redirected = true;
    }

    throw new Error(`Fetching ${requestUrl} exceeded ${MAX_REDIRECTS} redirects.`);
  } catch (error) {
    if (execution.didTimeout()) {
      throw new Error(`Fetching ${requestUrl} timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    execution.cleanup();
  }
}

function detectContentType(response: Response): string {
  const header = response.headers.get("content-type");
  return (
    header?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream"
  );
}

function isTextLikeContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript")
  );
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, token: string) => {
    const normalized = token.toLowerCase();
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return HTML_ENTITY_MAP[normalized] ?? match;
  });
}

function extractTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) {
    return undefined;
  }

  const title = decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim());
  return title.length > 0 ? title : undefined;
}

function htmlToText(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutScripts = withoutComments
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const withLinks = withoutScripts.replace(
    /<a\b[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote, href: string, text: string) => `${text} (${href})`,
  );
  const withLineBreaks = withLinks
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(li|p|div|section|article|main|aside|header|footer|nav|h[1-6]|tr|table|ul|ol)>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ");
  const stripped = withLineBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(stripped).replace(/\r/g, "");

  return decoded
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatJsonText(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), undefined, 2);
  } catch {
    return normalizePlainText(value);
  }
}

function clampContent(
  content: string,
  maxChars: number,
): { readonly content: string; readonly truncated: boolean } {
  if (content.length <= maxChars) {
    return {
      content,
      truncated: false,
    };
  }

  return {
    content: content.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

async function normalizeResponseBody(
  response: Response,
  maxChars: number,
): Promise<NormalizedTextResponse> {
  const contentType = detectContentType(response);
  if (!isTextLikeContentType(contentType)) {
    throw new Error(`Unsupported content type "${contentType}" for web_fetch.`);
  }

  const raw = await response.text();

  if (contentType.includes("html")) {
    const title = extractTitle(raw);
    const normalized = clampContent(htmlToText(raw), maxChars);

    return Object.freeze({
      contentType,
      ...(title === undefined ? {} : { title }),
      content: normalized.content,
      truncated: normalized.truncated,
    });
  }

  const normalizedText = contentType.includes("json")
    ? formatJsonText(raw)
    : normalizePlainText(raw);
  const normalized = clampContent(normalizedText, maxChars);

  return Object.freeze({
    contentType,
    content: normalized.content,
    truncated: normalized.truncated,
  });
}

function renderFetchToolContent(result: WebFetchResult): string {
  const lines = [
    `Fetched ${result.finalUrl}`,
    `Status: ${result.status} ${result.statusText}`.trimEnd(),
    `Content-Type: ${result.contentType}`,
  ];

  if (result.title) {
    lines.push(`Title: ${result.title}`);
  }

  if (result.redirected) {
    lines.push(`Requested URL: ${result.requestedUrl}`);
  }

  if (result.truncated) {
    lines.push("Response content was truncated.");
  }

  return `${lines.join("\n")}\n\n${result.content}`;
}

function renderSearchToolContent(result: WebSearchResponse): string {
  const header = `Search results for "${result.query}" via ${result.provider}:`;
  if (result.results.length === 0) {
    const suffix =
      result.filteredCount > 0
        ? `\nNo results survived the configured host policy (${result.filteredCount} filtered).`
        : "\nNo results returned.";
    return `${header}${suffix}`;
  }

  const lines = result.results.flatMap((entry, index) => {
    const row = [`${index + 1}. ${entry.title}`, `   ${entry.url}`];
    if (entry.snippet) {
      row.push(`   ${entry.snippet}`);
    }
    return row;
  });

  if (result.filteredCount > 0) {
    lines.push(`Filtered out ${result.filteredCount} result(s) due to host policy.`);
  }

  return `${header}\n${lines.join("\n")}`;
}

function freezeSearchResult(result: WebSearchResult): WebSearchResult {
  return Object.freeze({
    title: assertNonEmpty(result.title, "search result title"),
    url: assertNonEmpty(result.url, "search result url"),
    ...(result.snippet === undefined || result.snippet.trim().length === 0
      ? {}
      : { snippet: result.snippet.trim() }),
  });
}

function textContent(text: string): TextContent {
  return {
    type: "text",
    text,
  };
}

export function createWebToolsPlugin(options: WebToolsOptions): WebToolsPlugin {
  const layout = createWorkspaceLayout(options.root);
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const policy: UrlPolicySnapshot = Object.freeze({
    allowedHosts: normalizeHostPatterns(options.allowedHosts),
    blockedHosts: normalizeHostPatterns(options.blockedHosts),
  });
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const sharedHeaders = mergeHeaders(options.headers);

  const fetchImpl = async (
    request: WebFetchRequest,
    signal?: AbortSignal,
  ): Promise<WebFetchResult> => {
    const requestedUrl = assertAllowedUrl(request.url, policy, "web_fetch url");
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    const maxChars = request.maxChars ?? maxContentChars;
    const redirected = await fetchWithRedirects(
      fetcher,
      requestedUrl,
      sharedHeaders,
      timeoutMs,
      signal,
      policy,
    );

    if (!redirected.response.ok) {
      throw new Error(
        `Fetching ${redirected.finalUrl} failed with status ${redirected.response.status} ${redirected.response.statusText}`.trimEnd(),
      );
    }

    const normalized = await normalizeResponseBody(redirected.response, maxChars);

    return Object.freeze({
      requestedUrl: requestedUrl.toString(),
      finalUrl: redirected.finalUrl.toString(),
      status: redirected.response.status,
      statusText: redirected.response.statusText,
      ok: redirected.response.ok,
      redirected: redirected.redirected,
      contentType: normalized.contentType,
      ...(normalized.title === undefined ? {} : { title: normalized.title }),
      content: normalized.content,
      truncated: normalized.truncated,
      fetchedAt: normalizeTimestamp(options.now),
    });
  };

  const searchImpl = async (
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> => {
    const query = assertNonEmpty(request.query, "web_search query");
    const limit = request.limit ?? DEFAULT_SEARCH_LIMIT;
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    const execution = createAbortSignal(timeoutMs, signal);

    try {
      const rawResults = await options.searchProvider.search({
        query,
        limit,
        signal: execution.signal,
      });
      const filteredResults: WebSearchResult[] = [];
      let filteredCount = 0;

      for (const rawResult of rawResults) {
        const frozen = freezeSearchResult(rawResult);
        try {
          const parsed = assertAllowedUrl(frozen.url, policy, `search result "${frozen.title}"`);
          filteredResults.push(
            Object.freeze({
              ...frozen,
              url: parsed.toString(),
            }),
          );
        } catch {
          filteredCount += 1;
        }

        if (filteredResults.length >= limit) {
          break;
        }
      }

      return Object.freeze({
        query,
        provider: options.searchProvider.name,
        results: Object.freeze(filteredResults),
        filteredCount,
        searchedAt: normalizeTimestamp(options.now),
      });
    } catch (error) {
      if (execution.didTimeout()) {
        throw new Error(
          `Search provider "${options.searchProvider.name}" timed out after ${timeoutMs}ms.`,
        );
      }

      throw error;
    } finally {
      execution.cleanup();
    }
  };

  const webFetchTool: WebFetchTool = Object.freeze({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch an HTTP(S) URL, enforce host policy rules, and return normalized text content.",
    parameters: WEB_FETCH_PARAMETERS,
    async execute(
      _toolCallId: string,
      params: Static<typeof WEB_FETCH_PARAMETERS>,
      signal?: AbortSignal,
      _onUpdate?: ToolUpdateCallback<WebFetchResult>,
    ): Promise<ToolResult<WebFetchResult>> {
      const result = await fetchImpl(params, signal);
      return Object.freeze({
        content: Object.freeze([textContent(renderFetchToolContent(result))]),
        details: result,
      });
    },
  });

  const webSearchTool: WebSearchTool = Object.freeze({
    name: "web_search",
    label: "Web Search",
    description:
      "Run a provider-backed web search query, filter results through host policy rules, and return structured matches.",
    parameters: WEB_SEARCH_PARAMETERS,
    async execute(
      _toolCallId: string,
      params: Static<typeof WEB_SEARCH_PARAMETERS>,
      signal?: AbortSignal,
      _onUpdate?: ToolUpdateCallback<WebSearchResponse>,
    ): Promise<ToolResult<WebSearchResponse>> {
      const result = await searchImpl(params, signal);
      return Object.freeze({
        content: Object.freeze([textContent(renderSearchToolContent(result))]),
        details: result,
      });
    },
  });

  const piTools = Object.freeze([webFetchTool, webSearchTool]) as readonly [
    WebFetchTool,
    WebSearchTool,
  ];

  return Object.freeze({
    name,
    kind,
    root: layout.root,
    policy,
    searchProvider: options.searchProvider.name,
    piTools,
    fetch: fetchImpl,
    search: searchImpl,
  });
}
