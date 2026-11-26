// Adapted from pi (https://github.com/badlogic/pi-mono), packages/coding-agent/src/extensions/tool-search/tool.ts. MIT License.

import type { AgentTool } from "@generic-ai/agent";

/**
 * Tool discovery: a BM25 ranker over tool metadata and the `tool_search` tool.
 *
 * Deferred tools (for example the tools of many MCP servers) are not declared to the model up
 * front, which keeps the request small. `tool_search` ranks them against a query and loads the
 * matches, so they are declared from the next model call.
 */

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** A tool as the ranker sees it. */
export interface ToolSearchDocument {
  name: string;
  /** Description, schema descriptions and property names. */
  text: string;
  /** Name, description and instructions of the tool's namespace (for example an MCP server). */
  namespaceText?: string;
}

export interface ToolSearchMatch {
  name: string;
  score: number;
}

/** Ranks tools for a query. */
export interface ToolRanker {
  rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

/** Unicode word segmentation with identifier boundaries, English stop words and singular forms. */
export function tokenize(text: string): string[] {
  const normalized = text
    .normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
  // Plain ASCII splits into the same words at spaces; only other text goes through the segmenter.
  const words = /^[a-z0-9 ]*$/.test(normalized)
    ? normalized.split(" ")
    : Array.from(wordSegmenter.segment(normalized), (segment) =>
        segment.isWordLike ? segment.segment : "",
      );
  return words
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word))
    .map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a local JSON pointer (`#/$defs/Thing`) against the schema root. */
function resolveLocalRef(ref: string, root: unknown): unknown {
  if (!ref.startsWith("#")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Schema descriptions and property names, recursively, following local `$ref`s once each. */
function schemaText(schema: unknown, root: unknown, parts: string[], seen: Set<unknown>): void {
  if (!isObject(schema)) return;
  if (typeof schema["$ref"] === "string") {
    const target = resolveLocalRef(schema["$ref"], root);
    if (isObject(target) && !seen.has(target)) {
      seen.add(target);
      schemaText(target, root, parts, seen);
    }
  }
  if (typeof schema["description"] === "string") parts.push(schema["description"]);
  const properties = schema["properties"];
  if (isObject(properties)) {
    for (const [name, property] of Object.entries(properties)) {
      parts.push(name);
      schemaText(property, root, parts, seen);
    }
  }
  schemaText(schema["items"], root, parts, seen);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      for (const variant of variants) schemaText(variant, root, parts, seen);
    }
  }
}

export interface ToolSearchNamespace {
  name: string;
  description?: string;
  instructions?: string;
}

/** Search text of a tool: description, schema descriptions and property names, and its namespace. */
export function createToolSearchDocument(
  tool: { name: string; description: string; parameters?: unknown },
  namespace?: ToolSearchNamespace,
): ToolSearchDocument {
  const parts = [tool.description];
  schemaText(tool.parameters, tool.parameters, parts, new Set([tool.parameters]));
  const namespaceText = namespace
    ? [namespace.name, namespace.description ?? "", namespace.instructions ?? ""].join(" ")
    : "";
  return { name: tool.name, text: parts.filter((part) => part.trim()).join(" "), namespaceText };
}

/** Lowercase with characters invalid in identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_$]/g, "_");
}

/** Whether the query is the tool's full name, or its suffix after a `__` separator. */
function isExactNameQuery(query: string, name: string): boolean {
  const normalized = normalizeName(name);
  return normalized === query || normalized.endsWith(`__${query}`);
}

interface IndexedDocument {
  name: string;
  nameTerms: ReadonlySet<string>;
  /** Terms of the last `__` segment of the name, the part models say. */
  localNameTerms: readonly string[];
  textCounts: ReadonlyMap<string, number>;
  textLength: number;
  namespaceTerms: ReadonlySet<string>;
}

function indexDocument(document: ToolSearchDocument): IndexedDocument {
  const textCounts = new Map<string, number>();
  for (const term of tokenize(document.text)) {
    textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
  }
  const segments = document.name.split("__");
  return {
    name: document.name,
    nameTerms: new Set(tokenize(document.name)),
    localNameTerms: [...new Set(tokenize(segments[segments.length - 1] ?? ""))],
    textCounts,
    textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
    namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
  };
}

/** A query term in the name outweighs any number of mentions in the description. */
const NAME_WEIGHT = 3;
/** Namespace text is shared by every tool of a server: it helps find the server, not the tool. */
const NAMESPACE_WEIGHT = 0.5;

