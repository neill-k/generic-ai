import { randomUUID } from "node:crypto";

import {
  type AppliedRefinementEdit,
  applyRefinementProposal,
  emptyHarnessState,
  type HarnessEntry,
  type HarnessState,
  harnessQueryTermsFromText,
  REFINEMENT_KINDS,
  type RefinementEdit,
  type RefinementKind,
  rankHarnessEntries,
  rollbackProposal,
} from "@generic-ai/continual";
import type { StorageContract } from "@generic-ai/sdk";

/**
 * The company's one memory system (design decision 17). It replaces the per-agent notes file
 * (`context.md`), the remember-and-search store and the session-local continual harness entries.
 *
 * Two layers:
 * - the company handbook (`company`), which every agent reads: who the owner is, how he likes
 *   things done, facts about the company. The owner and the preference scanner write it.
 * - private memory per agent (`agent:<id>`): what the agent has learned doing its job. The agent
 *   writes it with its `remember` and `forget` tools, and dreaming consolidates it.
 *
 * Entries use the continual harness shape (prompt notes, memories, skills and subagent specs), so
 * the refine planner ported from Prime Agent can work on them offline. Every entry records where it
 * came from (`metadata.origin`), every change is kept with the entry before and after it, and any
 * change can be undone. Memory lives in host storage, outside the company folder, so agents can
 * only change it through their tools.
 *
 * Who may change what is enforced here, not by prompts:
 * - the owner may change anything; an entry he wrote or edited is locked against everyone else;
 * - the preference scanner may add and update unlocked handbook and agent entries;
 * - an agent may change only its own memories;
 * - dreaming may change only the dreaming agent's own private memory (decision 41): never the
 *   handbook, never another agent, never a locked entry. Goal checks and the owner's permissions
 *   and standing rules live in other stores this module cannot write.
 */
export type MemoryScope = "company" | `agent:${string}`;

export type MemoryActorKind = "owner" | "agent" | "scanner" | "dream" | "import";

export interface MemoryActor {
  readonly kind: MemoryActorKind;
  /** The agent, for `agent` and `dream`. The owner's user id, for `owner`. */
  readonly id?: string;
}

/** Where a memory came from. */
export interface MemoryOrigin {
  /** `owner` edits, `agent` tool calls, `chat` scans of owner messages, `dream`, `import`. */
  readonly kind: "owner" | "agent" | "chat" | "dream" | "import" | "undo";
  /** What it points at: a task id, `thread/<id>/message/<n>`, a session file, a change id. */
  readonly ref?: string;
  /** A short human description, such as a quote of the owner's words. */
  readonly note?: string;
  readonly at: string;
}

