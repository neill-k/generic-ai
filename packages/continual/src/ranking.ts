// Harness relevance ranking and prompt rendering. Adapted from Prime Agent's
// `crates/pa-core/src/refinement/ranking.rs` (PrimeIntellect-ai/prime-agent).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import {
  compactText,
  DEFAULT_OVERVIEW_CONTENT_LIMIT,
  DEFAULT_OVERVIEW_ENTRY_LIMIT,
  DEFAULT_OVERVIEW_REFINEMENT_LIMIT,
  type HarnessEntry,
  type HarnessState,
  REFINEMENT_KINDS,
} from "./state.js";

/** Term to weight, built from the task (the prompt, a goal, recent messages). */
export type HarnessQueryTerms = ReadonlyMap<string, number>;

const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xac00, 0xd7af],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2ee5f],
  [0x2f800, 0x2fa1f],
  [0x30000, 0x3347f],
];

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return CJK_RANGES.some(([low, high]) => code >= low && code <= high);
}

function pushSegment(segment: string[], cjk: boolean, terms: string[]): void {
  if (segment.length === 0) {
    return;
  }
  if (cjk) {
    if (segment.length === 1) {
      terms.push(segment[0] as string);
    } else {
      for (let index = 0; index + 1 < segment.length; index += 1) {
        terms.push(`${segment[index]}${segment[index + 1]}`);
      }
    }
  } else if (segment.length >= 4) {
    terms.push(segment.join(""));
  }
}

/**
 * Splits text into distinct lowercase query terms: runs of letters and digits of 4 or more
 * characters, and CJK runs as overlapping bigrams. Order of first appearance is kept.
 */
export function harnessQueryTerms(text: string): string[] {
  const terms: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) {
      return;
    }
    let segment: string[] = [];
    let segmentCjk = isCjk(run[0] as string);
    for (const char of run) {
      if (isCjk(char) === segmentCjk) {
        segment.push(char);
      } else {
        pushSegment(segment, segmentCjk, terms);
        segment = [char];
        segmentCjk = !segmentCjk;
      }
    }
    pushSegment(segment, segmentCjk, terms);
    run = [];
  };
  for (const char of text.toLowerCase()) {
    if (/[\p{L}\p{N}\p{M}]/u.test(char)) {
      run.push(char);
    } else {
      flush();
    }
  }
  flush();
  return [...new Set(terms)];
}

/** Query terms with weight 1 each, from free text. */
export function harnessQueryTermsFromText(text: string): Map<string, number> {
  return new Map(harnessQueryTerms(text).map((term) => [term, 1]));
}

function fields(entry: HarnessEntry): readonly [string, string, string] {
  return [
    entry.title.toLowerCase(),
    entry.content.toLowerCase(),
    `${entry.path.toLowerCase()} ${entry.id.toLowerCase()}`,
  ];
}

/**
 * Inverse document frequency of each query term over the ranked entries, `ln(1 + N / df)`. Terms
 * that match no entry are left out.
 */
export function harnessQueryTermIdf(
  entries: readonly HarnessEntry[],
  terms: HarnessQueryTerms,
): Map<string, number> {
  const idf = new Map<string, number>();
  if (terms.size === 0) {
    return idf;
  }
  const matches = new Map<string, number>();
  for (const entry of entries) {
    const texts = fields(entry);
    for (const term of terms.keys()) {
      if (texts.some((text) => text.includes(term))) {
        matches.set(term, (matches.get(term) ?? 0) + 1);
      }
    }
  }
  for (const [term, frequency] of matches) {
    idf.set(term, Math.log(1 + entries.length / frequency));
  }
  return idf;
}

/**
 * Scores an entry against query terms: each matching term adds weight × idf, plus half again for
 * each extra field (title, content, path and id) it appears in.
 */
export function scoreHarnessEntryForQuery(
  entry: HarnessEntry,
  terms: HarnessQueryTerms,
  idf?: ReadonlyMap<string, number>,
): number {
  if (terms.size === 0) {
    return 0;
  }
  const texts = fields(entry);
  let score = 0;
  for (const [term, weight] of terms) {
    const count = texts.filter((text) => text.includes(term)).length;
    if (count > 0) {
      score += weight * (idf?.get(term) ?? 1) * (1 + (count - 1) * 0.5);
    }
  }
  return score;
}

function sortKey(entry: HarnessEntry): string {
  return `${entry.path}\0${entry.title}\0${entry.id}`;
}

