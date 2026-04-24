import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { createWorkspaceLayout, type WorkspaceRootInput } from "@generic-ai/plugin-workspace-fs";
import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const name = "@generic-ai/plugin-tools-web" as const;
export const kind = "tools-web" as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONTENT_CHARS = 12_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_REDIRECTS = 5;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60_000;
const MIN_CONTENT_CHARS = 256;
const MAX_CONTENT_CHARS = 50_000;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 20;
const MAX_ERROR_SNIPPET_CHARS = 240;
const RAW_CONTENT_CHAR_FACTOR = 8;
const RAW_CONTENT_CHAR_OVERHEAD = 4_096;
const MAX_RAW_CONTENT_CHARS = 250_000;

const WEB_FETCH_PARAMETERS = Type.Object({
  url: Type.String({
    description: "HTTP or HTTPS URL to fetch.",
  }),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
      description: "Request timeout in milliseconds.",
    }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      minimum: MIN_CONTENT_CHARS,
      maximum: MAX_CONTENT_CHARS,
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
      minimum: MIN_SEARCH_LIMIT,
      maximum: MAX_SEARCH_LIMIT,
      description: "Maximum number of results to return.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
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

export interface WebResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type WebAddressResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly WebResolvedAddress[]>;

export interface WebSearchResponse {
  readonly query: string;
  readonly provider: string;
  readonly results: readonly WebSearchResult[];
  readonly filteredCount: number;
  readonly searchedAt: string;
}

export type WebFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WebToolsOptions {
  readonly root: WorkspaceRootInput;
  readonly searchProvider: WebSearchProvider;
  readonly fetcher?: WebFetcher;
  readonly resolver?: WebAddressResolver;
  readonly headers?: WebHeadersInit;
  readonly allowedHosts?: readonly string[];
  readonly blockedHosts?: readonly string[];
  readonly allowPrivateNetwork?: boolean;
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

function normalizeIntegerInRange(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }

  return value;
}

function normalizeTimeoutMs(value: number, label: string): number {
  return normalizeIntegerInRange(value, label, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

function normalizeContentCharLimit(value: number, label: string): number {
  return normalizeIntegerInRange(value, label, MIN_CONTENT_CHARS, MAX_CONTENT_CHARS);
}

function normalizeSearchLimit(value: number, label: string): number {
  return normalizeIntegerInRange(value, label, MIN_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
}

function matchesHostPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }

  return hostname === pattern;
}

function normalizeUrlHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }

  return normalized;
}

function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return false;
  }

  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return false;
  }

  const [firstOctet = -1, secondOctet = -1, thirdOctet = -1] = octets;
  return (
    firstOctet === 0 ||
    firstOctet === 10 ||
    (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) ||
    firstOctet === 127 ||
    (firstOctet === 169 && secondOctet === 254) ||
    (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (firstOctet === 192 && secondOctet === 0 && (thirdOctet === 0 || thirdOctet === 2)) ||
    (firstOctet === 192 && secondOctet === 88 && thirdOctet === 99) ||
    (firstOctet === 192 && secondOctet === 168) ||
    (firstOctet === 198 && (secondOctet === 18 || secondOctet === 19)) ||
    (firstOctet === 198 && secondOctet === 51 && thirdOctet === 100) ||
    (firstOctet === 203 && secondOctet === 0 && thirdOctet === 113) ||
    firstOctet >= 224
  );
}

function parseIpv4MappedIpv6(hostname: string): string | undefined {
  const normalized = normalizeUrlHostname(hostname);
  if (!normalized.startsWith("::ffff:")) {
    return undefined;
  }

  const suffix = normalized.slice("::ffff:".length);
  if (isIP(suffix) === 4) {
    return suffix;
  }

  const hextets = suffix.split(":");
  if (hextets.length !== 2) {
    return undefined;
  }

  const [highText = "", lowText = ""] = hextets;
  if (!/^[0-9a-f]{1,4}$/i.test(highText) || !/^[0-9a-f]{1,4}$/i.test(lowText)) {
    return undefined;
  }

  const high = Number.parseInt(highText, 16);
  const low = Number.parseInt(lowText, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = normalizeUrlHostname(hostname);
  const mappedIpv4 = parseIpv4MappedIpv6(normalized);
  if (mappedIpv4 !== undefined) {
    return isPrivateIpv4(mappedIpv4);
  }

  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("::")) {
    return true;
  }

  const firstHextet = normalized.split(":", 1)[0] ?? "";
  return (
    /^(fc|fd)/i.test(firstHextet) ||
    /^fe[89ab]/i.test(firstHextet) ||
    /^ff/i.test(firstHextet) ||
    normalized.startsWith("2001:db8:")
  );
}

