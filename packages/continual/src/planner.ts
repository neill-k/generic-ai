// The refinement planner: the system prompt, proposal parsing and validation, applying edits, and
// rollback. Adapted from Prime Agent's `crates/pa-core/src/refinement/planner.rs`
// (PrimeIntellect-ai/prime-agent). Skill entries name a shell command or an installed skill instead
// of a Python REPL callable, and subagent entries are spawned with `spawn_agent`.
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import {
  type AppliedRefinementEdit,
  type HarnessEntry,
  type HarnessScope,
  type HarnessState,
  REFINEMENT_KINDS,
  type RefinementAction,
  type RefinementKind,
  type RefinementResult,
} from "./state.js";

type JsonRecord = Record<string, unknown>;

export const REFINEMENT_SYSTEM_PROMPT = `You are the /refine continual harness subsystem of a Generic AI agent.

Your job is to improve the editable continual harness state from the current trajectory.
This is similar in spirit to context compaction, but instead of summarizing the
conversation you emit precise create, update, or delete edits to reusable state.
The continual harness is the persistent, editable set of prompt notes, memories,
skills, and subagent specs that lets the agent improve reusable behavior outside
the token history.

Continual harness components:
- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: a repeatable procedure the agent runs. Skill create/update edits MUST include a \`reference\` object, either \`{"type":"command","command":"<shell command pattern>"}\` for a script or CLI the agent runs with bash, or \`{"type":"skill","name":"<installed skill name>"}\` for an installed skill; they also MUST include an \`arguments\` object describing accepted inputs, required fields, defaults, and constraints. Use \`{}\` for \`arguments\` only when the procedure truly needs no inputs.
- subagent: a reusable delegation spec: purpose, instructions, and when to invoke. The agent turns it into a concise task prompt and starts it with the \`spawn_agent\` tool; results come back through \`collect_agents\` or agent messages. Do not invent other ways to call subagents.

Scope and persistence policy:
- The default store is local to the current session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.
- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.
- Entry ids in the harness overview may carry a display-only \`local:\` or \`global:\` prefix. Always use the bare id (no prefix) in edits.
- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.
- Project-specific lessons may be persisted globally only when the title, path, or content explicitly names the project and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.
- Use memory for declarative facts and preferences, skill for repeatable procedures, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.
- Create or update the smallest relevant component.

Use the trajectory, current continual harness state, and prior refinement history. Prefer
small evidence-backed edits. If prior refinements caused issues, roll back or
replace the faulty editable entries. Never edit source files directly. Output
JSON only with this exact shape:

{
  "summary": "one sentence",
  "rationale": "why these edits are justified by trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update except delete",
      "content": "required for create/update except delete",
      "path": "optional grouping path",
      "reference": {"type": "command", "command": "bash scripts/check.sh --since <date>"},
      "arguments": {"since": {"type": "string", "required": true, "description": "accepted input"}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

export const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;
export const REFINEMENT_CONTEXT_OVERHEAD_TOKENS = 1024;
export const TRUNCATED_JSON_ERROR =
  "the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

export interface RefinementEdit {
  readonly action?: RefinementAction;
  readonly kind?: RefinementKind;
  readonly id?: string;
  readonly title?: string;
  readonly content?: string;
  readonly path?: string;
  readonly reference?: JsonRecord;
  readonly arguments?: JsonRecord;
  readonly metadata?: JsonRecord;
  readonly reason?: string;
}

export interface RefinementProposal {
  readonly summary: string;
  readonly rationale: string;
  readonly expectedOutcome: string;
  readonly edits: readonly RefinementEdit[];
}

/** Whether a JSON candidate ends mid-value (a truncated reply rather than a malformed one). */
export function isIncompleteJson(candidate: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
  return inString || depth > 0;
}

function parseCandidate(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch (error) {
    if (isIncompleteJson(candidate)) {
      throw new Error(TRUNCATED_JSON_ERROR);
    }
    throw new Error(`Refiner returned invalid JSON: ${(error as Error).message}`);
  }
}

/** The JSON object in a reply: bare, fenced, or embedded in text. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseCandidate(trimmed);
  }
  const fence = trimmed.indexOf("```");
  if (fence !== -1) {
    const afterFence = trimmed
      .slice(fence + 3)
      .replace(/^json/, "")
      .trimStart();
    const end = afterFence.indexOf("```");
    if (end !== -1) {
      return parseCandidate(afterFence.slice(0, end).trim());
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return parseCandidate(trimmed.slice(start));
    }
  }
  if (isIncompleteJson(trimmed)) {
    throw new Error(TRUNCATED_JSON_ERROR);
  }
  throw new Error("Refiner did not return a JSON object");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEdit(value: JsonRecord): RefinementEdit {
  const text = (key: string) =>
    typeof value[key] === "string" ? (value[key] as string) : undefined;
  const record = (key: string) => (isRecord(value[key]) ? (value[key] as JsonRecord) : undefined);
  const action = text("action");
  const kind = text("kind");
  const fields: Record<string, unknown> = {
    action: action === "create" || action === "update" || action === "delete" ? action : undefined,
    kind: (REFINEMENT_KINDS as readonly string[]).includes(kind ?? "") ? kind : undefined,
    id: text("id"),
    title: text("title"),
    content: text("content"),
    path: text("path"),
    reference: record("reference"),
    arguments: record("arguments"),
    metadata: record("metadata"),
    reason: text("reason"),
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, field]) => field !== undefined),
  ) as RefinementEdit;
}