/** One memory as the API and UI see it. */
export interface MemoryEntryView {
  readonly id: string;
  readonly kind: RefinementKind;
  readonly title: string;
  readonly content: string;
  readonly path: string;
  readonly reference: Record<string, unknown>;
  readonly arguments: Record<string, unknown>;
  readonly origin?: MemoryOrigin;
  readonly locked: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** An edit to one memory, as the planner and the API send it. */
export type MemoryEdit = RefinementEdit;

/** One recorded change: what was asked, by whom, and each edit's before and after. */
export interface MemoryChange {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly actor: MemoryActor;
  readonly origin: MemoryOrigin;
  readonly summary: string;
  readonly rationale?: string;
  readonly createdAt: string;
  readonly edits: readonly AppliedRefinementEdit[];
  /** Set on an undo: the change it reverted. */
  readonly undoOf?: string;
  /** Set once the change was undone. */
  readonly undoneBy?: string;
}

export interface ApplyMemoryInput {
  readonly scope: MemoryScope;
  readonly actor: MemoryActor;
  readonly edits: readonly MemoryEdit[];
  /** Where the edits came from. Defaults to the actor's kind, now. */
  readonly origin?: Omit<MemoryOrigin, "at"> & { readonly at?: string };
  readonly summary?: string;
  readonly rationale?: string;
}

export interface ApplyMemoryResult {
  /** The recorded change, when at least one edit applied. */
  readonly change?: MemoryChange;
  readonly edits: readonly AppliedRefinementEdit[];
}

export interface MemoryPromptOptions {
  /** Text the agent is about to work on; memories are ranked by relevance to it. */
  readonly query?: string;
  /** Most private memories shown. Default 25. */
  readonly maxMemories?: number;
  /** Longest handbook section, in characters. Default 8,000. */
  readonly maxHandbookChars?: number;
}

export interface CompanyMemory {
  read(scope: MemoryScope): Promise<HarnessState>;
  list(scope: MemoryScope): Promise<readonly MemoryEntryView[]>;
  /** Agents that have private memory, with entry counts. */
  scopes(): Promise<readonly { readonly scope: MemoryScope; readonly entries: number }[]>;
  apply(input: ApplyMemoryInput): Promise<ApplyMemoryResult>;
  changes(options?: {
    readonly scope?: MemoryScope;
    readonly limit?: number;
  }): Promise<readonly MemoryChange[]>;
  getChange(id: string): Promise<MemoryChange | undefined>;
  /** Reverts a change. Only the owner undoes; an entry changed since is left alone and reported. */
  undo(changeId: string, actor: MemoryActor): Promise<ApplyMemoryResult>;
  /** Handbook and private memory as a prompt section for one agent's turn. */
  promptSection(agentId: string, options?: MemoryPromptOptions): Promise<string>;
  /** Text search over the handbook and one agent's memory. */
  search(
    agentId: string,
    query: string,
    limit?: number,
  ): Promise<readonly (MemoryEntryView & { readonly scope: MemoryScope })[]>;
}

export interface CompanyMemoryOptions {
  readonly kv: StorageContract;
  readonly now?: () => Date;
  readonly createId?: () => string;
  /**
   * Reads an agent's old `context.md` notes. On first use of an agent's memory, notes it wrote
   * there are imported as one entry, so nothing learned before this system is lost.
   */
  readonly legacyNotes?: (agentId: string) => Promise<string>;
}

export class MemoryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export const MEMORY_NAMESPACE = "generic-corp-memory";
const STATE_COLLECTION = "state";
const CHANGE_COLLECTION = "changes";
export const COMPANY_SCOPE: MemoryScope = "company";
const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 20_000;
const LEGACY_PREAMBLE = "This is your memory file. It persists across tasks.";

export const REFINEMENT_KIND_NAMES: readonly string[] = REFINEMENT_KINDS;

export function agentScope(agentId: string): MemoryScope {
  return `agent:${agentId}`;
}

export function parseMemoryScope(raw: string): MemoryScope {
  if (raw === "company") {
    return COMPANY_SCOPE;
  }
  const agentId = raw.startsWith("agent:") ? raw.slice("agent:".length) : raw;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId)) {
    throw new MemoryError(400, `"${raw}" is not a memory scope: use "company" or an agent id.`);
  }
  return agentScope(agentId);
}

export function scopeAgentId(scope: MemoryScope): string | undefined {
  return scope === COMPANY_SCOPE ? undefined : scope.slice("agent:".length);
}

function originOf(entry: HarnessEntry | undefined): MemoryOrigin | undefined {
  const origin = entry?.metadata["origin"];
  return typeof origin === "object" && origin !== null ? (origin as MemoryOrigin) : undefined;
}

export function isLocked(entry: HarnessEntry | undefined): boolean {
  return entry?.metadata["locked"] === true;
}

export function viewEntry(entry: HarnessEntry): MemoryEntryView {
  const origin = originOf(entry);
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    content: entry.content,
    path: entry.path,
    reference: entry.reference,
    arguments: entry.arguments,
    ...(origin === undefined ? {} : { origin }),
    locked: isLocked(entry),
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    version: entry.version,
  };
}

function entriesOf(state: HarnessState): HarnessEntry[] {
  return REFINEMENT_KINDS.flatMap((kind) => Object.values(state.entries[kind]));
}