function isImplicitlyBlockedHost(hostname: string): boolean {
  const normalized = normalizeUrlHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }

  if (ipVersion === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

async function defaultResolveHostAddresses(
  hostname: string,
): Promise<readonly WebResolvedAddress[]> {
  const normalized = normalizeUrlHostname(hostname);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4 || ipVersion === 6) {
    return Object.freeze([
      Object.freeze({
        address: normalized,
        family: ipVersion,
      }),
    ]);
  }

  const records = await lookup(normalized, {
    all: true,
    verbatim: true,
  });

  return Object.freeze(
    records.map((record) =>
      Object.freeze({
        address: normalizeUrlHostname(record.address),
        family: record.family === 6 ? 6 : 4,
      }),
    ),
  );
}

async function resolveWithAbort(
  resolver: WebAddressResolver,
  hostname: string,
  signal: AbortSignal,
): Promise<readonly WebResolvedAddress[]> {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    return await Promise.race([resolver(hostname, signal), abortPromise]);
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function assertAllowedUrl(
  input: string,
  policy: UrlPolicySnapshot,
  allowPrivateNetwork: boolean,
  label: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }

  const hostname = normalizeUrlHostname(parsed.hostname);
  if (policy.blockedHosts.some((pattern) => matchesHostPattern(hostname, pattern))) {
    throw new Error(`${label} targets blocked host "${hostname}".`);
  }

  if (!allowPrivateNetwork && isImplicitlyBlockedHost(hostname)) {
    throw new Error(
      `${label} targets internal host "${hostname}", which requires allowPrivateNetwork.`,
    );
  }

  if (
    policy.allowedHosts.length > 0 &&
    !policy.allowedHosts.some((pattern) => matchesHostPattern(hostname, pattern))
  ) {
    throw new Error(`${label} targets host "${hostname}" which is not on the allow list.`);
  }

  return parsed;
}

async function assertResolvedUrlAllowed(
  parsed: URL,
  resolver: WebAddressResolver,
  allowPrivateNetwork: boolean,
  signal: AbortSignal,
  label: string,
): Promise<void> {
  if (allowPrivateNetwork) {
    return;
  }

  const hostname = normalizeUrlHostname(parsed.hostname);
  if (isIP(hostname) !== 0) {
    return;
  }

  let addresses: readonly WebResolvedAddress[];
  try {
    addresses = await resolveWithAbort(resolver, hostname, signal);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    throw new Error(`${label} host "${hostname}" could not be resolved safely.`);
  }

  if (addresses.length === 0) {
    throw new Error(`${label} host "${hostname}" did not resolve to any addresses.`);
  }

  for (const resolved of addresses) {
    const address = normalizeUrlHostname(resolved.address);
    if (isIP(address) === 0) {
      throw new Error(`${label} host "${hostname}" resolved to non-IP address "${address}".`);
    }

    if (isImplicitlyBlockedHost(address)) {
      throw new Error(`${label} host "${hostname}" resolved to internal address "${address}".`);
    }
  }
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
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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
  signal: AbortSignal,
  policy: UrlPolicySnapshot,
  resolver: WebAddressResolver,
  allowPrivateNetwork: boolean,
): Promise<RedirectedResponse> {
  let currentUrl = requestUrl;
  let redirected = false;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertResolvedUrlAllowed(
      currentUrl,
      resolver,
      allowPrivateNetwork,
      signal,
      redirectCount === 0 ? "web_fetch url" : "Redirect target",
    );

    const response = await fetcher(currentUrl, {
      headers,
      redirect: "manual",
      signal,
    });

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        finalUrl: currentUrl,
        redirected,
      };
    }

    if (redirectCount === MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Fetching ${requestUrl} exceeded ${MAX_REDIRECTS} redirects.`);
    }

    const location = response.headers.get("location");
    if (!location) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Redirect response from ${currentUrl} did not include a Location header.`);
    }

    await response.body?.cancel().catch(() => undefined);
    currentUrl = assertAllowedUrl(
      new URL(location, currentUrl).toString(),
      policy,
      allowPrivateNetwork,
      "Redirect target",
    );
    redirected = true;
  }

  throw new Error(`Fetching ${requestUrl} exceeded ${MAX_REDIRECTS} redirects.`);
}

function detectContentType(response: Response): string {
  const header = response.headers.get("content-type");
  return header?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream";
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
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }

    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
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
    .replace(
      /<\/(li|p|div|section|article|main|aside|header|footer|nav|h[1-6]|tr|table|ul|ol)>/gi,
      "\n",
    )
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

function getRawContentCharLimit(maxChars: number): number {
  return Math.min(
    MAX_RAW_CONTENT_CHARS,
    Math.max(maxChars, maxChars * RAW_CONTENT_CHAR_FACTOR + RAW_CONTENT_CHAR_OVERHEAD),
  );
}