function compareKeys(left: HarnessEntry, right: HarnessEntry): number {
  const a = sortKey(left);
  const b = sortKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Entries of one kind, most relevant first when query terms are given, else by path and title. */
export function rankHarnessEntries(
  entries: readonly HarnessEntry[],
  terms?: HarnessQueryTerms,
): HarnessEntry[] {
  const sorted = [...entries];
  if (terms === undefined || terms.size === 0) {
    return sorted.sort(compareKeys);
  }
  const idf = harnessQueryTermIdf(entries, terms);
  const scores = new Map(
    sorted.map((entry) => [entry, scoreHarnessEntryForQuery(entry, terms, idf)]),
  );
  return sorted.sort(
    (left, right) => (scores.get(right) ?? 0) - (scores.get(left) ?? 0) || compareKeys(left, right),
  );
}

export interface HarnessStatePromptOptions {
  readonly maxEntriesPerKind?: number;
  readonly maxRefinements?: number;
  readonly maxContentLength?: number;
  /** Rank entries by relevance to these terms. */
  readonly queryTerms?: HarnessQueryTerms;
  /** Mention the `refine` tool. Default true. */
  readonly includeRefineTool?: boolean;
}

/** Renders the harness state as the block added to the agent's system prompt. */
export function formatHarnessStateForPrompt(
  state: HarnessState,
  options: HarnessStatePromptOptions = {},
): string {
  const maxEntries = options.maxEntriesPerKind ?? DEFAULT_OVERVIEW_ENTRY_LIMIT;
  const maxRefinements = options.maxRefinements ?? DEFAULT_OVERVIEW_REFINEMENT_LIMIT;
  const maxContent = options.maxContentLength ?? DEFAULT_OVERVIEW_CONTENT_LIMIT;
  const refineTool = options.includeRefineTool ?? true;
  const lines: string[] = [
    "# Continual Harness State",
    "",
    "Local continual harness entries belong to this session. Global continual harness entries persist across sessions.",
    "The entries below are compact summaries, not full descriptions. Use them as routing and context hints; read the full entry with `harness_read` only when detail matters.",
    "Default to local refinement for current task progress, temporary blockers, and session coordination. Use global refinement only for stable cross-session lessons, durable user preferences, reusable skills and subagents, or explicitly project-qualified facts.",
    "Use these prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.",
    "",
    `When to ${refineTool ? "call the `refine` tool" : "refine the continual harness"}: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact or preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows an entry is wrong, or an entry should be created, updated, deleted, or rolled back. Keep edits small and evidence-backed.`,
    "",
    "Call contract: a skill entry's `reference` names a shell command (run it with bash) or an installed skill (read its SKILL.md first). Turn a subagent spec into a concise task prompt and start it with `spawn_agent`; collect its answer with `collect_agents`. Do not invent wrappers or named subagent registries.",
    "",
  ];
  const terms = options.queryTerms;
  let total = 0;
  for (const kind of REFINEMENT_KINDS) {
    const entries = rankHarnessEntries(Object.values(state.entries[kind]), terms);
    total += entries.length;
    lines.push(
      kind === "subagent" && entries.length > 0
        ? `${kind}: ${entries.length} (start a spec by turning it into a concise task prompt for \`spawn_agent\`)`
        : `${kind}: ${entries.length}`,
    );
    if (terms !== undefined && terms.size > 0 && entries.length > maxEntries) {
      lines.push("(entries ranked by relevance to the current task)");
    }
    for (const entry of entries.slice(0, maxEntries)) {
      const reference =
        kind === "skill" && Object.keys(entry.reference).length > 0
          ? ` ref=${compactText(JSON.stringify(entry.reference), maxContent)}`
          : "";
      const args =
        kind === "skill" && Object.keys(entry.arguments).length > 0
          ? ` args=${compactText(JSON.stringify(entry.arguments), maxContent)}`
          : "";
      lines.push(
        `- [${entry.scope === "local" ? "local" : "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${reference}${args}: ${compactText(entry.content, maxContent)}`,
      );
    }
    if (entries.length > maxEntries) {
      lines.push(`- +${entries.length - maxEntries} more ${kind} entries`);
    }
    lines.push("");
  }
  if (total === 0) {
    lines.push("No saved harness entries yet.", "");
  }
  lines.push(`recent refinements: ${state.refinements.length}`);
  for (const event of state.refinements.slice(-maxRefinements)) {
    const changes = event.changes.length === 0 ? "no applied edits" : event.changes.join(", ");
    const outcome =
      event.outcome.length === 0 ? "" : `; outcome: ${compactText(event.outcome, maxContent)}`;
    lines.push(`- [${event.id}] ${compactText(event.trigger, maxContent)}: ${changes}${outcome}`);
  }
  if (state.refinements.length > maxRefinements) {
    lines.push(`- +${state.refinements.length - maxRefinements} older refinement events`);
  }
  return lines.join("\n").trim();
}