/** Kinds each actor may write. The owner and imports may write any kind. */
const ACTOR_KINDS: Record<MemoryActorKind, readonly RefinementKind[]> = {
  owner: REFINEMENT_KINDS,
  import: REFINEMENT_KINDS,
  scanner: ["memory", "prompt"],
  agent: ["memory"],
  dream: ["memory", "prompt", "skill", "subagent"],
};

/**
 * Why `actor` may not make `edit` in `scope`, or undefined when it may. This is the boundary
 * decision 41 asks for; tests pin it.
 */
export function refuseMemoryEdit(
  actor: MemoryActor,
  scope: MemoryScope,
  edit: MemoryEdit,
  before: HarnessEntry | undefined,
): string | undefined {
  if (actor.kind === "owner") {
    return undefined;
  }
  const owner = scopeAgentId(scope);
  if (actor.kind === "agent" || actor.kind === "dream") {
    if (owner === undefined) {
      return "only the owner and the preference scanner write the company handbook";
    }
    if (actor.id !== owner) {
      return "an agent can only change its own memory";
    }
  }
  if (edit.kind !== undefined && !ACTOR_KINDS[actor.kind].includes(edit.kind)) {
    return `${actor.kind} cannot write ${edit.kind} entries`;
  }
  if (isLocked(before)) {
    return "the owner wrote or edited this entry, so only the owner can change it";
  }
  return undefined;
}

function checkSizes(edit: MemoryEdit): string | undefined {
  if (edit.title !== undefined && edit.title.length > MAX_TITLE_CHARS) {
    return `title is longer than ${MAX_TITLE_CHARS} characters`;
  }
  if (edit.content !== undefined && edit.content.length > MAX_CONTENT_CHARS) {
    return `content is longer than ${MAX_CONTENT_CHARS} characters`;
  }
  return undefined;
}

