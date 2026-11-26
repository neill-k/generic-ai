// Agent tools over the continual harness: `refine` (Prime Agent's `refine.run()`), and
// `harness_read` and `harness_search` for full entries (Prime's `harness` helpers).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import type { AgentTool, AgentToolResult } from "@generic-ai/agent";
import { Type } from "@sinclair/typebox";

import type { RefineOptions } from "./executor.js";
import {
  harnessQueryTermsFromText,
  rankHarnessEntries,
  scoreHarnessEntryForQuery,
} from "./ranking.js";
import { compactText, type HarnessEntry, type HarnessState, REFINEMENT_KINDS } from "./state.js";

export const REFINE_TOOL = "refine";
export const HARNESS_READ_TOOL = "harness_read";
export const HARNESS_SEARCH_TOOL = "harness_search";

// biome-ignore lint/suspicious/noExplicitAny: tools carry their own parameter and detail types.
export type ContinualTool = AgentTool<any, any> & {
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
};

export interface ContinualToolsOptions {
  /** The merged state the agent sees, read fresh on each call. */
  readonly state: () => HarnessState;
  /**
   * Called when the agent asks for a refinement. The host runs it once the current turn ends,
   * because the planner reads the whole conversation.
   */
  readonly onRefine: (options: RefineOptions) => void;
  /** Whether a local refinement can be made (the session has a local store). Default true. */
  readonly localAvailable?: boolean;
}

function text(lines: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: lines }], details };
}

function findEntry(state: HarnessState, id: string, kind?: string): HarnessEntry | undefined {
  const bare = id.replace(/^(local|global):/, "");
  for (const entryKind of REFINEMENT_KINDS) {
    if (kind !== undefined && kind !== entryKind) {
      continue;
    }
    const records = state.entries[entryKind];
    const found = records[id] ?? records[bare] ?? records[`local:${bare}`];
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export function formatHarnessEntry(entry: HarnessEntry): string {
  const lines = [
    `[${entry.scope ?? "global"}:${entry.id}] ${entry.title}`,
    `kind: ${entry.kind}, path: ${entry.path}, version: ${entry.version}, updated: ${entry.updated_at || "unknown"}`,
  ];
  if (Object.keys(entry.reference).length > 0) {
    lines.push(`reference: ${JSON.stringify(entry.reference)}`);
  }
  if (Object.keys(entry.arguments).length > 0) {
    lines.push(`arguments: ${JSON.stringify(entry.arguments)}`);
  }
  lines.push("", entry.content);
  return lines.join("\n");
}

export function createContinualTools(options: ContinualToolsOptions): ContinualTool[] {
  return [
    {
      name: REFINE_TOOL,
      label: "Refine harness",
      description:
        "Ask for a continual harness refinement: small, evidence-backed edits to supplemental prompt notes, memories, skills and subagent specs, made from this conversation when the current turn ends. Local refinements stay with this session; global ones (global: true) persist across sessions and are only for durable lessons. Pass rollback_id to undo an earlier refinement.",
      promptSnippet:
        "record a durable lesson, skill, memory or subagent spec in the continual harness",
      parameters: Type.Object({
        instructions: Type.Optional(
          Type.String({ description: "What the refinement should capture or fix." }),
        ),
        global: Type.Optional(
          Type.Boolean({ description: "Persist across sessions instead of this session only." }),
        ),
        rollback_id: Type.Optional(
          Type.String({ description: "Undo this earlier refinement (refine_...)." }),
        ),
      }),
      execute: async (_id, params) => {
        const global = params.global === true;
        if (!global && params.rollback_id === undefined && options.localAvailable === false) {
          throw new Error(
            "this session has no local harness store; pass global: true for a durable lesson",
          );
        }
        const refine: RefineOptions = {
          ...(global ? { global } : {}),
          ...(params.instructions === undefined ? {} : { instructions: params.instructions }),
          ...(params.rollback_id === undefined ? {} : { rollbackId: params.rollback_id }),
        };
        options.onRefine(refine);
        return text(
          params.rollback_id === undefined
            ? `Refinement scheduled (${global ? "global" : "local"}); it runs when this turn ends.`
            : `Rollback of ${params.rollback_id} scheduled; it runs when this turn ends.`,
          refine,
        );
      },
    },
    {
      name: HARNESS_READ_TOOL,
      label: "Read harness entry",
      description:
        "Read a continual harness entry in full. The harness state in the system prompt shows only summaries; ids look like `local:my-note` or `global:my-skill`.",
      parameters: Type.Object({
        id: Type.String({ description: "The entry id, with or without its scope prefix." }),
        kind: Type.Optional(
          Type.Union(
            REFINEMENT_KINDS.map((kind) => Type.Literal(kind)),
            { description: "Limit the lookup to one kind." },
          ),
        ),
      }),
      execute: async (_id, params) => {
        const entry = findEntry(options.state(), params.id, params.kind);
        if (entry === undefined) {
          throw new Error(`no harness entry "${params.id}"`);
        }
        return text(formatHarnessEntry(entry), entry);
      },
    },
    {
      name: HARNESS_SEARCH_TOOL,
      label: "Search harness",
      description:
        "Search continual harness entries by relevance to a query, including entries the system prompt left out.",
      parameters: Type.Object({
        query: Type.String({ description: "Words describing what you need." }),
        kind: Type.Optional(Type.Union(REFINEMENT_KINDS.map((kind) => Type.Literal(kind)))),
        limit: Type.Optional(
          Type.Number({ description: "At most this many results. Default 10." }),
        ),
      }),
      execute: async (_id, params) => {
        const state = options.state();
        const terms = harnessQueryTermsFromText(params.query);
        const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 10)));
        const hits: HarnessEntry[] = [];
        for (const kind of REFINEMENT_KINDS) {
          if (params.kind !== undefined && params.kind !== kind) {
            continue;
          }
          const ranked = rankHarnessEntries(Object.values(state.entries[kind]), terms);
          hits.push(...ranked.filter((entry) => scoreHarnessEntryForQuery(entry, terms) > 0));
        }
        const top = rankHarnessEntries(hits, terms).slice(0, limit);
        return text(
          top.length === 0
            ? "No matching harness entries."
            : top
                .map(
                  (entry) =>
                    `- [${entry.scope ?? "global"}:${entry.id}] ${entry.kind} ${entry.title}: ${compactText(entry.content, 200)}`,
                )
                .join("\n"),
          top.map((entry) => ({ id: entry.id, kind: entry.kind, scope: entry.scope })),
        );
      },
    },
  ];
}