/** Normalizes an untrusted proposal; invalid edits are kept so applying reports why they failed. */
export function normalizeRefinementProposal(value: unknown): RefinementProposal {
  const record = isRecord(value) ? value : {};
  const text = (key: string, fallback: string) =>
    typeof record[key] === "string" ? (record[key] as string) : fallback;
  return {
    summary: text("summary", "Refined continual harness state"),
    rationale: text("rationale", ""),
    expectedOutcome: text("expectedOutcome", ""),
    edits: (Array.isArray(record["edits"]) ? record["edits"] : [])
      .filter(isRecord)
      .map(normalizeEdit),
  };
}

export function parseProposal(text: string): RefinementProposal {
  const value = extractJsonObject(text);
  if (!isRecord(value)) {
    throw new Error("Refiner JSON must be an object");
  }
  return normalizeRefinementProposal(value);
}

export function slug(raw: string, fallback: string): string {
  let normalized = "";
  for (const char of raw.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(char)) {
      normalized += char;
    } else if (!normalized.endsWith("_")) {
      normalized += "_";
    }
  }
  const trimmed = normalized.replace(/^_+|_+$/g, "").slice(0, 80);
  return trimmed.length === 0 ? fallback : trimmed;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateEdit(
  edit: RefinementEdit,
  computedId: string | undefined,
): string | undefined {
  if (edit.action === undefined) {
    return "unsupported action";
  }
  if (edit.kind === undefined) {
    return "unsupported kind";
  }
  if (
    edit.kind === "prompt" &&
    (edit.id === "base_system_prompt" || computedId === "base_system_prompt")
  ) {
    return "base system prompt is not editable";
  }
  if (edit.action !== "create" && edit.id === undefined) {
    return `${edit.action} requires id`;
  }
  if (edit.action !== "delete" && (edit.title === undefined || edit.content === undefined)) {
    return `${edit.action} requires title and content`;
  }
  if (edit.action !== "delete" && edit.kind === "skill") {
    if (edit.arguments === undefined) {
      return `${edit.action} skill requires arguments`;
    }
    const reference = edit.reference;
    if (reference === undefined) {
      return `${edit.action} skill requires a reference`;
    }
    if (reference["type"] === "command") {
      if (!nonEmpty(reference["command"])) {
        return `${edit.action} skill requires a command`;
      }
    } else if (reference["type"] === "skill") {
      if (!nonEmpty(reference["name"])) {
        return `${edit.action} skill requires a skill name`;
      }
    } else {
      return `${edit.action} skill reference.type must be command or skill`;
    }
  }
  return undefined;
}

