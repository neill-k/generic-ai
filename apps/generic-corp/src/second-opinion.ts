import { type AssistantMessage, complete, type Model, resolveModel } from "@generic-ai/ai";
import type {
  AgentTaskImpossibilityReview,
  ImpossibilityReviewer,
  ImpossibilityReviewInput,
} from "@generic-ai/plugin-delegation";
import { describeGoalForAgent } from "@generic-ai/sdk";

import { type CompanyConfig, DEFAULT_TIER_MODELS, modelFor } from "./company.js";

/**
 * Second opinions run on a different model from the agent whose work they judge (decisions 10 and
 * 12): the rubric judge grading a hand-in, and the reviewer of an impossibility claim. A model
 * grading its own output shares its blind spots.
 *
 * Candidates, in order: the company's `judge` models, then each tier's model, then the defaults.
 * The first one that is not the worker's model wins. Only when every candidate is the worker's
 * model (a one-model company) does the worker's model judge itself.
 */
export function secondOpinionModel(
  company: CompanyConfig,
  workerModel: string | undefined,
): string {
  const candidates = [
    ...(company.judgeModels ?? []),
    company.models?.vp,
    company.models?.ceo,
    company.models?.ic,
    DEFAULT_TIER_MODELS.vp,
    DEFAULT_TIER_MODELS.ceo,
  ].filter((model): model is string => model !== undefined && model.length > 0);
  return (
    candidates.find((model) => model !== workerModel) ?? candidates[0] ?? DEFAULT_TIER_MODELS.vp
  );
}

/** The model an agent actually runs on: its record's, else the company's for its seat. */
export function workerModelOf(
  company: CompanyConfig,
  agent: { readonly id: string; readonly model?: string },
): string {
  return agent.model ?? modelFor(company, agent.id);
}

export interface ModelImpossibilityReviewerOptions {
  /**
   * The model call. Defaults to `complete` from `@generic-ai/ai`; the server passes one that runs
   * Claude calls on the owner's plan through the Claude Agent SDK when that is on.
   */
  readonly complete?: typeof complete;
  /** The reviewer's model for a claim by this agent. */
  readonly modelFor: (agent: ImpossibilityReviewInput["agent"]) => string;
  readonly resolveModel?: (ref: string) => Model;
  readonly onUsage?: (usage: AssistantMessage["usage"], input: ImpossibilityReviewInput) => void;
  /** Request auth per provider (the owner's saved API key or the environment). */
  readonly getAuth?: (
    provider: string,
  ) => Promise<
    { readonly apiKey?: string; readonly headers?: Readonly<Record<string, string>> } | undefined
  >;
}

const REVIEW_SYSTEM_PROMPT = [
  "You review claims that a task is impossible. Be skeptical: agents give up too early.",
  "A task is impossible only when it cannot be done even in principle by anyone with unlimited",
  "time and effort: it contradicts physics, logic or mathematics already proven, or asks for",
  "something that does not exist and cannot be made. Hard, slow, expensive, unfamiliar, blocked",
  "by a missing tool or credential, or an open research problem is NOT impossible. For example,",
  "teleporting the earth to the sun is impossible; proving P != NP is not known to be.",
  'Reply with JSON only: {"impossible": true | false, "reasoning": "<two to five sentences>"}.',
].join(" ");

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

/**
 * Reviews `declare_impossible` claims with a model other than the claimant's. It sees the task,
 * the goal and the claim, never the agent's conversation. A malformed reply is an error, which
 * the cascade treats as "not confirmed": the agent keeps working.
 */
export function createModelImpossibilityReviewer(
  options: ModelImpossibilityReviewerOptions,
): ImpossibilityReviewer {
  const resolve = options.resolveModel ?? ((ref: string) => resolveModel(ref));
  return async (input): Promise<AgentTaskImpossibilityReview> => {
    const modelRef = options.modelFor(input.agent);
    const prompt = [
      "## Task",
      input.task.instruction,
      ...(input.goal === undefined ? [] : ["", "## Goal", describeGoalForAgent(input.goal)]),
      "",
      `## The claim (by ${input.agent.title ?? input.agent.role})`,
      input.reason,
      "",
      "Is the task impossible in principle? Reply with the JSON only.",
    ].join("\n");
    const model = resolve(modelRef);
    const auth = await options.getAuth?.(model.provider);
    const reply = await (options.complete ?? complete)(
      model,
      {
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      {
        signal: input.signal,
        ...(auth?.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
        ...(auth?.headers === undefined ? {} : { headers: { ...auth.headers } }),
      },
    );
    options.onUsage?.(reply.usage, input);
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(`The impossibility review failed: ${reply.errorMessage ?? reply.stopReason}`);
    }
    let parsed: unknown;
    try {
      parsed = jsonIn(textOf(reply));
    } catch {
      throw new Error("The impossibility reviewer did not reply with JSON.");
    }
    const record = parsed as { impossible?: unknown; reasoning?: unknown } | null;
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.impossible !== "boolean" ||
      typeof record.reasoning !== "string" ||
      record.reasoning.trim().length === 0
    ) {
      throw new Error(
        'The impossibility reviewer must reply {"impossible": boolean, "reasoning": string}.',
      );
    }
    return {
      impossible: record.impossible,
      reasoning: record.reasoning.trim(),
      reviewer: modelRef,
    };
  };
}