function sameEntry(left: HarnessEntry | undefined, right: HarnessEntry | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  const { scope: _l, ...a } = left;
  const { scope: _r, ...b } = right;
  return JSON.stringify(a) === JSON.stringify(b);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function createCompanyMemory(options: CompanyMemoryOptions): CompanyMemory {
  const { kv } = options;
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const locks = new Map<MemoryScope, Promise<unknown>>();
  let changeSequence = 0;

  const serialize = <T>(scope: MemoryScope, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(scope) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    locks.set(scope, settled);
    void settled.then(() => {
      if (locks.get(scope) === settled) {
        locks.delete(scope);
      }
    });
    return next;
  };

  const stateKey = (scope: MemoryScope) => ({
    namespace: MEMORY_NAMESPACE,
    collection: STATE_COLLECTION,
    id: scope,
  });
  const changeKey = (id: string) => ({
    namespace: MEMORY_NAMESPACE,
    collection: CHANGE_COLLECTION,
    id,
  });

  async function loadRaw(scope: MemoryScope): Promise<HarnessState | undefined> {
    const record = await kv.get<HarnessState>(stateKey(scope));
    if (record === undefined) {
      return undefined;
    }
    const state = emptyHarnessState();
    for (const kind of REFINEMENT_KINDS) {
      state.entries[kind] = { ...(record.value.entries?.[kind] ?? {}) };
    }
    return state;
  }

  async function save(scope: MemoryScope, state: HarnessState): Promise<void> {
    await kv.set({
      key: stateKey(scope),
      value: { schema: state.schema, entries: state.entries, refinements: [] },
      updatedAt: now().toISOString(),
    });
  }

  function newChangeId(): string {
    changeSequence += 1;
    const stamp = now().toISOString().replace(/\D/g, "").slice(0, 17);
    return `mem_${stamp}_${String(changeSequence).padStart(4, "0")}_${createId().slice(0, 8)}`;
  }

  async function recordChange(change: MemoryChange): Promise<void> {
    await kv.set({ key: changeKey(change.id), value: change, updatedAt: change.createdAt });
  }

  /** Applies edits under the scope's lock; the caller holds it. */
  async function applyLocked(
    input: ApplyMemoryInput & {
      readonly undoOf?: string;
      /** Undo restores entries exactly as they were, metadata and all. */
      readonly restoring?: boolean;
    },
  ): Promise<ApplyMemoryResult> {
    const state = (await loadState(input.scope)) ?? emptyHarnessState();
    const at = input.origin?.at ?? now().toISOString();
    const origin: MemoryOrigin = {
      kind: input.origin?.kind ?? (input.actor.kind === "scanner" ? "chat" : input.actor.kind),
      ...(input.origin?.ref === undefined ? {} : { ref: input.origin.ref }),
      ...(input.origin?.note === undefined ? {} : { note: input.origin.note }),
      at,
    };
    const refused: AppliedRefinementEdit[] = [];
    const allowed: MemoryEdit[] = [];
    for (const edit of input.edits) {
      const id = edit.id;
      const before =
        id === undefined || edit.kind === undefined ? undefined : state.entries[edit.kind][id];
      const reason = checkSizes(edit) ?? refuseMemoryEdit(input.actor, input.scope, edit, before);
      if (reason !== undefined) {
        refused.push({
          action: edit.action ?? "create",
          kind: edit.kind ?? "memory",
          id: id ?? "",
          ...(edit.title === undefined ? {} : { title: edit.title }),
          ...(before === undefined ? {} : { before }),
          applied: false,
          error: reason,
        });
        continue;
      }
      if (input.restoring === true || edit.action === "delete") {
        allowed.push(edit);
        continue;
      }
      const {
        origin: _ignored,
        locked: _locked,
        ...metadata
      } = {
        ...(before?.metadata ?? {}),
        ...(edit.metadata ?? {}),
      } as Record<string, unknown>;
      allowed.push({
        ...edit,
        ...(edit.action === "update" && before !== undefined
          ? { title: edit.title ?? before.title, content: edit.content ?? before.content }
          : {}),
        metadata: {
          ...metadata,
          origin,
          ...(input.actor.kind === "owner" ? { locked: true } : {}),
        },
      });
    }
    const id = newChangeId();
    const result = applyRefinementProposal(
      state,
      {
        summary: input.summary ?? "Memory change",
        rationale: input.rationale ?? "",
        expectedOutcome: "",
        edits: allowed,
      },
      { id, scope: "local", now: () => at },
    );
    const applied = result.appliedEdits.map((edit) => {
      if (!edit.applied || edit.after === undefined) {
        return edit;
      }
      const after = { ...edit.after, source: input.actor.kind } as HarnessEntry;
      delete (after as { scope?: unknown }).scope;
      state.entries[edit.kind][edit.id] = after;
      return { ...edit, after };
    });
    const edits = [...applied, ...refused];
    if (!applied.some((edit) => edit.applied)) {
      return { edits };
    }
    await save(input.scope, state);
    const change: MemoryChange = {
      id,
      scope: input.scope,
      actor: input.actor,
      origin,
      summary: input.summary ?? summarize(edits),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      createdAt: at,
      edits,
      ...(input.undoOf === undefined ? {} : { undoOf: input.undoOf }),
    };
    await recordChange(change);
    return { change, edits };
  }

  /** The scope's state, importing an agent's old notes file the first time. */
  async function loadState(scope: MemoryScope): Promise<HarnessState | undefined> {
    const state = await loadRaw(scope);
    if (state !== undefined) {
      return state;
    }
    const agentId = scopeAgentId(scope);
    if (agentId === undefined || options.legacyNotes === undefined) {
      return undefined;
    }
    const notes = await options.legacyNotes(agentId).catch(() => "");
    const body = notes
      .split("\n")
      .filter((line) => !line.startsWith("# "))
      .join("\n")
      .replace(LEGACY_PREAMBLE, "")
      .replace(/Keep it short and current:\s*\nwhat you are responsible for.*learned\.\s*/s, "")
      .trim();
    const fresh = emptyHarnessState();
    await save(scope, fresh);
    if (body.length === 0) {
      return fresh;
    }
    const at = now().toISOString();
    const entry: HarnessEntry = {
      id: "notes_before_memory",
      kind: "memory",
      title: "Notes from before the memory system",
      content: clip(body, MAX_CONTENT_CHARS),
      path: "general",
      reference: {},
      arguments: {},
      metadata: { origin: { kind: "import", ref: "context.md", at } satisfies MemoryOrigin },
      source: "import",
      created_at: at,
      updated_at: at,
      version: 1,
    };
    fresh.entries.memory[entry.id] = entry;
    await save(scope, fresh);
    await recordChange({
      id: newChangeId(),
      scope,
      actor: { kind: "import" },
      origin: { kind: "import", ref: "context.md", at },
      summary: "Imported the agent's old notes file",
      createdAt: at,
      edits: [{ action: "create", kind: "memory", id: entry.id, after: entry, applied: true }],
    });
    return fresh;
  }

  async function read(scope: MemoryScope): Promise<HarnessState> {
    return (await loadState(scope)) ?? emptyHarnessState();
  }

  async function list(scope: MemoryScope): Promise<readonly MemoryEntryView[]> {
    return rankHarnessEntries(entriesOf(await read(scope))).map(viewEntry);
  }

  async function changes(
    filter: { readonly scope?: MemoryScope; readonly limit?: number } = {},
  ): Promise<readonly MemoryChange[]> {
    const records = await kv.list({ namespace: MEMORY_NAMESPACE, collection: CHANGE_COLLECTION });
    return records
      .map((record) => record.value as MemoryChange)
      .filter((change) => filter.scope === undefined || change.scope === filter.scope)
      .sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
      .slice(0, filter.limit ?? 100);
  }

  async function getChange(id: string): Promise<MemoryChange | undefined> {
    return (await kv.get<MemoryChange>(changeKey(id)))?.value;
  }

  return {
    read,
    list,

    async scopes() {
      const records = await kv.list({ namespace: MEMORY_NAMESPACE, collection: STATE_COLLECTION });
      return records
        .map((record) => {
          const state = record.value as HarnessState;
          const entries = REFINEMENT_KINDS.reduce(
            (total, kind) => total + Object.keys(state.entries?.[kind] ?? {}).length,
            0,
          );
          return { scope: record.key.id as MemoryScope, entries };
        })
        .sort((left, right) => left.scope.localeCompare(right.scope));
    },

    apply: (input) => serialize(input.scope, () => applyLocked(input)),

    changes,
    getChange,

    async undo(changeId, actor) {
      if (actor.kind !== "owner") {
        throw new MemoryError(403, "Only the owner can undo a memory change.");
      }
      const target = await getChange(changeId);
      if (target === undefined) {
        throw new MemoryError(404, `Memory change ${changeId} was not found.`);
      }
      if (target.undoneBy !== undefined) {
        throw new MemoryError(409, `Memory change ${changeId} was already undone.`);
      }
      return serialize(target.scope, async () => {
        const state = await read(target.scope);
        const conflicts: AppliedRefinementEdit[] = [];
        const current = target.edits.filter((edit) => {
          if (!edit.applied) {
            return false;
          }
          const now = state.entries[edit.kind][edit.id];
          if (sameEntry(now, edit.after)) {
            return true;
          }
          conflicts.push({
            ...edit,
            applied: false,
            error: "the entry changed after this change; edit it by hand",
          });
          return false;
        });
        const proposal = rollbackProposal({
          id: target.id,
          summary: target.summary,
          rationale: "",
          expectedOutcome: "",
          appliedEdits: current,
          harnessStatePath: "",
        });
        const result = await applyLocked({
          scope: target.scope,
          actor,
          edits: proposal.edits,
          origin: { kind: "undo", ref: target.id },
          summary: `Undid: ${target.summary}`,
          undoOf: target.id,
          restoring: true,
        });
        if (result.change !== undefined) {
          await recordChange({ ...target, undoneBy: result.change.id });
        }
        return { ...result, edits: [...result.edits, ...conflicts] };
      });
    },

    async promptSection(agentId, promptOptions = {}) {
      const [handbook, own] = await Promise.all([read(COMPANY_SCOPE), read(agentScope(agentId))]);
      const lines: string[] = [];
      const handbookEntries = rankHarnessEntries(entriesOf(handbook));
      lines.push(
        "## Company handbook",
        "What everyone at the company knows about the owner and how the company works. The owner keeps it; follow it.",
      );
      if (handbookEntries.length === 0) {
        lines.push("", "(Nothing in the handbook yet.)");
      } else {
        let used = 0;
        const max = promptOptions.maxHandbookChars ?? 8_000;
        for (const entry of handbookEntries) {
          const line = `- ${entry.title}: ${entry.content.replace(/\s+/g, " ").trim()}`;
          if (used + line.length > max) {
            lines.push(`- (${handbookEntries.length} entries in all; search with \`recall\`.)`);
            break;
          }
          used += line.length;
          lines.push(line);
        }
      }

      lines.push(
        "",
        "## Your memory",
        "What you have learned doing your job, kept between tasks. Save a lesson, decision or fact worth keeping with `remember`; correct one by calling `remember` with its id, drop a wrong one with `forget`, and search with `recall`. Keep entries short and specific.",
      );
      const notes = Object.values(own.entries.prompt);
      for (const note of rankHarnessEntries(notes)) {
        lines.push(`- Rule for yourself, ${note.title}: ${note.content.replace(/\s+/g, " ")}`);
      }
      const memories = Object.values(own.entries.memory);
      const terms = harnessQueryTermsFromText(promptOptions.query ?? "");
      const ranked = rankHarnessEntries(memories, terms);
      const maxMemories = promptOptions.maxMemories ?? 25;
      for (const entry of ranked.slice(0, maxMemories)) {
        lines.push(
          `- [${entry.id}] ${entry.title}: ${clip(entry.content.replace(/\s+/g, " "), 600)}`,
        );
      }
      if (ranked.length > maxMemories) {
        lines.push(`- (${ranked.length - maxMemories} more; search with \`recall\`.)`);
      }
      if (notes.length === 0 && memories.length === 0) {
        lines.push("", "(Nothing yet.)");
      }
      const skills = Object.values(own.entries.skill);
      if (skills.length > 0) {
        lines.push("", "Procedures you saved:");
        for (const skill of rankHarnessEntries(skills, terms)) {
          const command =
            typeof skill.reference["command"] === "string"
              ? ` Run: \`${skill.reference["command"]}\``
              : typeof skill.reference["name"] === "string"
                ? ` Skill: ${skill.reference["name"]}`
                : "";
          lines.push(
            `- ${skill.title}: ${clip(skill.content.replace(/\s+/g, " "), 300)}${command}`,
          );
        }
      }
      return lines.join("\n");
    },

    async search(agentId, query, limit = 10) {
      const terms = harnessQueryTermsFromText(query);
      const scopes: MemoryScope[] = [COMPANY_SCOPE, agentScope(agentId)];
      const found: (MemoryEntryView & { scope: MemoryScope })[] = [];
      for (const scope of scopes) {
        const entries = entriesOf(await read(scope));
        for (const entry of rankHarnessEntries(entries, terms)) {
          found.push({ ...viewEntry(entry), scope });
        }
      }
      const needle = query.toLowerCase();
      const score = (entry: MemoryEntryView) => {
        const text = `${entry.title}\n${entry.content}`.toLowerCase();
        let total = text.includes(needle) ? 10 : 0;
        for (const term of terms.keys()) {
          if (text.includes(term)) {
            total += 1;
          }
        }
        return total;
      };
      return found
        .map((entry) => ({ entry, score: score(entry) }))
        .filter((item) => item.score > 0 || terms.size === 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((item) => item.entry);
    },
  };
}

function summarize(edits: readonly AppliedRefinementEdit[]): string {
  const applied = edits.filter((edit) => edit.applied);
  if (applied.length === 1) {
    const edit = applied[0] as AppliedRefinementEdit;
    const title = edit.after?.title ?? edit.before?.title ?? edit.id;
    return `${edit.action === "create" ? "Added" : edit.action === "update" ? "Changed" : "Removed"} "${title}"`;
  }
  return `Changed ${applied.length} memories`;
}