export interface ApplyOptions {
  readonly id: string;
  readonly rollbackOf?: string;
  readonly scope?: HarnessScope;
  /** The target store as it was before planning; edits to entries changed since then are refused. */
  readonly baselineState?: HarnessState;
  readonly now?: () => string;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function planned(
  edit: RefinementEdit,
  action: RefinementAction,
  kind: RefinementKind,
  id: string,
  outcome: Partial<AppliedRefinementEdit>,
): AppliedRefinementEdit {
  const { action: _action, kind: _kind, id: _id, ...fields } = edit;
  return { ...fields, action, kind, id, applied: false, ...outcome };
}

/** Applies a proposal to `state` and records the refinement event. */
export function applyRefinementProposal(
  state: HarnessState,
  proposal: RefinementProposal,
  options: ApplyOptions,
): RefinementResult {
  const now = options.now ?? (() => new Date().toISOString());
  const appliedEdits: AppliedRefinementEdit[] = [];
  const modified = new Set<string>();
  for (const edit of proposal.edits) {
    const fallbackKind = edit.kind ?? "memory";
    const computedId =
      edit.id ??
      (edit.action === "create" ? slug(edit.title ?? fallbackKind, fallbackKind) : undefined);
    const id = computedId ?? "";
    const error = validateEdit(edit, computedId);
    if (edit.kind === undefined || edit.action === undefined || error !== undefined) {
      appliedEdits.push(
        planned(edit, edit.action ?? "create", fallbackKind, id, {
          ...(error === undefined ? {} : { error }),
        }),
      );
      continue;
    }
    const { action, kind } = edit;
    const records = state.entries[kind];
    const before = records[id];
    const key = `${kind}:${id}`;
    if (
      options.baselineState !== undefined &&
      !modified.has(key) &&
      !same(before, options.baselineState.entries[kind][id])
    ) {
      appliedEdits.push(
        planned(edit, action, kind, id, {
          ...(before === undefined ? {} : { before }),
          error: "entry changed during refinement planning",
        }),
      );
      continue;
    }
    if (action === "delete") {
      if (before === undefined) {
        appliedEdits.push(planned(edit, action, kind, id, { error: "entry not found" }));
        continue;
      }
      delete records[id];
      modified.add(key);
      appliedEdits.push(planned(edit, action, kind, id, { before, applied: true }));
      continue;
    }
    if (action === "create" && before !== undefined) {
      appliedEdits.push(planned(edit, action, kind, id, { before, error: "entry already exists" }));
      continue;
    }
    if (action === "update" && before === undefined) {
      appliedEdits.push(planned(edit, action, kind, id, { error: "entry not found" }));
      continue;
    }
    const timestamp = now();
    const after: HarnessEntry = {
      id,
      kind,
      title: edit.title ?? before?.title ?? id,
      content: edit.content ?? before?.content ?? "",
      path: edit.path ?? before?.path ?? "general",
      scope: before?.scope ?? options.scope ?? "local",
      reference: edit.reference ?? before?.reference ?? {},
      arguments: edit.arguments ?? before?.arguments ?? {},
      metadata: edit.metadata ?? before?.metadata ?? {},
      source: "refine",
      created_at: before?.created_at ?? timestamp,
      updated_at: timestamp,
      version: (before?.version ?? 0) + 1,
    };
    records[id] = after;
    modified.add(key);
    appliedEdits.push(
      planned(edit, action, kind, id, {
        ...(before === undefined ? {} : { before }),
        after,
        applied: true,
      }),
    );
  }
  state.refinements.push({
    id: options.id,
    trigger: proposal.summary,
    changes: appliedEdits
      .filter((edit) => edit.applied)
      .map((edit) => `${edit.action} ${edit.kind}:${edit.id}`),
    evidence: proposal.rationale,
    outcome: proposal.expectedOutcome,
    created_at: now(),
  });
  return {
    id: options.id,
    summary: proposal.summary,
    rationale: proposal.rationale,
    expectedOutcome: proposal.expectedOutcome,
    appliedEdits,
    harnessStatePath: "",
    ...(options.rollbackOf === undefined ? {} : { rollbackOf: options.rollbackOf }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  };
}

/** The proposal that reverts an applied refinement, newest edit first. */
export function rollbackProposal(target: RefinementResult): RefinementProposal {
  const edits: RefinementEdit[] = [];
  for (const edit of [...target.appliedEdits].reverse()) {
    if (!edit.applied) {
      continue;
    }
    if (edit.before !== undefined) {
      edits.push({
        action: edit.after === undefined ? "create" : "update",
        kind: edit.kind,
        id: edit.id,
        title: edit.before.title,
        content: edit.before.content,
        path: edit.before.path,
        reference: edit.before.reference,
        arguments: edit.before.arguments,
        metadata: edit.before.metadata,
        reason: `Rollback ${target.id}`,
      });
    } else if (edit.after !== undefined) {
      edits.push({
        action: "delete",
        kind: edit.kind,
        id: edit.id,
        reason: `Rollback ${target.id}`,
      });
    }
  }
  return {
    summary: `Rollback refinement ${target.id}`,
    rationale: `Restores continual harness state snapshots from refinement ${target.id}.`,
    expectedOutcome: "Faulty refinement edits are reverted.",
    edits,
  };
}

function tokenBound(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Fits a refinement request into the model's context: the conversation is trimmed from the front
 * (binary search) and the output budget clamped. Returns the output budget and the user prompt.
 */
export function fitRefinementRequest(
  model: { readonly contextWindow: number; readonly maxTokens: number },
  systemPrompt: string,
  conversationText: string,
  buildPrompt: (conversation: string) => string,
  outputReserve: number,
): { maxTokens: number; userPrompt: string } {
  const systemReserve = tokenBound(systemPrompt) + REFINEMENT_CONTEXT_OVERHEAD_TOKENS;
  const inputBudget =
    model.contextWindow -
    Math.min(model.maxTokens, outputReserve, Math.floor(model.contextWindow / 2));
  let userPrompt = buildPrompt(conversationText);
  if (systemReserve + tokenBound(userPrompt) > inputBudget && conversationText.length > 0) {
    const promptFor = (length: number) =>
      buildPrompt(
        `[Earlier conversation omitted to fit the model context.]\n${conversationText.slice(conversationText.length - length)}`,
      );
    let low = 0;
    let high = conversationText.length;
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      if (systemReserve + tokenBound(promptFor(length)) <= inputBudget) {
        low = length;
      } else {
        high = length - 1;
      }
    }
    userPrompt = promptFor(low);
  }
  const maxTokens = Math.min(
    model.maxTokens,
    model.contextWindow - systemReserve - tokenBound(userPrompt),
  );
  if (maxTokens <= 0) {
    throw new Error(
      "Refinement prompt leaves no room for output in the model's context window; retry with a smaller request.",
    );
  }
  return { maxTokens, userPrompt };
}
