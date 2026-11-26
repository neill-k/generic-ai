// Refinement planning and the automatic review gate. Adapted from Prime Agent's
// `crates/pa-core/src/refinement/executor.rs` and `session_engine/refine.rs`
// (PrimeIntellect-ai/prime-agent).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { type AssistantMessage, complete, type Model } from "@generic-ai/ai";

import {
  applyRefinementProposal,
  extractJsonObject,
  fitRefinementRequest,
  parseProposal,
  REFINEMENT_MAX_OUTPUT_TOKENS,
  REFINEMENT_SYSTEM_PROMPT,
  type RefinementProposal,
  rollbackProposal,
} from "./planner.js";
import {
  type HarnessScope,
  type HarnessState,
  inferRefinementResultScope,
  REFINEMENT_KINDS,
  type RefinementResult,
} from "./state.js";

export const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are the automatic /refine review gate of a Generic AI agent.

Decide whether this checkpoint should run /refine. Auto /refine writes local continual harness state by default, so approve when the trajectory contains evidence useful to this session's future turns.
Reject one-off noise, unsupported hypotheses, and transient tool outputs. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions for /refine if shouldRefine is true"
}`;

export const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4096;
export const REFINEMENT_CONVERSATION_LIMIT = 80_000;
export const AUTO_REFINE_REVIEW_CONVERSATION_LIMIT = 40_000;

const AUTO_REFINE_GUIDANCE =
  "Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested.";

export interface RefineOptions {
  /** Write to the global store instead of the session's local one. */
  readonly global?: boolean;
  readonly instructions?: string;
  /** Undo an earlier refinement instead of asking the model. */
  readonly rollbackId?: string;
}

/**
 * One model call: the model with its output budget already clamped, the system prompt and the user
 * prompt. The default calls `complete` from `@generic-ai/ai`.
 */
export type RefinerCall = (
  model: Model,
  systemPrompt: string,
  userPrompt: string,
) => Promise<AssistantMessage>;

export function createRefinerCall(
  options: { readonly apiKey?: string; readonly signal?: AbortSignal } = {},
): RefinerCall {
  return (model, systemPrompt, userPrompt) =>
    complete(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      },
      {
        maxTokens: model.maxTokens,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
}

export interface RefinementPlan {
  readonly proposal: RefinementProposal;
  readonly id: string;
  readonly rollbackOf?: string;
  readonly rollbackScope?: HarnessScope;
}

/** A refinement id, `refine_` and the first 17 digits of the ISO time (to the millisecond). */
export function generateRefinementId(now: Date = new Date()): string {
  return `refine_${now.toISOString().replace(/\D/g, "").slice(0, 17)}`;
}

function snippet(text: string): string {
  return [...text.split(/\s+/).filter(Boolean).join(" ")].slice(0, 240).join("");
}

/** The harness overview the planner sees: up to 40 entries per kind with 240-character snippets. */
export function overviewForPrompt(state: HarnessState): string {
  const lines: string[] = [];
  for (const kind of REFINEMENT_KINDS) {
    const entries = Object.values(state.entries[kind]);
    lines.push(`${kind}: ${entries.length}`);
    for (const entry of entries.slice(0, 40)) {
      const reference =
        kind === "skill" && Object.keys(entry.reference).length > 0
          ? ` ref=${JSON.stringify(entry.reference).slice(0, 240)}`
          : "";
      const args =
        kind === "skill" && Object.keys(entry.arguments).length > 0
          ? ` args=${JSON.stringify(entry.arguments).slice(0, 240)}`
          : "";
      lines.push(
        `- [${entry.scope === "local" ? "local" : "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${reference}${args}: ${snippet(entry.content)}`,
      );
    }
    if (entries.length > 40) {
      lines.push(`- +${entries.length - 40} more ${kind} entries`);
    }
  }
  return lines.join("\n");
}

/** The last 20 refinements, for the planner. */
export function historyForPrompt(history: readonly RefinementResult[]): string {
  if (history.length === 0) {
    return "No prior refinement history.";
  }
  return history
    .slice(-20)
    .map((item) => {
      const edits = item.appliedEdits
        .map(
          (edit) => `${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}`,
        )
        .join(", ");
      const rollback = item.rollbackOf === undefined ? "" : ` rollbackOf=${item.rollbackOf}`;
      return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
    })
    .join("\n\n");
}

function tail(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : chars.slice(chars.length - limit).join("");
}

