// Continual harness state: entries, refinement events, persistence, merge and history. Adapted from
// Prime Agent's `crates/pa-core/src/refinement/mod.rs` (PrimeIntellect-ai/prime-agent). Prime's
// `factory` kind (state-machine workflows run by its Python kernel) is not ported.
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

export const REFINEMENT_KINDS = ["prompt", "memory", "skill", "subagent"] as const;
export type RefinementKind = (typeof REFINEMENT_KINDS)[number];
export type RefinementAction = "create" | "update" | "delete";
export type HarnessScope = "local" | "global";

export const HARNESS_STATE_FILE_NAME = "harness_state.json";
export const REFINEMENT_HISTORY_FILE_NAME = "refinement_history.jsonl";
export const DEFAULT_OVERVIEW_ENTRY_LIMIT = 3;
export const DEFAULT_OVERVIEW_REFINEMENT_LIMIT = 10;
export const DEFAULT_OVERVIEW_CONTENT_LIMIT = 140;

type JsonRecord = Record<string, unknown>;

/** One editable continual harness entry. */
export interface HarnessEntry {
  readonly id: string;
  readonly kind: RefinementKind;
  readonly title: string;
  readonly content: string;
  readonly path: string;
  readonly scope?: HarnessScope;
  readonly reference: JsonRecord;
  readonly arguments: JsonRecord;
  readonly metadata: JsonRecord;
  readonly source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
}

export interface HarnessRefinementEvent {
  readonly id: string;
  readonly trigger: string;
  readonly changes: readonly string[];
  readonly evidence: string;
  readonly outcome: string;
  readonly created_at: string;
}

export interface HarnessState {
  schema: number;
  entries: Record<RefinementKind, Record<string, HarnessEntry>>;
  refinements: HarnessRefinementEvent[];
}

/** One applied (or refused) edit, with the entry before and after, kept for rollback. */
export interface AppliedRefinementEdit {
  readonly action: RefinementAction;
  readonly kind: RefinementKind;
  readonly id: string;
  readonly title?: string;
  readonly content?: string;
  readonly path?: string;
  readonly reference?: JsonRecord;
  readonly arguments?: JsonRecord;
  readonly metadata?: JsonRecord;
  readonly before?: HarnessEntry;
  readonly after?: HarnessEntry;
  readonly applied: boolean;
  readonly error?: string;
  readonly reason?: string;
}

export interface RefinementResult {
  readonly id: string;
  readonly summary: string;
  readonly rationale: string;
  readonly expectedOutcome: string;
  readonly appliedEdits: readonly AppliedRefinementEdit[];
  readonly harnessStatePath: string;
  readonly rollbackOf?: string;
  readonly scope?: HarnessScope;
}

export function emptyHarnessState(): HarnessState {
  return {
    schema: 1,
    entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
    refinements: [],
  };
}

export function cloneHarnessState(state: HarnessState): HarnessState {
  return structuredClone(state);
}

export function harnessStatePath(dir: string): string {
  return join(dir, HARNESS_STATE_FILE_NAME);
}

export function refinementHistoryPath(dir: string): string {
  return join(dir, REFINEMENT_HISTORY_FILE_NAME);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asEntry(
  value: unknown,
  kind: RefinementKind,
  scope: HarnessScope,
): HarnessEntry | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["title"] !== "string") {
    return undefined;
  }
  const text = (key: string, fallback = "") =>
    typeof value[key] === "string" ? (value[key] as string) : fallback;
  return {
    id: value["id"],
    kind,
    title: value["title"],
    content: text("content"),
    path: text("path", "general"),
    scope: value["scope"] === "local" || value["scope"] === "global" ? value["scope"] : scope,
    reference: isRecord(value["reference"]) ? value["reference"] : {},
    arguments: isRecord(value["arguments"]) ? value["arguments"] : {},
    metadata: isRecord(value["metadata"]) ? value["metadata"] : {},
    source: text("source", "refine"),
    created_at: text("created_at"),
    updated_at: text("updated_at"),
    version: typeof value["version"] === "number" ? value["version"] : 1,
  };
}