async function readResponseText(
  response: Response,
  maxChars: number,
  signal: AbortSignal,
): Promise<{ readonly content: string; readonly truncated: boolean }> {
  if (response.body === null) {
    return {
      content: "",
      truncated: false,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const rawLimit = getRawContentCharLimit(maxChars);
  let content = "";
  let truncated = false;

  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      content += decoder.decode(value, { stream: true });
      if (content.length > rawLimit) {
        content = content.slice(0, rawLimit);
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }

    content += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return {
    content,
    truncated,
  };
}

async function normalizeResponseBody(
  response: Response,
  maxChars: number,
  signal: AbortSignal,
): Promise<NormalizedTextResponse> {
  const contentType = detectContentType(response);
  if (!isTextLikeContentType(contentType)) {
    throw new Error(`Unsupported content type "${contentType}" for web_fetch.`);
  }

  const raw = await readResponseText(response, maxChars, signal);

  if (contentType.includes("html")) {
    const title = extractTitle(raw.content);
    const normalized = clampContent(htmlToText(raw.content), maxChars);

    return Object.freeze({
      contentType,
      ...(title === undefined ? {} : { title }),
      content: normalized.content,
      truncated: raw.truncated || normalized.truncated,
    });
  }

  const normalizedText = contentType.includes("json")
    ? formatJsonText(raw.content)
    : normalizePlainText(raw.content);
  const normalized = clampContent(normalizedText, maxChars);

  return Object.freeze({
    contentType,
    content: normalized.content,
    truncated: raw.truncated || normalized.truncated,
  });
}

async function summarizeErrorResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string | undefined> {
  const contentType = detectContentType(response);
  if (!isTextLikeContentType(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }

  const raw = await readResponseText(response, MAX_ERROR_SNIPPET_CHARS, signal);
  const summarySource = contentType.includes("html")
    ? htmlToText(raw.content)
    : contentType.includes("json")
      ? formatJsonText(raw.content)
      : normalizePlainText(raw.content);
  const summary = clampContent(summarySource.replace(/\s+/g, " ").trim(), MAX_ERROR_SNIPPET_CHARS);
  return summary.content.length > 0
    ? summary.truncated || raw.truncated
      ? `${summary.content}...`
      : summary.content
    : undefined;
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
  const resolver = options.resolver ?? defaultResolveHostAddresses;
  const allowPrivateNetwork = options.allowPrivateNetwork ?? false;
  const policy: UrlPolicySnapshot = Object.freeze({
    allowedHosts: normalizeHostPatterns(options.allowedHosts),
    blockedHosts: normalizeHostPatterns(options.blockedHosts),
  });
  const defaultTimeoutMs =
    options.defaultTimeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : normalizeTimeoutMs(options.defaultTimeoutMs, "defaultTimeoutMs");
  const maxContentChars =
    options.maxContentChars === undefined
      ? DEFAULT_MAX_CONTENT_CHARS
      : normalizeContentCharLimit(options.maxContentChars, "maxContentChars");
  const sharedHeaders = mergeHeaders(options.headers);

  const fetchImpl = async (
    request: WebFetchRequest,
    signal?: AbortSignal,
  ): Promise<WebFetchResult> => {
    const requestedUrl = assertAllowedUrl(
      request.url,
      policy,
      allowPrivateNetwork,
      "web_fetch url",
    );
    const timeoutMs =
      request.timeoutMs === undefined
        ? defaultTimeoutMs
        : normalizeTimeoutMs(request.timeoutMs, "web_fetch timeoutMs");
    const maxChars =
      request.maxChars === undefined
        ? maxContentChars
        : normalizeContentCharLimit(request.maxChars, "web_fetch maxChars");
    const execution = createAbortSignal(timeoutMs, signal);

    try {
      const redirected = await fetchWithRedirects(
        fetcher,
        requestedUrl,
        sharedHeaders,
        execution.signal,
        policy,
        resolver,
        allowPrivateNetwork,
      );

      if (!redirected.response.ok) {
        const errorSummary = await summarizeErrorResponse(redirected.response, execution.signal);
        throw new Error(
          [
            `Fetching ${redirected.finalUrl} failed with status ${redirected.response.status} ${redirected.response.statusText}`.trimEnd(),
            ...(errorSummary === undefined ? [] : [`Response: ${errorSummary}`]),
          ].join(". "),
        );
      }

      const normalized = await normalizeResponseBody(
        redirected.response,
        maxChars,
        execution.signal,
      );

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
    } catch (error) {
      if (execution.didTimeout()) {
        throw new Error(`Fetching ${requestedUrl} timed out after ${timeoutMs}ms.`);
      }

      throw error;
    } finally {
      execution.cleanup();
    }
  };

  const searchImpl = async (
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> => {
    const query = assertNonEmpty(request.query, "web_search query");
    const limit =
      request.limit === undefined
        ? DEFAULT_SEARCH_LIMIT
        : normalizeSearchLimit(request.limit, "web_search limit");
    const timeoutMs =
      request.timeoutMs === undefined
        ? defaultTimeoutMs
        : normalizeTimeoutMs(request.timeoutMs, "web_search timeoutMs");
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
          const parsed = assertAllowedUrl(
            frozen.url,
            policy,
            allowPrivateNetwork,
            `search result "${frozen.title}"`,
          );
          await assertResolvedUrlAllowed(
            parsed,
            resolver,
            allowPrivateNetwork,
            execution.signal,
            `search result "${frozen.title}"`,
          );
          filteredResults.push(
            Object.freeze({
              ...frozen,
              url: parsed.toString(),
            }),
          );
        } catch (error) {
          if (execution.signal.aborted) {
            throw error;
          }

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