/** The reply's text. A reply cut off at its output limit or failed by the provider is an error. */
export function replyText(reply: AssistantMessage, maxTokens: number, failure: string): string {
  if (reply.stopReason === "length") {
    throw new Error(
      `${failure}: the model hit its output limit (${maxTokens} tokens, ${reply.provider}/${reply.model})`,
    );
  }
  if (reply.stopReason === "error") {
    throw new Error(`${failure}: ${reply.errorMessage ?? "Unknown error"}`);
  }
  return reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export interface PlanRefinementInput {
  /** The conversation, serialized; only its last 80,000 characters are sent. */
  readonly conversationText: string;
  /** The merged state the agent saw. */
  readonly state: HarnessState;
  readonly history: readonly RefinementResult[];
  readonly model: Model;
  readonly options?: RefineOptions;
  readonly call?: RefinerCall;
  readonly now?: Date;
}

/**
 * Produces a refinement plan (a rollback, or a model pass) without changing any state. Callers
 * reload the target store before applying, because the model call can take a while.
 */
export async function planRefinement(input: PlanRefinementInput): Promise<RefinementPlan> {
  const options = input.options ?? {};
  const id = generateRefinementId(input.now);
  if (options.rollbackId !== undefined) {
    const target = input.history.find((item) => item.id === options.rollbackId);
    if (target === undefined) {
      throw new Error(`Refinement ${options.rollbackId} not found`);
    }
    return {
      proposal: rollbackProposal(target),
      id,
      rollbackOf: target.id,
      rollbackScope:
        inferRefinementResultScope(target) ?? (options.global === true ? "global" : "local"),
    };
  }
  const scopeInstruction =
    options.global === true
      ? "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally."
      : "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed.";
  const overview = overviewForPrompt(input.state);
  const history = historyForPrompt(input.history);
  const buildPrompt = (conversation: string) =>
    [
      `<current_harness_state>\n${overview}\n</current_harness_state>`,
      `<refinement_history>\n${history}\n</refinement_history>`,
      `<conversation>\n${conversation}\n</conversation>`,
      `<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
      ...(options.instructions === undefined
        ? []
        : [`<user_refine_instructions>\n${options.instructions}\n</user_refine_instructions>`]),
      "Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
    ].join("\n\n");
  const fitted = fitRefinementRequest(
    input.model,
    REFINEMENT_SYSTEM_PROMPT,
    tail(input.conversationText, REFINEMENT_CONVERSATION_LIMIT),
    buildPrompt,
    REFINEMENT_MAX_OUTPUT_TOKENS,
  );
  const maxTokens = Math.min(fitted.maxTokens, REFINEMENT_MAX_OUTPUT_TOKENS);
  const call = input.call ?? createRefinerCall();
  const reply = await call(
    { ...input.model, maxTokens },
    REFINEMENT_SYSTEM_PROMPT,
    fitted.userPrompt,
  );
  return { proposal: parseProposal(replyText(reply, maxTokens, "Refinement failed")), id };
}

/** Applies a plan to the reloaded target store. */
export function applyRefinementPlan(
  state: HarnessState,
  plan: RefinementPlan,
  options: RefineOptions = {},
  baselineState?: HarnessState,
): RefinementResult {
  return applyRefinementProposal(state, plan.proposal, {
    id: plan.id,
    ...(plan.rollbackOf === undefined ? {} : { rollbackOf: plan.rollbackOf }),
    scope: plan.rollbackScope ?? (options.global === true ? "global" : "local"),
    ...(baselineState === undefined ? {} : { baselineState }),
  });
}

export interface AutoRefineReview {
  readonly shouldRefine: boolean;
  readonly rationale: string;
  readonly instructions?: string;
}

export function parseAutoRefineReview(text: string): AutoRefineReview {
  const value = extractJsonObject(text);
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    shouldRefine: record["shouldRefine"] === true,
    rationale:
      typeof record["rationale"] === "string" ? record["rationale"] : "No rationale provided.",
    ...(typeof record["instructions"] === "string" ? { instructions: record["instructions"] } : {}),
  };
}

export interface ReviewAutoRefineInput {
  readonly conversationText: string;
  readonly state: HarnessState;
  readonly history: readonly RefinementResult[];
  readonly model: Model;
  /** What triggered the review, for example `compact` or `turn interval`. */
  readonly reason: string;
  readonly turnsSinceLastReview: number;
  readonly call?: RefinerCall;
}

/** The automatic review gate: asks the model whether this checkpoint is worth a refinement. */
export async function reviewAutoRefine(input: ReviewAutoRefineInput): Promise<AutoRefineReview> {
  const overview = overviewForPrompt(input.state);
  const history = historyForPrompt(input.history);
  const buildPrompt = (conversation: string) =>
    [
      `<trigger>\n${input.reason}; ${input.turnsSinceLastReview} assistant turns since last auto-refine review\n</trigger>`,
      `<current_harness_state>\n${overview}\n</current_harness_state>`,
      `<refinement_history>\n${history}\n</refinement_history>`,
      `<conversation>\n${conversation}\n</conversation>`,
      "Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local harness edits for current task progress, temporary blockers, and current-run coordination. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.",
    ].join("\n\n");
  const fitted = fitRefinementRequest(
    input.model,
    AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
    tail(input.conversationText, AUTO_REFINE_REVIEW_CONVERSATION_LIMIT),
    buildPrompt,
    AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS,
  );
  const maxTokens = Math.min(fitted.maxTokens, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS);
  const call = input.call ?? createRefinerCall();
  const reply = await call(
    { ...input.model, maxTokens },
    AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
    fitted.userPrompt,
  );
  return parseAutoRefineReview(replyText(reply, maxTokens, "Auto-refine review failed"));
}

/** Instructions for an automatic round that ran without a review. */
export function unreviewedAutoRefineInstructions(reason: string): string {
  return `Automatic refinement triggered by ${reason}. ${AUTO_REFINE_GUIDANCE}`;
}

/** Instructions an approved review carries into the refinement. */
export function autoRefineInstructions(reason: string, review: AutoRefineReview): string {
  const detail =
    review.instructions === undefined ? "" : `\n\nReviewer instructions: ${review.instructions}`;
  return `Automatic refine review triggered by ${reason}. ${AUTO_REFINE_GUIDANCE} Reviewer rationale: ${review.rationale}${detail}`;
}

export interface AutoRefineGates {
  readonly enabled: boolean;
  /** Review every this many assistant turns. Default 25, at least 1. */
  readonly turnInterval: number;
  /** Review after a compaction. Default true. */
  readonly compact: boolean;
  /** Minimum time between reviews. Default 20 minutes. */
  readonly cooldownMs: number;
}

export function resolveAutoRefineGates(raw: Partial<AutoRefineGates> = {}): AutoRefineGates {
  return {
    enabled: raw.enabled ?? true,
    turnInterval: Math.max(1, raw.turnInterval ?? 25),
    compact: raw.compact ?? true,
    cooldownMs: raw.cooldownMs ?? 20 * 60 * 1000,
  };
}