/**
 * Okapi BM25 over the description, with the name and namespace as separate fields. Tools matching
 * more query terms rank first; a query that is exactly a tool's name ranks that tool first; a tool
 * whose whole local name is in the query gets a bonus. Ties keep document order.
 */
export class Bm25Ranker implements ToolRanker {
  private readonly k1: number;
  private readonly b: number;

  constructor(options: { k1?: number; b?: number } = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
  }

  rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
    const queryTerms = new Set(tokenize(query));
    if (queryTerms.size === 0 || documents.length === 0 || limit <= 0) return [];
    const indexed = documents.map(indexDocument);
    const averageLength =
      indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
    const idf = new Map(
      [...queryTerms].map((term) => {
        const frequency = indexed.filter(
          (document) =>
            document.nameTerms.has(term) ||
            document.textCounts.has(term) ||
            document.namespaceTerms.has(term),
        ).length;
        return [
          term,
          Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5)),
        ] as const;
      }),
    );
    const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
    const exactQuery = normalizeName(query);
    const matches: (ToolSearchMatch & { covered: number; exact: boolean })[] = [];
    for (const document of indexed) {
      const norm = this.k1 * (1 - this.b + (this.b * document.textLength) / averageLength);
      let score = 0;
      let covered = 0;
      for (const term of queryTerms) {
        const count = document.textCounts.get(term) ?? 0;
        const weight =
          (document.nameTerms.has(term) ? NAME_WEIGHT : 0) +
          (document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
          (count * (this.k1 + 1)) / (count + norm);
        if (weight > 0) covered++;
        score += (idf.get(term) ?? 0) * weight;
      }
      if (score === 0) continue;
      const local = document.localNameTerms;
      if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
      matches.push({
        name: document.name,
        score,
        covered,
        exact: isExactNameQuery(exactQuery, document.name),
      });
    }
    return matches
      .sort(
        (a, b) => Number(b.exact) - Number(a.exact) || b.covered - a.covered || b.score - a.score,
      )
      .slice(0, limit)
      .map(({ name, score }) => ({ name, score }));
  }
}

export interface ToolSearchToolDetails {
  /** Tools loaded by this call. */
  loaded: string[];
}

export interface ToolSearchToolOptions {
  /** Tools that are not declared yet and can be loaded. Read on every call. */
  getDeferredTools: () => readonly AgentTool[];
  /** Declare these tools from the next model call. */
  load: (names: readonly string[]) => void;
  /** Namespace of a tool (for example its MCP server), weighted lightly in ranking. */
  namespaceOf?: (tool: AgentTool) => ToolSearchNamespace | undefined;
  ranker?: ToolRanker;
  defaultLimit?: number;
}

/** The description stays the same as tools are registered, so it does not list them. */
export const TOOL_SEARCH_DESCRIPTION = `Searches tools that were not provided to you up front (for example the tools of MCP servers) and loads the matches, so you can call them from your next turn. When you need a capability you do not see in your tools, use ${TOOL_SEARCH_TOOL_NAME} first.`;

const toolSearchParameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query for deferred tools." },
    limit: {
      type: "number",
      description: `Maximum number of tools to load. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.`,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/** The `tool_search` tool over a set of deferred tools. */
export function createToolSearchTool(
  options: ToolSearchToolOptions,
): AgentTool<typeof toolSearchParameters, ToolSearchToolDetails> {
  const ranker = options.ranker ?? new Bm25Ranker();
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    label: "Tool search",
    description: TOOL_SEARCH_DESCRIPTION,
    parameters: toolSearchParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params: { query: string; limit?: number }) {
      const query = params.query ?? "";
      if (query.trim() === "") throw new Error("query must not be empty");
      const max = params.limit ?? options.defaultLimit ?? DEFAULT_TOOL_SEARCH_LIMIT;
      if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
      const candidates = options.getDeferredTools();
      const documents = candidates.map((tool) =>
        createToolSearchDocument(tool, options.namespaceOf?.(tool)),
      );
      const matches = ranker.rank(query, documents, max);
      if (matches.length > 0) options.load(matches.map((match) => match.name));
      const found = matches.map((match) => ({
        name: match.name,
        description: candidates.find((tool) => tool.name === match.name)?.description ?? "",
      }));
      const text =
        found.length === 0
          ? "No matching tools found."
          : `Loaded ${found.length} tool${found.length === 1 ? "" : "s"}. They are available from your next call:\n${found
              .map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0] ?? ""}`)
              .join("\n")}`;
      return {
        content: [{ type: "text", text }],
        details: { loaded: found.map((tool) => tool.name) },
      };
    },
  };
}