/** Reads the state in `dir`. A missing or malformed file reads as an empty state. */
export async function loadHarnessState(dir: string, scope: HarnessScope): Promise<HarnessState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(harnessStatePath(dir), "utf8"));
  } catch {
    return emptyHarnessState();
  }
  if (!isRecord(parsed)) {
    return emptyHarnessState();
  }
  const state = emptyHarnessState();
  state.schema = typeof parsed["schema"] === "number" ? parsed["schema"] : 1;
  const entries = isRecord(parsed["entries"]) ? parsed["entries"] : {};
  for (const kind of REFINEMENT_KINDS) {
    const records = isRecord(entries[kind]) ? entries[kind] : {};
    for (const [id, raw] of Object.entries(records)) {
      const entry = asEntry(raw, kind, scope);
      if (entry !== undefined) {
        state.entries[kind][id] = entry;
      }
    }
  }
  if (Array.isArray(parsed["refinements"])) {
    state.refinements = parsed["refinements"].filter(
      (event): event is HarnessRefinementEvent =>
        isRecord(event) && typeof event["id"] === "string" && Array.isArray(event["changes"]),
    );
  }
  return state;
}

/** Writes the state atomically (temp file and rename), readable by the owner only. */
export async function saveHarnessState(dir: string, state: HarnessState): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = harnessStatePath(dir);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  return path;
}

/** Global entries plus local ones; a local id that collides with a global one gets a `local:` prefix. */
export function mergeHarnessStates(global: HarnessState, local?: HarnessState): HarnessState {
  const merged = emptyHarnessState();
  merged.schema = Math.max(global.schema, local?.schema ?? 1);
  for (const kind of REFINEMENT_KINDS) {
    for (const [id, entry] of Object.entries(global.entries[kind])) {
      merged.entries[kind][id] = { ...entry, scope: "global" };
    }
    for (const [id, entry] of Object.entries(local?.entries[kind] ?? {})) {
      const mergedId = id in merged.entries[kind] ? `local:${id}` : id;
      merged.entries[kind][mergedId] = { ...entry, scope: "local" };
    }
  }
  merged.refinements = [...global.refinements, ...(local?.refinements ?? [])];
  return merged;
}

export function inferRefinementResultScope(result: RefinementResult): HarnessScope | undefined {
  if (result.scope !== undefined) {
    return result.scope;
  }
  const scopes = new Set<HarnessScope>();
  for (const edit of result.appliedEdits) {
    const scope = (edit.after ?? edit.before)?.scope;
    if (scope !== undefined) {
      scopes.add(scope);
    }
  }
  return scopes.size === 1 ? [...scopes][0] : undefined;
}

export async function appendRefinementHistory(
  dir: string,
  result: RefinementResult,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = refinementHistoryPath(dir);
  await appendFile(path, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  return path;
}

/** Reads a history log; malformed lines are skipped and a missing scope is filled in. */
export async function loadRefinementHistory(
  dir: string,
  scope: HarnessScope,
): Promise<RefinementResult[]> {
  let content: string;
  try {
    content = await readFile(refinementHistoryPath(dir), "utf8");
  } catch {
    return [];
  }
  const results: RefinementResult[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as RefinementResult;
      if (typeof parsed.id === "string" && Array.isArray(parsed.appliedEdits)) {
        results.push(parsed.scope === undefined ? { ...parsed, scope } : parsed);
      }
    } catch {
      // Skip a torn or hand-edited line.
    }
  }
  return results;
}

/** Global and session history merged by id; session rows win and keep an existing scope. */
export function mergeRefinementHistory(
  global: readonly RefinementResult[],
  session: readonly RefinementResult[],
): RefinementResult[] {
  const byId = new Map<string, RefinementResult>();
  for (const result of global) {
    byId.set(result.id, result);
  }
  for (const result of session) {
    const existing = byId.get(result.id);
    byId.set(
      result.id,
      result.scope === undefined && existing?.scope !== undefined
        ? { ...result, scope: existing.scope }
        : result,
    );
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function compactText(text: string, maxLength: number): string {
  const normalized = text.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...normalized];
  if (chars.length <= maxLength) {
    return normalized;
  }
  return `${chars.slice(0, Math.max(0, maxLength - 3)).join("")}...`;
}

/** A short notice of what a refinement changed. */
export function formatRefinementNotice(result: RefinementResult): string {
  const lines = [compactText(result.summary, DEFAULT_OVERVIEW_CONTENT_LIMIT)];
  for (const edit of result.appliedEdits) {
    if (!edit.applied) {
      continue;
    }
    const entry = edit.after ?? edit.before;
    const scope = entry?.scope ?? result.scope ?? "local";
    lines.push(
      `- ${edit.action} ${edit.kind} [${scope}:${edit.id}] ${entry?.title ?? edit.id}: ${compactText(entry?.content ?? "", DEFAULT_OVERVIEW_CONTENT_LIMIT)}`,
    );
  }
  return lines.join("\n");
}
