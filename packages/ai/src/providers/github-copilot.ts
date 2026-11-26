import type { Api, Context, Message } from "../types.js";

/**
 * GitHub Copilot as a model provider (`github-copilot`). Adapted from pi's `github-copilot.ts`,
 * `github-copilot-headers.ts` and its Copilot catalog rules (badlogic/pi-mono, MIT).
 *
 * Copilot serves Claude 4.x and 5.x on the Messages API, GPT, Grok, OSWE and MAI models only on
 * `/responses`, and everything else on Chat Completions. Requests authenticate with the short-lived
 * Copilot token from `githubCopilotOAuth` in `@generic-ai/auth`, whose `toAuth` also supplies the
 * account's base URL and the editor headers Copilot expects.
 */

export const GITHUB_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";

/** The wire API Copilot serves a model on. */
export function githubCopilotApi(modelId: string): Api {
  if (/^claude-(haiku|sonnet|opus|fable)-[45]([.-]|$)/.test(modelId)) return "anthropic-messages";
  if (/^(gpt-|grok-|oswe|mai-)/.test(modelId)) return "openai-responses";
  return "openai-completions";
}

/** Copilot wants to know who started a request: the user, or the agent following up on tools. */
export function inferCopilotInitiator(messages: readonly Message[]): "user" | "agent" {
  const last = messages[messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}

/** Copilot requires `Copilot-Vision-Request` on requests that carry images. */
export function hasCopilotVisionInput(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      (message.role === "user" || message.role === "toolResult") &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "image"),
  );
}

/** Per-request headers Copilot expects, derived from the conversation. */
export function githubCopilotRequestHeaders(
  context: Pick<Context, "messages">,
): Record<string, string> {
  return {
    "X-Initiator": inferCopilotInitiator(context.messages),
    "Openai-Intent": "conversation-edits",
    ...(hasCopilotVisionInput(context.messages) ? { "Copilot-Vision-Request": "true" } : {}),
  };
}
